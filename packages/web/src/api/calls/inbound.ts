// ─── Appels ENTRANTS : quelqu'un appelle le numéro du projet ────────────────
//
// Demande utilisateur (2026-10-01) : « quand la personne appelle, l'IA répond
// (quand j'ai activé le auto) ; si je ne l'ai pas activé, ça met une popup et
// quand j'appuie sur Répondre, l'IA lui parle ».
//
// Cycle d'un appel entrant (une ligne `live_calls`, direction = 'in') :
//   1. l'appel arrive → inbound_state =
//        - 'auto'    si l'Autopilot (mode auto) du projet est actif : l'IA prend
//                    l'appel tout de suite ;
//        - 'pending' sinon : ça sonne chez le propriétaire (popup globale) ;
//   2. depuis la popup : « Répondre » → 'accepted' (l'IA parle à l'appelant,
//      le propriétaire suit la conversation et peut glisser des consignes),
//      « Refuser » → 'declined' (l'IA prend un message) ;
//   3. personne ne répond avant RING_MS → 'timeout' : l'IA décroche quand
//      même, aucun client n'est perdu.
//
// Vrai appel (Bland) : Bland décroche immédiatement le numéro entrant ; tant
// que l'état est 'pending', l'IA fait patienter (HOLD). L'état est relu avant
// chaque réponse via dynamic_data (/hooks/inbound/:token/context).
// Simulation : un runner joue l'appelant ET l'IA, après la décision.

import {
  addCallEvent, decideInbound, getCall, getCallByProviderId, getInboundLineByHook, insertCall, listCallEvents,
  newId, newToken, updateCall, type InboundLineRow, type InboundState, type LiveCallRow,
} from './store';
import { TERMINAL, applyCallHook, endAndSummarize, normalizePhone, speakMs } from './live-calls';
import { SIM_INBOUND_CALLERS, simInboundTurn } from './brain';

export const RING_MS = 25_000;

