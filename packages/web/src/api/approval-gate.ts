// ─── Mode « Approbation manuelle » : VRAIE pause côté serveur ────────────────
//
// [2026-10-04] Avant : le réglage Settings › AI Behavior › « Manual Approval
// Mode » vivait seulement dans le localStorage. Le chat affichait un pop-up
// « Approval Required » à CHAQUE nouvelle ligne d'activité « executing » (le
// pop-up changeait tout seul, plusieurs fois par minute) et Accept/Decline ne
// parlaient jamais au serveur : le build continuait pendant que le pop-up
// attendait. Le pop-up était décoratif.
//
// Ici : une file d'attente d'approbations PAR PROJET. Une tâche serveur qui
// arrive à un point de contrôle appelle `request()` et ATTEND réellement la
// réponse de l'utilisateur (Accept → continue, Decline → l'étape n'est pas
// faite, la raison est transmise). Plusieurs tâches parallèles d'un même projet
// sont servies DANS L'ORDRE : une seule demande est visible à la fois, donc le
// pop-up ne change plus tout seul.
//
// Aucune minuterie : rien n'est approuvé automatiquement. La seule sortie
// d'une attente est une réponse de l'utilisateur, l'arrêt du projet
// (`cancelCompany`, appelé par « Arrêter ») ou la désactivation explicite du
// mode par l'utilisateur (`approveAllForCompanies`).

export type ApprovalAnswer = { approved: true } | { approved: false; reason: string };

export interface PendingApproval {
  id: string;
  companyId: string;
  /** Ce que l'IA s'apprête à faire, lisible par l'utilisateur. */
  decision: string;
  /** design | engineering | ceo | marketing | supply_chain … */
  agentRole: string;
  /** Identifiant stable du point de contrôle (ex. 'build-web', 'logo'). */
  phase: string;
  createdAt: number;
}

export class ApprovalCancelledError extends Error {
  constructor(companyId: string) {
    super(`Approbation annulée : le projet ${companyId} a été arrêté`);
    this.name = 'ApprovalCancelledError';
  }
}

interface Waiter {
  pending: PendingApproval;
  resolve: (a: ApprovalAnswer) => void;
  reject: (e: Error) => void;
}

export interface ApprovalGateDeps {
  /** Le mode d'approbation manuelle est-il actif pour le propriétaire du projet ?
   *  Une erreur de lecture est traitée comme « actif » (on demande plutôt que
   *  d'agir sans permission). */
  isEnabled: (companyId: string) => Promise<boolean>;
  /** Appelé quand une demande est créée (ex. ligne d'activité « en attente »). */
  onRequested?: (p: PendingApproval) => Promise<void> | void;
  /** Appelé quand l'utilisateur a répondu. */
  onResolved?: (p: PendingApproval, answer: ApprovalAnswer) => Promise<void> | void;
  /** Appelé pour chaque attente libérée par l'arrêt du projet (la ligne
   *  « en attente » ne doit pas rester affichée comme si l'IA attendait). */
  onCancelled?: (p: PendingApproval) => Promise<void> | void;
  newId?: () => string;
  log?: (msg: string) => void;
}

export interface ApprovalGate {
  /** Bloque jusqu'à la réponse de l'utilisateur. Si le mode est désactivé :
   *  retourne tout de suite `{ approved: true }`. Rejette avec
   *  `ApprovalCancelledError` si le projet est arrêté pendant l'attente. */
  request: (input: { companyId: string; decision: string; agentRole: string; phase: string }) => Promise<ApprovalAnswer>;
  /** La demande ACTUELLEMENT présentée pour ce projet (la plus ancienne). */
  current: (companyId: string) => PendingApproval | null;
  /** Nombre de demandes en file pour ce projet (affichée + suivantes). */
  queued: (companyId: string) => number;
  /** Répond à une demande précise. `false` si l'id n'est plus en attente. */
  resolve: (companyId: string, approvalId: string, answer: ApprovalAnswer) => Promise<boolean>;
  /** Libère toutes les attentes du projet (arrêt). Retourne le nombre libéré. */
  cancelCompany: (companyId: string) => number;
  /** L'utilisateur a désactivé le mode : ses demandes en attente sont acceptées. */
  approveAllForCompanies: (companyIds: string[]) => Promise<number>;
}

