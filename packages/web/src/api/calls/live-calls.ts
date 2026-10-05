// ─── Appels IA en direct : moteur (réel Bland + simulation) ─────────────────
//
// Un appel = une ligne `live_calls` + un journal d'événements `live_call_events`
// (paroles IA, paroles du contact, messages du superviseur, réponses privées
// de l'IA, consignes transmises, statuts). La carte du chat ne lit QUE ce
// journal, via un flux SSE : elle affiche la même chose qu'il s'agisse d'un
// vrai appel ou d'une simulation.
//
// Réel (BLAND_API_KEY présent) :
//   - transcription : webhook d'événements Bland (rapide) et, en secours,
//     relecture de GET /v1/calls/:id (marche même si Bland ne peut pas nous
//     joindre, ex. en local) ;
//   - consignes en direct : `dynamic_data` en cache:false → Bland relit
//     /hooks/live-calls/:token/context avant CHAQUE réponse de l'IA ;
//   - audio : WebSocket /listen de Bland, ouvert par le navigateur.
// Simulation (pas de clé) : un runner génère la conversation tour par tour
// avec l'IA, en tenant compte des consignes envoyées pendant l'appel. Aucun
// appel réel n'est passé, rien n'est facturé chez Bland.

import {
  addCallEvent, callQuota, finishCall, getCall, getCallByHook, insertCall, listCallEvents, newId, newToken, updateCall,
  type CallEvent, type LiveCallRow, type NewCallRow,
} from './store';
import { callModeFor, listenUrl, parseCallPayload, readCall, startCall, stopCall } from './bland';
import { answerSupervisor, buildCallTask, simNextTurn, summarizeCall } from './brain';

export const MAX_CALLS_PER_DAY = 30;
export const MAX_ACTIVE_CALLS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TERMINAL = new Set(['ended', 'failed', 'canceled']);