interface InboundDeps {
  /** Mode auto (Autopilot) actif sur ce projet ? */
  isAutoOn: (companyId: string) => Promise<boolean>;
  /** Nom du projet (pour le prompt et la simulation). */
  companyName: (companyId: string) => Promise<string | undefined>;
  /** Ajoute un message de l'assistant dans le chat du projet. */
  postChat: (companyId: string, content: string) => Promise<void>;
}
let deps: InboundDeps = {
  isAutoOn: async () => false,
  companyName: async () => undefined,
  postChat: async () => {},
};
export function setInboundDeps(d: Partial<InboundDeps>) { deps = { ...deps, ...d }; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INBOUND_GOAL = 'Appel entrant : accueillir la personne, comprendre sa demande et y répondre.';

export async function startInboundCall(input: {
  companyId: string; userId: string; mode: 'sim' | 'bland';
  phone?: string | null; contactName?: string | null; providerCallId?: string | null;
  /** Simulation : appelant et motif imposés (sinon tirés au hasard). */
  simCaller?: { name: string; reason: string };
  /** Durée de sonnerie (tests) ; RING_MS par défaut. */
  ringMs?: number;
}): Promise<LiveCallRow> {
  const ring = Math.max(500, input.ringMs ?? RING_MS);
  const auto = await deps.isAutoOn(input.companyId).catch(() => false);
  const caller = input.mode === 'sim' ? (input.simCaller || SIM_INBOUND_CALLERS[Math.floor(Math.random() * SIM_INBOUND_CALLERS.length)]) : null;
  const now = Date.now();
  const row = {
    id: newId('lc'),
    companyId: input.companyId,
    userId: input.userId,
    mode: input.mode,
    providerCallId: input.providerCallId || null,
    // Simulation : numéro fictif de la plage réservée à la fiction (jamais attribué).
    phone: normalizePhone(input.phone) || (input.mode === 'sim' ? '+33639980000' : 'Numéro masqué'),
    contactName: input.contactName || caller?.name || null,
    goal: INBOUND_GOAL,
    language: 'fr',
    status: 'ringing' as const,
    hookToken: newToken(),
    createdAt: now,
    direction: 'in' as const,
    inboundState: (auto ? 'auto' : 'pending') as InboundState,
    ringUntil: auto ? null : now + ring,
  };
  await insertCall(row);
  await addCallEvent(row.id, 'system', `Appel entrant${row.contactName ? ` de ${row.contactName}` : ''}${input.mode === 'sim' ? ' (simulation)' : ''}.`);

  if (auto) {
    await onDecided(row.id, 'auto');
  } else {
    // Personne ne répond à la popup → l'IA décroche quand même.
    setTimeout(() => { void expireRing(row.id); }, ring + 200);
  }
  if (input.mode === 'sim' && caller) void runInboundSim(row.id, caller);
  return (await getCall(row.id))!;
}

async function expireRing(id: string) {
  if (await decideInbound(id, 'timeout')) await onDecided(id, 'timeout');
}

/** Décision depuis la popup (« Répondre » / « Refuser »). Une seule décision gagne. */
export async function answerInbound(row: LiveCallRow, action: 'accept' | 'decline'): Promise<{ ok: boolean; error?: string; state?: InboundState | null }> {
  if (row.direction !== 'in') return { ok: false, error: "Ce n'est pas un appel entrant." };
  if (TERMINAL.has(row.status)) return { ok: false, error: "L'appelant a raccroché." };
  const state = action === 'accept' ? 'accepted' : 'declined';
  if (await decideInbound(row.id, state)) await onDecided(row.id, state);
  const fresh = await getCall(row.id);
  return { ok: true, state: fresh?.inboundState ?? null };
}

const DECIDED_NOTE: Record<Exclude<InboundState, 'pending'>, string> = {
  auto: 'Mode auto : l’IA a décroché.',
  accepted: 'Tu as pris l’appel : l’IA lui répond.',
  declined: 'Appel refusé : l’IA prend un message.',
  timeout: 'Pas de réponse à temps : l’IA a décroché pour toi.',
};

async function onDecided(id: string, state: Exclude<InboundState, 'pending'>) {
  const row = await getCall(id);
  if (!row) return;
  await addCallEvent(id, 'system', DECIDED_NOTE[state]);
  const who = row.contactName || row.phone;
  const lead = state === 'declined' ? `Appel entrant de ${who} : tu as refusé, je prends un message.`
    : state === 'auto' ? `Appel entrant de ${who} : mode auto actif, j'ai décroché.`
    : state === 'timeout' ? `Appel entrant de ${who} : tu n'as pas répondu, j'ai décroché pour toi.`
    : `Appel entrant de ${who} : je lui réponds.`;
  await deps.postChat(row.companyId, `${lead}\n\n[CALL_VIEW]${JSON.stringify({ id })}[/CALL_VIEW]`).catch((e) => console.warn('[inbound] postChat failed:', e?.message));
}

// ── Simulation ──────────────────────────────────────────────────────────────

const running = new Set<string>();

async function runInboundSim(id: string, caller: { name: string; reason: string }) {
  if (running.has(id)) return;
  running.add(id);
  try {
    // 1. Attendre la décision (popup, auto ou délai dépassé).
    let row = await getCall(id);
    const deadline = (row?.ringUntil || Date.now() + RING_MS) + 5000;
    while (row && row.inboundState === 'pending' && !TERMINAL.has(row.status) && Date.now() < deadline) {
      await sleep(400);
      row = await getCall(id);
    }
    if (row && row.inboundState === 'pending') { await expireRing(id); row = await getCall(id); }
    if (!row || TERMINAL.has(row.status)) return;

    // 2. L'IA décroche.
    const companyName = await deps.companyName(row.companyId).catch(() => undefined);
    await sleep(700);
    await updateCall(id, { status: 'live', startedAt: Date.now() });
    await addCallEvent(id, 'system', 'Appel décroché.');
    const mode = row.inboundState === 'declined' ? 'message' as const : 'answer' as const;

    const maxTurns = 12;
    let next: 'ai' | 'contact' = 'ai';
    for (let turn = 0; turn < maxTurns; turn++) {
      row = await getCall(id);
      if (!row || TERMINAL.has(row.status)) return;
      let text: string;
      let end = false;
      if (turn === 0) {
        text = `Bonjour, ${companyName || 'bienvenue'}, je vous écoute.`;
      } else {
        const events = await listCallEvents(id);
        const t = await simInboundTurn({
          companyName, callerName: caller.name, reason: caller.reason, mode, language: row.language,
          events, directives: events.filter((e) => e.kind === 'directive').map((e) => e.text),
          nextSpeaker: next, turn, maxTurns,
        });
        text = t.text;
        end = t.end;
      }
      row = await getCall(id);
      if (!row || TERMINAL.has(row.status)) return;
      await addCallEvent(id, next, text);
      await sleep(speakMs(text));
      if (end) break;
      next = next === 'ai' ? 'contact' : 'ai';
    }
    await endAndSummarize(id, 'ended');
  } catch (e: any) {
    console.error('[inbound] simulation failed:', e?.message);
    await endAndSummarize(id, 'failed', { error: String(e?.message || e) }).catch(() => {});
  } finally {
    running.delete(id);
  }
}

// ── Vrai appel (Bland) ──────────────────────────────────────────────────────

const realVar = (v: unknown) => {
  const s = String(v ?? '').trim();
  return s && !s.includes('{{') ? s : '';
};

/** Retrouve (ou crée au premier signe de vie) l'appel entrant correspondant. */
async function resolveInbound(line: InboundLineRow, callId: string, from: string): Promise<LiveCallRow | null> {
  if (callId) {
    const known = await getCallByProviderId(callId);
    if (known) return known.companyId === line.companyId ? known : null;
    return startInboundCall({ companyId: line.companyId, userId: line.userId, mode: 'bland', providerCallId: callId, phone: from });
  }
  return null;
}

/** Lu par Bland avant chaque réponse de l'IA : état de la ligne + consignes. */
export async function inboundContext(token: string, query: { call_id?: string; from?: string }): Promise<{ status: number; body: any }> {
  const line = await getInboundLineByHook(token);
  if (!line) return { status: 404, body: { line_state: 'ANSWER', instructions: '' } };
  const row = await resolveInbound(line, realVar(query.call_id), realVar(query.from));
  if (!row) return { status: 200, body: { line_state: 'ANSWER', instructions: 'Aucune consigne pour le moment.' } };
  let state = row.inboundState;
  if (state === 'pending' && row.ringUntil && Date.now() > row.ringUntil) {
    await expireRing(row.id);
    state = (await getCall(row.id))?.inboundState ?? 'timeout';
  }
  const line_state = state === 'pending' ? 'HOLD — le responsable est prévenu, fais patienter.'
    : state === 'declined' ? 'MESSAGE — personne n’est disponible, prends un message.'
    : 'ANSWER — prends l’appel en charge.';
  const dirs = (await listCallEvents(row.id)).filter((e) => e.kind === 'directive').map((e) => e.text).slice(-4);
  return { status: 200, body: { line_state, instructions: dirs.length ? dirs.map((d, i) => `${i + 1}. ${d}`).join(' ') : 'Aucune consigne pour le moment.' } };
}

/** Webhook Bland de la ligne entrante (événements en direct + compte rendu de fin). */
export async function handleInboundHook(token: string, body: any): Promise<{ status: number; ok: boolean }> {
  const line = await getInboundLineByHook(token);
  if (!line) return { status: 404, ok: false };
  const callId = realVar(body?.call_id || body?.c_id);
  const row = await resolveInbound(line, callId, realVar(body?.from));
  if (!row) return { status: 200, ok: true };
  return applyCallHook(row, body);
}
