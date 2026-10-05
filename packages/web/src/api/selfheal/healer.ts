// ─── Auto-réparation : diagnostic IA, correctif, notification ───────────────
//
// Chaîne complète d'une réparation :
//
//   erreur → tri → garde-fous → diagnostic IA → correctif proposé
//     → garde-fous (sur le correctif) → instantané → écriture
//     → typecheck + tests + contrôle HTTP → conservé OU annulé
//     → e-mail + journal en base
//
// Rien n'est jamais appliqué sans instantané ni sans les trois vérifications.
// Tout refus des garde-fous part par e-mail pour validation humaine : le
// correctif n'est pas perdu, il attend juste une main.
//
import { generateText } from 'ai';
import { db } from '../database/index';
import * as schema from '../database/schema';
import { and, desc, eq, gte, sql, inArray } from 'drizzle-orm';
import { gateway } from '../agent/gateway';
import { runWithRememberedVelbaz2 } from '../agent/velbaz2-flag';
import { runWithAiContext } from '../ai-usage/context';
import { sendEmailAuto } from '../email-provider';
import { ADMIN_EMAILS } from '../security';
import { slog } from '../observability';
import { triage, type RawError, type TriagedError } from './triage';
import { guardPatch, isSelfHealEnabled, readRateState, criticalFileReason, type PatchEdit } from './guard';
import { applyWithRollback, readContext, type Verification } from './patcher';
import { fetchSentryErrors, isSentryApiConfigured, sentryState } from './sentry';

const FIX_MODEL = process.env.SELFHEAL_MODEL || 'anthropic/claude-sonnet-4.6';
/** Sous ce niveau de confiance, on n'écrit pas : on demande une validation. */
const MIN_CONFIDENCE = 0.7;
/** Une même erreur n'est retentée qu'après ce délai, même si elle se répète. */
const RETRY_COOLDOWN_MS = 24 * 3600_000;

export type AttemptStatus =
  | 'applied' | 'rolled_back' | 'blocked_critical' | 'rate_limited'
  | 'circuit_open' | 'no_fix' | 'failed' | 'awaiting_approval';

export interface HealResult {
  attemptId: string | null;
  status: AttemptStatus | 'skipped';
  reason: string;
  targetFile?: string;
  diagnosis?: string;
}

// ── Diagnostic IA ───────────────────────────────────────────────────────────

interface Proposal {
  cause: string;
  fixable: boolean;
  confidence: number;
  edits: PatchEdit[];
  explanation: string;
}

const SYSTEM = `Tu es un ingénieur TypeScript senior chargé de corriger un bug de production dans Velbaz (monorepo Bun + Hono + Drizzle + React).

Tu reçois une erreur réelle, sa pile d'appel, et un extrait du fichier fautif.
Tu produis le correctif MINIMAL qui supprime la cause. Pas de refactor, pas
d'amélioration de style, pas de fonctionnalité ajoutée.

RÈGLES ABSOLUES :
1. Réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balise de code.
2. Le champ "old" de chaque édition doit être le texte source EXACT, copié
   caractère pour caractère depuis l'extrait — SANS le préfixe "  123| " qui
   n'existe que dans l'extrait pour t'orienter. Indentation d'origine comprise.
3. "old" doit apparaître UNE SEULE FOIS dans le fichier. S'il est trop court
   pour être unique, allonge-le avec les lignes voisines.
4. Trois éditions maximum, et chaque "new" fait moins de 4000 caractères.
5. Ne touche JAMAIS à l'authentification, aux paiements, aux secrets, au schéma
   de base, à la cryptographie, ni aux fichiers de test. Si le correctif l'exige,
   réponds "fixable": false.
6. Si la cause n'est pas identifiable avec certitude depuis l'extrait fourni,
   réponds "fixable": false plutôt que de deviner. Un mauvais correctif coûte
   plus cher qu'un bug connu.
7. "confidence" est ta probabilité réelle que le correctif résolve le bug sans
   régression : 0.9+ seulement si la cause est évidente et localisée.

Format exact :
{"cause":"...","fixable":true,"confidence":0.85,"edits":[{"file":"packages/web/src/api/x.ts","old":"...","new":"..."}],"explanation":"..."}`;