/** Normalise un numéro en E.164. `0612…` → +33612… (Velbaz est français par défaut). */
export function normalizePhone(raw: unknown, defaultCountry = '33'): string | null {
  let s = String(raw ?? '').replace(/[\s.\-()]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^0\d{9}$/.test(s)) s = `+${defaultCountry}${s.slice(1)}`;
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

export function publicCall(r: LiveCallRow) {
  return {
    id: r.id,
    companyId: r.companyId,
    mode: r.mode,
    phone: r.phone,
    contactName: r.contactName,
    goal: r.goal,
    language: r.language,
    status: r.status,
    error: r.error,
    summary: r.summary,
    recordingUrl: r.recordingUrl,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    updatedAt: r.updatedAt,
    direction: r.direction,
    inboundState: r.inboundState,
    ringUntil: r.ringUntil,
  };
}

export type CreateCallResult = { ok: true; call: LiveCallRow } | { ok: false; error: string; code: string };

export async function createLiveCall(input: {
  companyId: string; userId: string; companyName?: string;
  to: unknown; contactName?: unknown; goal?: unknown; language?: unknown;
  origin?: string;
}): Promise<CreateCallResult> {
  const phone = normalizePhone(input.to);
  if (!phone) return { ok: false, error: 'Numéro de téléphone invalide (format international attendu, ex. +33612345678).', code: 'bad_phone' };
  const goal = String(input.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (goal.length < 4) return { ok: false, error: "Objectif de l'appel manquant.", code: 'missing_goal' };
  const contactName = String(input.contactName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  const language = /^en/i.test(String(input.language || '')) ? 'en' : 'fr';

  const q = await callQuota(input.companyId, input.userId, Date.now() - DAY_MS);
  if (q.active >= MAX_ACTIVE_CALLS) return { ok: false, error: `Déjà ${q.active} appels en cours : attends qu'un appel se termine.`, code: 'too_many_active' };
  if (q.today >= MAX_CALLS_PER_DAY) return { ok: false, error: `Plafond atteint : ${MAX_CALLS_PER_DAY} appels par jour et par projet.`, code: 'daily_cap' };

  const how = callModeFor(phone);
  if (!how.real && !how.sim) return { ok: false, error: how.reason, code: 'no_provider' };
  const mode: LiveCallRow['mode'] = how.real ? 'bland' : 'sim';
  const row: NewCallRow = {
    id: newId('lc'),
    companyId: input.companyId,
    userId: input.userId,
    mode,
    providerCallId: null,
    phone,
    contactName,
    goal,
    language,
    status: 'dialing',
    hookToken: newToken(),
    createdAt: Date.now(),
  };
  await insertCall(row);
  await addCallEvent(row.id, 'system', how.real ? `Appel vers ${phone}…` : how.reason);

  if (mode === 'bland') {
    const origin = (input.origin || '').replace(/\/$/, '');
    const res = await startCall({
      to: phone,
      task: buildCallTask({ goal, companyName: input.companyName, contactName, language }),
      language,
      webhookUrl: origin ? `${origin}/api/hooks/live-calls/${row.hookToken}` : undefined,
      contextUrl: origin ? `${origin}/api/hooks/live-calls/${row.hookToken}/context` : undefined,
    });
    if (!res.ok) {
      await finishCall(row.id, 'failed', { error: res.error });
      await addCallEvent(row.id, 'system', `Échec du lancement : ${res.error}`);
    } else {
      await updateCall(row.id, { providerCallId: res.callId, status: 'ringing' });
    }
  } else {
    void runSimulation(row.id, input.companyName);
  }
  const call = await getCall(row.id);
  return call ? { ok: true, call } : { ok: false, error: 'Appel introuvable après création', code: 'internal' };
}

// ── Simulation ──────────────────────────────────────────────────────────────

const simRunning = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Temps de parole estimé : laisse au navigateur le temps de lire la réplique. */
// ~75 ms par caractère : le rythme des voix Bland (TTS v2/v3) en français.
export const speakMs = (text: string) => Math.max(1600, Math.min(14000, text.length * 75)) + 450;

async function directivesOf(callId: string): Promise<string[]> {
  return (await listCallEvents(callId)).filter((e) => e.kind === 'directive').map((e) => e.text);
}

async function runSimulation(callId: string, companyName?: string) {
  if (simRunning.has(callId)) return;
  simRunning.add(callId);
  try {
    await sleep(900);
    let row = await getCall(callId);
    if (!row || TERMINAL.has(row.status)) return;
    await updateCall(callId, { status: 'ringing' });
    await sleep(2600);
    row = await getCall(callId);
    if (!row || TERMINAL.has(row.status)) return;
    await updateCall(callId, { status: 'live', startedAt: Date.now() });
    await addCallEvent(callId, 'system', 'Appel décroché.');

    const maxTurns = 12;
    let next: 'ai' | 'contact' = 'contact'; // le contact décroche : « Allô ? »
    for (let turn = 0; turn < maxTurns; turn++) {
      row = await getCall(callId);
      if (!row || TERMINAL.has(row.status)) return;
      let text: string;
      let end = false;
      if (turn === 0) {
        text = row.language === 'en' ? 'Hello?' : 'Allô ?';
      } else {
        const events = await listCallEvents(callId);
        const t = await simNextTurn({
          goal: row.goal, companyName, contactName: row.contactName, language: row.language,
          events, directives: events.filter((e) => e.kind === 'directive').map((e) => e.text),
          nextSpeaker: next, turn, maxTurns,
        });
        text = t.text;
        end = t.end;
      }
      row = await getCall(callId);
      if (!row || TERMINAL.has(row.status)) return;
      await addCallEvent(callId, next, text);
      await sleep(speakMs(text));
      if (end) break;
      next = next === 'ai' ? 'contact' : 'ai';
    }
    await endAndSummarize(callId, 'ended');
  } catch (e: any) {
    console.error('[live-calls] simulation failed:', e?.message);
    await finishCall(callId, 'failed', { error: String(e?.message || e) }).catch(() => {});
  } finally {
    simRunning.delete(callId);
  }
}

export async function endAndSummarize(callId: string, status: 'ended' | 'failed' | 'canceled', extra: { summary?: string; recordingUrl?: string; error?: string } = {}) {
  const row = await getCall(callId);
  if (!row || TERMINAL.has(row.status)) return;
  const changed = await finishCall(callId, status, extra);
  if (!changed) return;
  await addCallEvent(callId, 'system', status === 'canceled' ? 'Appel raccroché.' : status === 'failed' ? 'Appel interrompu.' : 'Appel terminé.');
  if (!extra.summary) {
    const summary = await summarizeCall({ goal: row.goal, contactName: row.contactName, events: await listCallEvents(callId) }).catch(() => '');
    if (summary) await updateCall(callId, { summary });
  }
}

// ── Appel réel : synchronisation avec Bland ─────────────────────────────────

const lastSync = new Map<string, number>();

/** Relit l'état Bland (au plus toutes les 2,5 s par appel, quel que soit le nombre de spectateurs). */
export async function maybeSyncRealCall(row: LiveCallRow): Promise<void> {
  if (row.mode !== 'bland' || !row.providerCallId || TERMINAL.has(row.status)) return;
  const now = Date.now();
  if (now - (lastSync.get(row.id) || 0) < 2500) return;
  lastSync.set(row.id, now);
  const st = await readCall(row.providerCallId);
  if (!st) return;
  await applyBlandState(row, st);
}

export async function applyBlandState(row: LiveCallRow, st: ReturnType<typeof parseCallPayload>) {
  if (st.live && row.status !== 'live') {
    await updateCall(row.id, { status: 'live', startedAt: row.startedAt || Date.now() });
    await addCallEvent(row.id, 'system', 'Appel décroché.');
  }
  // Transcription relue : seulement si le webhook temps réel ne nous parle pas
  // (sinon chaque phrase apparaîtrait deux fois). Le webhook de FIN, lui,
  // apporte la transcription complète quand rien n'a été reçu en direct.
  if (!row.hookSeen) {
    for (const l of st.lines) {
      if (l.who === 'system') continue;
      // Même préfixe pour la relecture et le webhook de fin : une ligne Bland = une ligne ici.
      await addCallEvent(row.id, l.who, l.text, `t:${l.id}`, l.at);
    }
  }
  if (st.ended) {
    await endAndSummarize(row.id, st.error ? 'failed' : 'ended', { summary: st.summary, recordingUrl: st.recordingUrl, error: st.error });
    lastSync.delete(row.id);
  }
}

/** Webhook Bland : événements en direct ET compte rendu de fin d'appel. */
export async function handleCallHook(token: string, body: any): Promise<{ status: number; ok: boolean }> {
  const row = await getCallByHook(token);
  if (!row) return { status: 404, ok: false };
  if (body?.call_id && row.providerCallId && String(body.call_id) !== row.providerCallId) return { status: 403, ok: false };
  return applyCallHook(row, body);
}

/** Applique un événement / compte rendu Bland à un appel connu (sortant ou entrant). */
export async function applyCallHook(row: LiveCallRow, body: any): Promise<{ status: number; ok: boolean }> {
  if (!row.providerCallId && body?.call_id) await updateCall(row.id, { providerCallId: String(body.call_id) });

  const msg = typeof body?.message === 'string' ? body.message : '';
  if (msg) {
    const agent = msg.match(/^Agent speech:\s*([\s\S]+)/i);
    const user = msg.match(/^Handling user speech:\s*([\s\S]+)/i);
    if (agent || user) {
      if (!row.hookSeen) await updateCall(row.id, { hookSeen: 1 });
      if (row.status !== 'live' && !TERMINAL.has(row.status)) await updateCall(row.id, { status: 'live', startedAt: row.startedAt || Date.now() });
      await addCallEvent(row.id, agent ? 'ai' : 'contact', (agent || user)![1].trim());
    } else if (/^Call connected/i.test(msg) && row.status !== 'live' && !TERMINAL.has(row.status)) {
      await updateCall(row.id, { status: 'live', startedAt: Date.now() });
      await addCallEvent(row.id, 'system', 'Appel décroché.');
    }
    return { status: 200, ok: true };
  }
  // Compte rendu de fin (même forme que GET /v1/calls/:id).
  if (body && (body.completed !== undefined || body.concatenated_transcript || body.transcripts)) {
    const fresh = (await getCall(row.id)) || row;
    await applyBlandState(fresh, { ...parseCallPayload(body), ended: true });
  }
  return { status: 200, ok: true };
}

/** Lu par Bland avant chaque réponse de l'IA (dynamic_data, cache:false). */
export async function contextForHook(token: string): Promise<{ status: number; body: any }> {
  const row = await getCallByHook(token);
  if (!row) return { status: 404, body: { instructions: '' } };
  const dirs = await directivesOf(row.id);
  const last = dirs.slice(-4);
  return { status: 200, body: { instructions: last.length ? last.map((d, i) => `${i + 1}. ${d}`).join(' ') : 'Aucune consigne pour le moment.' } };
}

// ── Actions de l'utilisateur ────────────────────────────────────────────────

export async function instructCall(row: LiveCallRow, text: string): Promise<{ ok: true; reply: string; directive: string } | { ok: false; error: string }> {
  const message = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!message) return { ok: false, error: 'Message vide' };
  await addCallEvent(row.id, 'user', message);
  const events: CallEvent[] = await listCallEvents(row.id);
  const ans = await answerSupervisor({ message, goal: row.goal, contactName: row.contactName, events, language: row.language });
  if (ans.directive && !TERMINAL.has(row.status)) await addCallEvent(row.id, 'directive', ans.directive);
  if (ans.reply) await addCallEvent(row.id, 'note', ans.reply);
  return { ok: true, reply: ans.reply, directive: ans.directive };
}

export async function hangUp(row: LiveCallRow): Promise<{ ok: boolean; error?: string }> {
  if (TERMINAL.has(row.status)) return { ok: true };
  if (row.mode === 'bland' && row.providerCallId) {
    const r = await stopCall(row.providerCallId);
    if (!r.ok) return r;
  }
  await endAndSummarize(row.id, 'canceled');
  return { ok: true };
}

export async function listenFor(row: LiveCallRow) {
  if (row.mode !== 'bland') return { ok: false as const, error: 'Simulation : la voix est lue par ton navigateur.', code: 'sim' };
  if (!row.providerCallId || row.status !== 'live') return { ok: false as const, error: "L'appel n'est pas encore décroché.", code: 'not_live' };
  return listenUrl(row.providerCallId);
}