export function createApprovalGate(deps: ApprovalGateDeps, store: Map<string, Waiter[]> = new Map()): ApprovalGate {
  const log = deps.log ?? (() => {});
  const newId = deps.newId ?? (() => (globalThis.crypto?.randomUUID?.() ?? `ap-${Date.now()}-${Math.random().toString(36).slice(2)}`));

  const queueOf = (companyId: string): Waiter[] => {
    let q = store.get(companyId);
    if (!q) { q = []; store.set(companyId, q); }
    return q;
  };
  const drop = (companyId: string, w: Waiter) => {
    const q = store.get(companyId);
    if (!q) return;
    const i = q.indexOf(w);
    if (i >= 0) q.splice(i, 1);
    if (!q.length) store.delete(companyId);
  };

  const gate: ApprovalGate = {
    async request({ companyId, decision, agentRole, phase }) {
      let enabled = true;
      try {
        enabled = await deps.isEnabled(companyId);
      } catch (e: any) {
        log(`[approval] lecture du réglage impossible pour ${companyId} (${String(e?.message || e).slice(0, 120)}) — on demande la permission`);
        enabled = true;
      }
      if (!enabled) return { approved: true };

      const pending: PendingApproval = {
        id: newId(), companyId, decision: decision.trim().slice(0, 400) || phase, agentRole: agentRole || 'ceo', phase, createdAt: Date.now(),
      };
      let waiter!: Waiter;
      const answer = new Promise<ApprovalAnswer>((resolve, reject) => {
        waiter = { pending, resolve, reject };
      });
      queueOf(companyId).push(waiter);
      log(`[approval] ${companyId} en attente « ${phase} » (${pending.id}) — file : ${queueOf(companyId).length}`);
      try { await deps.onRequested?.(pending); } catch (e: any) { log(`[approval] onRequested a échoué : ${String(e?.message || e).slice(0, 120)}`); }
      return answer;
    },

    current(companyId) {
      return store.get(companyId)?.[0]?.pending ?? null;
    },

    queued(companyId) {
      return store.get(companyId)?.length ?? 0;
    },

    async resolve(companyId, approvalId, answer) {
      const w = store.get(companyId)?.find((x) => x.pending.id === approvalId);
      if (!w) return false;
      drop(companyId, w);
      const clean: ApprovalAnswer = answer.approved
        ? { approved: true }
        : { approved: false, reason: (answer.reason || '').trim().slice(0, 1000) };
      log(`[approval] ${companyId} « ${w.pending.phase} » → ${clean.approved ? 'acceptée' : 'refusée'}`);
      try { await deps.onResolved?.(w.pending, clean); } catch (e: any) { log(`[approval] onResolved a échoué : ${String(e?.message || e).slice(0, 120)}`); }
      w.resolve(clean);
      return true;
    },

    cancelCompany(companyId) {
      const q = store.get(companyId);
      if (!q?.length) return 0;
      const all = q.splice(0, q.length);
      store.delete(companyId);
      for (const w of all) {
        Promise.resolve()
          .then(() => deps.onCancelled?.(w.pending))
          .catch((e: any) => log(`[approval] onCancelled a échoué : ${String(e?.message || e).slice(0, 120)}`));
        w.reject(new ApprovalCancelledError(companyId));
      }
      log(`[approval] ${companyId} arrêté — ${all.length} attente(s) libérée(s)`);
      return all.length;
    },

    async approveAllForCompanies(companyIds) {
      let n = 0;
      for (const cid of companyIds) {
        const ids = (store.get(cid) ?? []).map((w) => w.pending.id);
        for (const id of ids) if (await gate.resolve(cid, id, { approved: true })) n++;
      }
      return n;
    },
  };
  return gate;
}