function extractJson(text: string): any | null {
  // L'IA ajoute parfois une clôture markdown malgré la consigne.
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* on tente l'extraction */ }
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  // Recherche de l'accolade fermante correspondante, en ignorant les chaînes.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

async function diagnose(err: TriagedError): Promise<Proposal | { error: string }> {
  // Contexte : le fichier fautif autour de la ligne, plus les autres fichiers
  // du dépôt présents dans la pile (la cause est souvent chez l'appelant).
  const parts: string[] = [];
  try {
    parts.push(`### ${err.targetFile} (autour de la ligne ${err.targetLine ?? '?'})\n${await readContext(err.targetFile, err.targetLine)}`);
  } catch (e: any) {
    return { error: `extrait illisible : ${e?.message || e}` };
  }
  for (const f of err.frames.slice(0, 3)) {
    if (f.file === err.targetFile) continue;
    if (criticalFileReason(f.file)) continue;
    try {
      parts.push(`### ${f.file} (autour de la ligne ${f.line}, appelant)\n${await readContext(f.file, f.line, 25)}`);
    } catch { /* fichier absent : on continue sans */ }
  }

  const prompt = `ERREUR :
${err.message}

PILE D'APPEL :
${err.stack || '(la pile est incluse dans le message ci-dessus)'}

FICHIER À CORRIGER : ${err.targetFile}

EXTRAITS DU CODE (le préfixe "123| " est un repère de ligne, il ne fait PAS partie du code) :

${parts.join('\n\n')}`;

  try {
    // Job de fond (hors requête) : sans scope de mode, il n'était jamais
    // substitué et restait sur claude-sonnet-4.6 même en Velbaz 2.0.
    const { text } = await runWithRememberedVelbaz2(() => runWithAiContext(
      { feature: 'selfheal-diagnose' },
      () => generateText({ model: gateway(FIX_MODEL), system: SYSTEM, prompt, temperature: 0.1 }),
    ));
    const obj = extractJson(text);
    if (!obj) return { error: 'réponse IA non exploitable (JSON absent)' };

    const edits: PatchEdit[] = Array.isArray(obj.edits) ? obj.edits
      .filter((e: any) => e && typeof e.file === 'string' && typeof e.old === 'string' && typeof e.new === 'string')
      .map((e: any) => ({ file: String(e.file), old: String(e.old), new: String(e.new) }))
      : [];

    return {
      cause: String(obj.cause || '').slice(0, 2000),
      fixable: obj.fixable === true && edits.length > 0,
      confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0)),
      edits,
      explanation: String(obj.explanation || '').slice(0, 2000),
    };
  } catch (e: any) {
    return { error: `appel IA en échec : ${e?.message || e}` };
  }
}

// ── Journal en base ─────────────────────────────────────────────────────────

async function writeAttempt(row: {
  id: string; fingerprint: string; source: string; sentryIssueId?: string | null;
  errorMessage: string; errorStack?: string | null; targetFile?: string | null;
  status: AttemptStatus; diagnosis?: string | null; patch?: PatchEdit[] | null;
  verification?: Verification | null; rollbackReason?: string | null; durationMs: number;
}): Promise<void> {
  try {
    await db.insert(schema.selfHealAttempts).values({
      id: row.id,
      fingerprint: row.fingerprint,
      source: row.source,
      sentryIssueId: row.sentryIssueId || null,
      errorMessage: row.errorMessage.slice(0, 4000),
      errorStack: row.errorStack?.slice(0, 6000) || null,
      targetFile: row.targetFile || null,
      status: row.status,
      diagnosis: row.diagnosis?.slice(0, 4000) || null,
      patch: row.patch ? JSON.stringify(row.patch).slice(0, 20000) : null,
      verification: row.verification ? JSON.stringify({
        typecheck: { ok: row.verification.typecheck.ok, ms: row.verification.typecheck.durationMs, out: row.verification.typecheck.output.slice(-1500) },
        tests: { ok: row.verification.tests.ok, ms: row.verification.tests.durationMs, out: row.verification.tests.output.slice(-1500) },
        http: { ok: row.verification.http.ok, ms: row.verification.http.durationMs, out: row.verification.http.output.slice(-500) },
      }) : null,
      rollbackReason: row.rollbackReason?.slice(0, 2000) || null,
      model: FIX_MODEL,
      durationMs: row.durationMs,
    });
  } catch (e: any) {
    // Ne jamais faire échouer une réparation à cause du journal.
    console.error(`[selfheal] journalisation impossible : ${e?.message || e}`);
  }
}

