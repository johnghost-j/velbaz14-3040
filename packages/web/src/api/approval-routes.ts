// ─── Mode « Approbation manuelle » — branchement serveur ─────────────────────
// Voir approval-gate.ts pour la logique (file d'attente, pas de minuterie).
// Ici : réglage persistant par utilisateur (users.ai_approval_mode), lignes
// d'activité visibles dans le chat, mémoire de la raison d'un refus, et routes.
//
//   GET  /me/ai-approval                       → { enabled }
//   PUT  /me/ai-approval { enabled }           → { enabled, released }
//   GET  /companies/:id/approval               → { pending, queued }
//   POST /companies/:id/approval/:approvalId   { approved, reason? }

import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from './database/index';
import * as schema from './database/schema';
import { createApprovalGate, type ApprovalAnswer, type PendingApproval } from './approval-gate';

export { ApprovalCancelledError } from './approval-gate';
export type { ApprovalAnswer, PendingApproval } from './approval-gate';

/** Le mode est-il actif pour le PROPRIÉTAIRE du projet ? */
async function ownerApprovalEnabled(companyId: string): Promise<boolean> {
  const row = await db.select({ on: schema.users.aiApprovalMode })
    .from(schema.companies)
    .innerJoin(schema.users, eq(schema.users.id, schema.companies.userId))
    .where(eq(schema.companies.id, companyId))
    .get();
  return !!row?.on;
}

/** id de la ligne d'activité « en attente » par demande (mise à jour en place
 *  à la réponse : le front voit la même ligne passer de ⏸️ à ✓ / ✗). */
const activityRowOf: Map<string, string> = (globalThis as any).__velbaz_approval_rows ??= new Map<string, string>();

function short(s: string, n = 160) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Singleton partagé entre rechargements du module (comme backgroundJobs) :
// une tâche qui attend garde la même file que les routes.
export const approvalGate = createApprovalGate(
  {
    isEnabled: ownerApprovalEnabled,
    log: (m) => console.log(m),
    onRequested: async (p: PendingApproval) => {
      const id = uuidv4();
      activityRowOf.set(p.id, id);
      await db.insert(schema.agentActivity).values({
        id, companyId: p.companyId, agentRole: p.agentRole, action: 'waiting',
        message: `⏸️ En attente de ta validation — ${short(p.decision)}`,
        metadata: JSON.stringify({ approvalId: p.id, phase: p.phase }),
      }).catch((e) => console.error('[approval] ligne d\'attente non écrite :', String(e).slice(0, 160)));
      // Pastille « l'IA attend ta réponse » dans la sidebar : la pause doit se
      // voir même si l'utilisateur n'a pas ce projet ouvert.
      await db.update(schema.companies).set({ awaitingAnswer: true })
        .where(eq(schema.companies.id, p.companyId)).catch(() => {});
    },
    onResolved: async (p: PendingApproval, a: ApprovalAnswer) => {
      const rowId = activityRowOf.get(p.id);
      activityRowOf.delete(p.id);
      const message = a.approved
        ? `✓ Validé par toi — ${short(p.decision)}`
        : `✗ Refusé par toi — ${short(p.decision)}${a.reason ? ` · « ${short(a.reason, 200)} »` : ''}`;
      if (rowId) {
        await db.update(schema.agentActivity).set({ action: a.approved ? 'completed' : 'error', message })
          .where(eq(schema.agentActivity.id, rowId)).catch(() => {});
      }
      if (!approvalGate.queued(p.companyId)) {
        await db.update(schema.companies).set({ awaitingAnswer: false })
          .where(eq(schema.companies.id, p.companyId)).catch(() => {});
      }
      if (!a.approved) {
        // La raison doit guider la suite : les agents lisent agent_memory.
        await db.insert(schema.agentMemory).values({
          id: uuidv4(), companyId: p.companyId, key: `user_declined_${p.phase}`,
          value: `L'utilisateur a REFUSÉ : ${p.decision.replace(/[.\s]+$/, '')}.${a.reason ? ` Ce qu'il veut à la place : ${a.reason}` : ''}`,
          category: 'user_feedback', importance: 9,
        }).catch(() => {});
      }
    },
    onCancelled: async (p: PendingApproval) => {
      const rowId = activityRowOf.get(p.id);
      activityRowOf.delete(p.id);
      if (rowId) {
        await db.update(schema.agentActivity)
          .set({ action: 'error', message: `⏹️ Arrêté par toi avant validation — ${short(p.decision)}` })
          .where(eq(schema.agentActivity.id, rowId)).catch(() => {});
      }
      // cancelCompany vide toute la file du projet : plus rien n'attend.
      await db.update(schema.companies).set({ awaitingAnswer: false })
        .where(eq(schema.companies.id, p.companyId)).catch(() => {});
    },
  },
  (globalThis as any).__velbaz_approval_queue ??= new Map(),
);

/** Point de contrôle à appeler dans une tâche serveur, juste AVANT une étape.
 *  Retourne la réponse (toujours `approved: true` si le mode est désactivé). */
export function requireApproval(companyId: string, phase: string, agentRole: string, decision: string) {
  return approvalGate.request({ companyId, phase, agentRole, decision });
}

export function registerApprovalRoutes(
  app: Hono<any>,
  deps: {
    getUser: (c: any) => Promise<any>;
    accessibleCompany: (companyId: string, user: any) => Promise<any>;
  },
) {
  const { getUser, accessibleCompany } = deps;

  app.get('/me/ai-approval', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ enabled: !!user.aiApprovalMode });
  });

  app.put('/me/ai-approval', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.enabled !== 'boolean') return c.json({ error: '`enabled` (boolean) requis' }, 400);
    await db.update(schema.users).set({ aiApprovalMode: body.enabled }).where(eq(schema.users.id, user.id));
    let released = 0;
    if (!body.enabled) {
      // Désactivation EXPLICITE par l'utilisateur : ses tâches en attente
      // reprennent (il vient de dire « plus besoin de me demander »).
      const mine = await db.select({ id: schema.companies.id }).from(schema.companies)
        .where(eq(schema.companies.userId, user.id)).all();
      released = await approvalGate.approveAllForCompanies(mine.map((r) => r.id));
    }
    return c.json({ enabled: body.enabled, released });
  });

  app.get('/companies/:id/approval', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const company = await accessibleCompany(c.req.param('id'), user);
    if (!company) return c.json({ error: 'Not found' }, 404);
    return c.json({ pending: approvalGate.current(company.id), queued: approvalGate.queued(company.id) });
  });

  app.post('/companies/:id/approval/:approvalId', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const company = await accessibleCompany(c.req.param('id'), user);
    if (!company) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.approved !== 'boolean') return c.json({ error: '`approved` (boolean) requis' }, 400);
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    if (!body.approved && !reason.trim()) return c.json({ error: 'Explique ce que tu veux à la place' }, 400);
    const ok = await approvalGate.resolve(company.id, c.req.param('approvalId'),
      body.approved ? { approved: true } : { approved: false, reason });
    if (!ok) return c.json({ error: 'Cette demande n\'est plus en attente', pending: approvalGate.current(company.id) }, 409);
    return c.json({ ok: true, pending: approvalGate.current(company.id) });
  });
}