// ── Notification ────────────────────────────────────────────────────────────

const SUBJECTS: Record<AttemptStatus, string> = {
  applied: '✅ Bug corrigé automatiquement',
  rolled_back: '↩️ Correctif annulé (Velbaz intact)',
  blocked_critical: '🔒 Correctif bloqué — validation requise',
  rate_limited: '⏸️ Auto-réparation en pause (plafond horaire)',
  circuit_open: '🛑 Auto-réparation coupée (coupe-circuit)',
  no_fix: 'ℹ️ Bug détecté, pas de correctif sûr',
  failed: '⚠️ Auto-réparation en échec',
  awaiting_approval: '🔒 Correctif prêt — ta validation requise',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notify(row: {
  id: string; status: AttemptStatus; errorMessage: string; targetFile?: string | null;
  diagnosis?: string | null; patch?: PatchEdit[] | null; verification?: Verification | null;
  rollbackReason?: string | null; confidence?: number;
}): Promise<void> {
  const to = ADMIN_EMAILS;
  if (to.length === 0) return;

  const v = row.verification;
  const step = (name: string, r?: { ok: boolean; durationMs: number; output: string }) =>
    r ? `<tr><td style="padding:4px 10px">${name}</td><td style="padding:4px 10px">${r.ok ? '✅' : '❌'}</td><td style="padding:4px 10px;color:#666">${Math.round(r.durationMs / 100) / 10}s</td></tr>` : '';

  const patchHtml = (row.patch || []).map(e => `
    <div style="margin:10px 0">
      <div style="font:600 12px ui-monospace,monospace;color:#555">${esc(e.file)}</div>
      <pre style="background:#fff0f0;border-left:3px solid #e55;margin:4px 0;padding:8px;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-x:auto">- ${esc(e.old.slice(0, 1200))}</pre>
      <pre style="background:#f0fff4;border-left:3px solid #2a2;margin:4px 0;padding:8px;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-x:auto">+ ${esc(e.new.slice(0, 1200))}</pre>
    </div>`).join('');

  const needsAction = row.status === 'blocked_critical' || row.status === 'awaiting_approval'
    || row.status === 'circuit_open' || row.status === 'rolled_back';

  const html = `<div style="font:14px/1.6 -apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:680px">
    <h2 style="margin:0 0 4px">${SUBJECTS[row.status]}</h2>
    <p style="margin:0 0 16px;color:#666;font-size:12px">Auto-réparation Velbaz · tentative <code>${row.id}</code></p>

    <h3 style="margin:18px 0 6px;font-size:14px">Erreur</h3>
    <pre style="background:#f6f6f6;padding:10px;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;margin:0">${esc(row.errorMessage.slice(0, 1500))}</pre>
    ${row.targetFile ? `<p style="margin:8px 0;font-size:12px">Fichier : <code>${esc(row.targetFile)}</code></p>` : ''}

    ${row.diagnosis ? `<h3 style="margin:18px 0 6px;font-size:14px">Diagnostic de l'IA${row.confidence != null ? ` <span style="font-weight:400;color:#666">(confiance ${Math.round(row.confidence * 100)}%)</span>` : ''}</h3>
    <p style="margin:0">${esc(row.diagnosis)}</p>` : ''}

    ${patchHtml ? `<h3 style="margin:18px 0 6px;font-size:14px">Correctif${row.status === 'applied' ? ' appliqué' : row.status === 'rolled_back' ? ' annulé' : ' proposé (non appliqué)'}</h3>${patchHtml}` : ''}

    ${v ? `<h3 style="margin:18px 0 6px;font-size:14px">Vérifications</h3>
    <table style="border-collapse:collapse;font-size:12px;background:#fafafa">
      ${step('Compilation TypeScript', v.typecheck)}${step('Suite de tests', v.tests)}${step('Serveur répond en HTTP', v.http)}
    </table>` : ''}

    ${row.rollbackReason ? `<p style="margin:16px 0;padding:10px;background:#fff8e6;border-left:3px solid #e9a;font-size:13px">${esc(row.rollbackReason)}</p>` : ''}

    <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #eee;font-size:12px;color:#666">
      ${needsAction ? '<strong>Action de ta part attendue.</strong> ' : 'Aucune action requise. '}
      État du code : ${row.status === 'applied' ? 'le correctif est en place et vérifié.' : 'inchangé — Velbaz tourne sur le code d’avant.'}
    </p>
  </div>`;

  const res = await sendEmailAuto({
    to,
    subject: `${SUBJECTS[row.status]} — ${row.errorMessage.slice(0, 70)}`,
    html,
    text: `${SUBJECTS[row.status]}\n\nErreur : ${row.errorMessage.slice(0, 500)}\nFichier : ${row.targetFile || '—'}\nDiagnostic : ${row.diagnosis || '—'}\n${row.rollbackReason || ''}`,
  });
  if (!res.ok) {
    console.error(`[selfheal] e-mail non envoyé (${res.error}) — tentative ${row.id}`);
    return;
  }
  try {
    await db.update(schema.selfHealAttempts)
      .set({ notifiedAt: new Date() })
      .where(eq(schema.selfHealAttempts.id, row.id));
  } catch { /* le journal n'est pas critique */ }
}

// ── Déduplication ───────────────────────────────────────────────────────────

/** Vrai si cette erreur a déjà été traitée récemment (ou est définitivement écartée). */
async function alreadyHandled(fingerprint: string): Promise<string | null> {
  const rows = await db.select({ status: schema.selfHealAttempts.status, createdAt: schema.selfHealAttempts.createdAt })
    .from(schema.selfHealAttempts)
    .where(eq(schema.selfHealAttempts.fingerprint, fingerprint))
    .orderBy(desc(schema.selfHealAttempts.createdAt))
    .limit(1).get();
  if (!rows) return null;

  // Un correctif appliqué : on ne repasse pas dessus (le bug est censé être mort ;
  // s'il revient, l'empreinte diffère car la ligne a changé).
  if (rows.status === 'applied') return 'correctif déjà appliqué pour cette erreur';
  // Une annulation ou un refus : on ne réessaie pas avant 24 h.
  const age = Date.now() - (rows.createdAt ? new Date(rows.createdAt).getTime() : 0);
  if (age < RETRY_COOLDOWN_MS) {
    return `déjà tentée il y a ${Math.round(age / 60000)} min (statut : ${rows.status})`;
  }
  return null;
}

// ── Entrée principale ───────────────────────────────────────────────────────

/**
 * Traite UNE erreur de bout en bout. Ne lève jamais.
 * `force` saute la déduplication (utilisé par le déclenchement manuel).
 */
export async function healError(raw: RawError, opts: { force?: boolean } = {}): Promise<HealResult> {
  const started = Date.now();

  if (!(await isSelfHealEnabled())) {
    return { attemptId: null, status: 'skipped', reason: 'auto-réparation désactivée' };
  }

  const t = triage(raw);
  if (!t.eligible) return { attemptId: null, status: 'skipped', reason: t.reason };
  const err = t.error;

  if (!opts.force) {
    const dup = await alreadyHandled(err.fingerprint);
    if (dup) return { attemptId: null, status: 'skipped', reason: dup };
  }

  const id = `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const base = {
    id, fingerprint: err.fingerprint, source: raw.source,
    sentryIssueId: raw.source === 'sentry' ? raw.id || null : null,
    errorMessage: err.message, errorStack: err.stack, targetFile: err.targetFile,
  };

  // Garde-fous de cadence AVANT de dépenser un appel IA.
  const pre = await guardPatch();
  if (!pre.ok) {
    await writeAttempt({ ...base, status: pre.status, rollbackReason: pre.reason, durationMs: Date.now() - started });
    slog('warn', 'selfheal.blocked', { id, status: pre.status, reason: pre.reason });
    // Une pause de cadence n'a pas besoin d'un e-mail à chaque erreur : le
    // coupe-circuit, oui — c'est un arrêt du système.
    if (pre.status === 'circuit_open') {
      await notify({ ...base, status: pre.status, rollbackReason: pre.reason }).catch(() => {});
    }
    return { attemptId: id, status: pre.status, reason: pre.reason, targetFile: err.targetFile };
  }

  slog('info', 'selfheal.diagnosing', { id, file: err.targetFile, fingerprint: err.fingerprint });
  const prop = await diagnose(err);

  if ('error' in prop) {
    await writeAttempt({ ...base, status: 'failed', rollbackReason: prop.error, durationMs: Date.now() - started });
    slog('error', 'selfheal.diagnose_failed', { id, reason: prop.error });
    return { attemptId: id, status: 'failed', reason: prop.error, targetFile: err.targetFile };
  }

  if (!prop.fixable) {
    await writeAttempt({ ...base, status: 'no_fix', diagnosis: prop.cause, durationMs: Date.now() - started });
    slog('info', 'selfheal.no_fix', { id, cause: prop.cause.slice(0, 200) });
    return { attemptId: id, status: 'no_fix', reason: prop.cause || 'aucun correctif sûr identifié', targetFile: err.targetFile, diagnosis: prop.cause };
  }

  // Garde-fous sur le correctif lui-même : fichiers protégés, zones sensibles.
  const verdict = await guardPatch(prop.edits);
  if (!verdict.ok) {
    await writeAttempt({ ...base, status: verdict.status, diagnosis: prop.cause, patch: prop.edits, rollbackReason: verdict.reason, durationMs: Date.now() - started });
    slog('warn', 'selfheal.patch_blocked', { id, status: verdict.status, reason: verdict.reason });
    await notify({ ...base, status: verdict.status, diagnosis: prop.cause, patch: prop.edits, rollbackReason: verdict.reason, confidence: prop.confidence }).catch(() => {});
    return { attemptId: id, status: verdict.status, reason: verdict.reason, targetFile: err.targetFile, diagnosis: prop.cause };
  }

  // Confiance insuffisante : le correctif existe mais part en validation.
  if (prop.confidence < MIN_CONFIDENCE) {
    const reason = `confiance ${Math.round(prop.confidence * 100)}% < seuil ${Math.round(MIN_CONFIDENCE * 100)}% — non appliqué`;
    await writeAttempt({ ...base, status: 'awaiting_approval', diagnosis: prop.cause, patch: prop.edits, rollbackReason: reason, durationMs: Date.now() - started });
    slog('info', 'selfheal.low_confidence', { id, confidence: prop.confidence });
    await notify({ ...base, status: 'awaiting_approval', diagnosis: prop.cause, patch: prop.edits, rollbackReason: reason, confidence: prop.confidence }).catch(() => {});
    return { attemptId: id, status: 'awaiting_approval', reason, targetFile: err.targetFile, diagnosis: prop.cause };
  }

  // ── Écriture réelle ───────────────────────────────────────────────────────
  slog('info', 'selfheal.applying', { id, files: prop.edits.map(e => e.file), confidence: prop.confidence });
  const outcome = await applyWithRollback(id, prop.edits);

  const status: AttemptStatus = outcome.applied ? 'applied' : outcome.rolledBack ? 'rolled_back' : 'failed';
  await writeAttempt({
    ...base, status, diagnosis: prop.cause, patch: prop.edits,
    verification: outcome.verification, rollbackReason: outcome.reason, durationMs: Date.now() - started,
  });
  slog(status === 'applied' ? 'info' : 'error', `selfheal.${status}`, { id, file: err.targetFile, reason: outcome.reason });

  await notify({
    ...base, status, diagnosis: prop.cause, patch: prop.edits,
    verification: outcome.verification, rollbackReason: outcome.reason, confidence: prop.confidence,
  }).catch(() => {});

  return {
    attemptId: id, status,
    reason: outcome.reason || 'correctif appliqué et vérifié',
    targetFile: err.targetFile, diagnosis: prop.cause,
  };
}

// ── Veille : balayage périodique des erreurs récentes ───────────────────────

let lastScanAt = Date.now();

/**
 * Lit les erreurs apparues depuis le dernier passage, garde la première qui
 * passe le tri, et tente de la réparer. UNE seule par passage : un correctif
 * modifie le code et redémarre les modules — enchaîner serait ingérable.
 */
export async function scanAndHeal(): Promise<HealResult> {
  if (!(await isSelfHealEnabled())) {
    return { attemptId: null, status: 'skipped', reason: 'auto-réparation désactivée' };
  }

  const since = new Date(lastScanAt - 60_000); // 1 min de recouvrement
  lastScanAt = Date.now();

  let rows: any[] = [];
  try {
    rows = await db.select().from(schema.errorLogs)
      .where(and(
        gte(schema.errorLogs.createdAt, since),
        inArray(schema.errorLogs.level, ['error', 'fatal']),
      ))
      .orderBy(desc(schema.errorLogs.createdAt))
      .limit(60).all();
  } catch (e: any) {
    return { attemptId: null, status: 'skipped', reason: `lecture des erreurs impossible : ${e?.message || e}` };
  }

  // Sentry en complément du flux interne : mêmes tri et garde-fous ensuite.
  if (isSentryApiConfigured()) {
    try {
      const sinceMinutes = Math.max(5, Math.ceil((Date.now() - since.getTime()) / 60_000));
      rows = [...(await fetchSentryErrors(sinceMinutes)), ...rows];
    } catch (e: any) {
      slog('warn', 'selfheal.sentry_poll_failed', { error: e?.message || String(e) });
    }
  }

  for (const r of rows) {
    const t = triage(r as RawError);
    if (!t.eligible) continue;
    if (await alreadyHandled(t.error.fingerprint)) continue;
    return await healError(r as RawError);
  }
  return { attemptId: null, status: 'skipped', reason: `aucune erreur réparable parmi ${rows.length} entrées` };
}

let watcher: ReturnType<typeof setInterval> | null = (globalThis as any).__velbaz_selfheal_watcher ?? null;

/** Démarre la veille (idempotent, survit au rechargement à chaud de Vite). */
export function startSelfHealWatcher(intervalMs = 5 * 60_000): void {
  if (watcher) return;
  watcher = setInterval(() => {
    scanAndHeal().catch(e => console.error('[selfheal] balayage en échec :', e?.message || e));
  }, intervalMs);
  (globalThis as any).__velbaz_selfheal_watcher = watcher;
  slog('info', 'selfheal.watcher_started', { intervalMs });
}

export function stopSelfHealWatcher(): void {
  if (watcher) clearInterval(watcher);
  watcher = null;
  (globalThis as any).__velbaz_selfheal_watcher = null;
}

// ── Lecture pour le panneau admin ───────────────────────────────────────────

export async function listAttempts(limit = 50) {
  const rows = await db.select().from(schema.selfHealAttempts)
    .orderBy(desc(schema.selfHealAttempts.createdAt)).limit(limit).all();
  return rows.map(r => ({
    ...r,
    patch: r.patch ? (() => { try { return JSON.parse(r.patch!); } catch { return null; } })() : null,
    verification: r.verification ? (() => { try { return JSON.parse(r.verification!); } catch { return null; } })() : null,
  }));
}

export async function selfHealStatus() {
  const [enabled, rate] = await Promise.all([isSelfHealEnabled(), readRateState()]);
  const counts = await db.select({ status: schema.selfHealAttempts.status, n: sql<number>`count(*)` })
    .from(schema.selfHealAttempts).groupBy(schema.selfHealAttempts.status).all()
    .catch(() => [] as { status: string; n: number }[]);
  return {
    enabled,
    model: FIX_MODEL,
    minConfidence: MIN_CONFIDENCE,
    watcherRunning: !!watcher,
    sentry: sentryState(),
    rate,
    byStatus: Object.fromEntries(counts.map(c => [c.status, Number(c.n)])),
  };
}
