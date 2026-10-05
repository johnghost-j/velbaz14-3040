// ─── Bland.ai : appels en direct + SMS conversationnels ─────────────────────
//
// Client HTTP minimal pour la vue « appel en direct » et le panneau SMS.
// Aucune clé = aucune requête réseau : l'appelant passe alors en simulation
// (voir ./sim.ts). Les erreurs ne sont jamais avalées : elles remontent en
// texte lisible pour être affichées dans la carte d'appel.
//
// Auth : Bland documente `Authorization: <clé>` sur la plupart des routes et
// `Authorization: Bearer <clé>` sur /listen. On envoie la clé brute, puis on
// retente une fois en Bearer si la réponse est 401/403.

import { getSecret } from '../secret-store';
import { callVoice } from './voice';

const API = 'https://api.bland.ai/v1';
const key = () => getSecret('BLAND_API_KEY') || '';
const fromNumber = () => getSecret('BLAND_FROM') || '';

// CALLS_FORCE_SIM=1 : tout passe en simulation même si une clé Bland existe
// (tests, démo) — aucun vrai numéro n'est jamais composé.
const forceSim = () => process.env.CALLS_FORCE_SIM === '1';
export const blandCallsReady = () => !forceSim() && !!key();
export const blandSmsReady = () => !forceSim() && !!(key() && fromNumber());
/** Projet de démonstration (données d'exemple pré-remplies). */
export const isDemoCompany = (companyId?: string | null) => String(companyId || '').startsWith('demo-comms-');

/**
 * Numéros d'exemple (projet démo, exemples des prompts) : jamais composés pour
 * de vrai, quelle que soit la config. Ils appartiennent peut-être à quelqu'un.
 */
export const EXAMPLE_NUMBERS = new Set(['+33611223344', '+33612345678', '+33698765432', '+33639980000']);
export const isExampleNumber = (phone?: string | null) => EXAMPLE_NUMBERS.has(String(phone || '').replace(/[^\d+]/g, ''));

export type CommsMode = { real: true } | { real: false; sim: true; reason: string } | { real: false; sim: false; reason: string };

/**
 * Vrai appel ou simulation ? Demande utilisateur (2026-10-01) : « ça doit être
 * du vrai ». Dès que Bland est configuré, l'appel part vraiment, projet démo
 * compris. Seuls les numéros d'exemple et CALLS_FORCE_SIM restent simulés.
 */
export function callModeFor(phone: string): CommsMode {
  if (forceSim()) return { real: false, sim: true, reason: 'Simulation (mode test) : aucun vrai appel n’est passé.' };
  if (isExampleNumber(phone)) return { real: false, sim: true, reason: 'Numéro d’exemple : appel simulé, personne n’est appelé. Donne ton vrai numéro pour un vrai appel.' };
  if (!key()) return { real: false, sim: false, reason: 'Clé Bland absente : ajoute BLAND_API_KEY dans Admin → API Keys pour passer de vrais appels.' };
  return { real: true };
}

/** Pareil pour les SMS : il faut en plus un numéro d'envoi Bland (BLAND_FROM). */
export function smsModeFor(phone: string): CommsMode {
  if (forceSim()) return { real: false, sim: true, reason: 'Simulation (mode test) : aucun vrai SMS n’est envoyé.' };
  if (isExampleNumber(phone)) return { real: false, sim: true, reason: 'Numéro d’exemple : SMS simulé, rien n’est envoyé.' };
  if (!key()) return { real: false, sim: false, reason: 'Clé Bland absente : ajoute BLAND_API_KEY dans Admin → API Keys pour envoyer de vrais SMS.' };
  if (!fromNumber()) return { real: false, sim: false, reason: 'SMS non envoyé : il faut un numéro Bland qui envoie les SMS. Achète-en un sur app.bland.ai (Phone Numbers), puis ajoute-le dans Admin → API Keys (BLAND_FROM).' };
  return { real: true };
}

function apiError(data: any, status: number): string {
  if (Array.isArray(data?.errors) && data.errors.length) {
    return data.errors.map((e: any) => e?.message || e?.error || e?.code || String(e)).join('; ');
  }
  return String(data?.message || data?.error || `Bland ${status}`);
}

async function bland(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const send = async (auth: string) => {
    const res = await fetch(`${API}${path}`, {
      method: init.method || 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => ({}));
    return { ok: res.ok && !(Array.isArray(data?.errors) && data.errors.length), status: res.status, data };
  };
  let r = await send(key());
  if (r.status === 401 || r.status === 403) r = await send(`Bearer ${key()}`);
  return r;
}

export interface StartCallInput {
  to: string;
  task: string;
  firstSentence?: string;
  voice?: string;
  language?: string;
  webhookUrl?: string;
  contextUrl?: string;
  maxMinutes?: number;
}

/** Lance un appel sortant. Retourne l'id Bland ou une erreur lisible. */
export async function startCall(input: StartCallInput): Promise<{ ok: true; callId: string } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    phone_number: input.to,
    task: input.task,
    voice: input.voice || callVoice(input.language),
    wait_for_greeting: true,
    record: true,
    language: input.language || 'fr',
    max_duration: Math.max(1, Math.min(input.maxMinutes || 10, 30)),
  };
  if (input.firstSentence) body.first_sentence = input.firstSentence;
  if (fromNumber()) body.from = fromNumber();
  // Webhook + événements en direct : seulement si Bland peut nous joindre (https).
  if (input.webhookUrl && /^https:\/\//.test(input.webhookUrl)) {
    body.webhook = input.webhookUrl;
    body.webhook_events = ['call', 'dynamic_data'];
  }
  // Consignes en direct : relues par Bland avant CHAQUE réponse (cache:false).
  if (input.contextUrl && /^https:\/\//.test(input.contextUrl)) {
    body.dynamic_data = [{
      url: input.contextUrl,
      method: 'GET',
      cache: false,
      response_data: [{
        name: 'supervisor_instructions',
        data: '$.instructions',
        context: 'Consignes en direct du superviseur humain (prioritaires, à appliquer immédiatement)',
      }],
    }];
  }
  try {
    const r = await bland('/calls', { method: 'POST', body });
    if (!r.ok) return { ok: false, error: apiError(r.data, r.status) };
    const callId = r.data?.call_id || r.data?.id;
    if (!callId) return { ok: false, error: 'Réponse Bland sans call_id' };
    return { ok: true, callId: String(callId) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export interface BlandTranscriptLine { id: string; who: 'ai' | 'contact' | 'system'; text: string; at: number }
export interface BlandCallState {
  live: boolean;
  ended: boolean;
  error?: string;
  recordingUrl?: string;
  summary?: string;
  lines: BlandTranscriptLine[];
}

/** Lit l'état d'un appel (statut + transcription accumulée). */
export async function readCall(callId: string): Promise<BlandCallState | null> {
  try {
    const r = await bland(`/calls/${encodeURIComponent(callId)}`);
    if (!r.ok) return null;
    return parseCallPayload(r.data);
  } catch {
    return null;
  }
}

/** Convertit un objet appel Bland (GET /calls/:id ou webhook de fin) en état. */
export function parseCallPayload(d: any): BlandCallState {
  // `status` et `queue_status` sont lus séparément : Bland peut renvoyer
  // queue_status "started" ET status "completed" pour un appel déjà coupé.
  const END = ['complete', 'completed', 'ended', 'failed', 'error', 'no-answer', 'busy', 'canceled', 'cancelled'];
  const st = String(d?.status || '').toLowerCase();
  const q = String(d?.queue_status || '').toLowerCase();
  const ended = !!d?.completed || END.includes(st) || END.includes(q);
  const LIVE = ['started', 'in-progress', 'in_progress'];
  const live = !ended && (LIVE.includes(q) || LIVE.includes(st));
  const lines: BlandTranscriptLine[] = (Array.isArray(d?.transcripts) ? d.transcripts : [])
    .map((t: any, i: number) => {
      const u = String(t?.user || '').toLowerCase();
      const who: BlandTranscriptLine['who'] = u === 'user' ? 'contact' : u === 'agent-action' ? 'system' : 'ai';
      const at = t?.created_at ? Date.parse(t.created_at) : Date.now();
      return { id: String(t?.id ?? `i${i}`), who, text: String(t?.text || '').trim(), at: Number.isFinite(at) ? at : Date.now() };
    })
    .filter((l: BlandTranscriptLine) => l.text);
  return {
    live,
    ended,
    error: d?.error_message ? String(d.error_message) : undefined,
    recordingUrl: d?.recording_url ? String(d.recording_url) : undefined,
    summary: d?.summary ? String(d.summary) : undefined,
    lines,
  };
}

/** Raccroche un appel en cours. */
export async function stopCall(callId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await bland(`/calls/${encodeURIComponent(callId)}/stop`, { method: 'POST' });
    return r.ok ? { ok: true } : { ok: false, error: apiError(r.data, r.status) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * URL WebSocket d'écoute en direct (audio PCM 16 kHz mono, toutes voix mêlées).
 * Exige `live_listen_enabled` côté organisation Bland et un appel actif.
 */
export async function listenUrl(callId: string): Promise<{ ok: true; url: string } | { ok: false; error: string; code?: string }> {
  try {
    const r = await bland(`/calls/${encodeURIComponent(callId)}/listen`, { method: 'POST' });
    const url = r.data?.data?.url || r.data?.url;
    if (!r.ok || !url) {
      const err = apiError(r.data, r.status);
      return { ok: false, error: err, code: /INVALID_ORG_PREFERENCES|live_listen/i.test(err) ? 'listen_disabled' : undefined };
    }
    return { ok: true, url: String(url) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Envoie un SMS. Retourne l'id de conversation Bland quand il est fourni. */
export async function sendSmsMessage(input: { to: string; body: string; webhookUrl?: string; newConversation?: boolean }): Promise<
  { ok: true; messageId?: string; conversationId?: string } | { ok: false; error: string }
> {
  const body: Record<string, unknown> = { user_number: input.to, agent_number: fromNumber(), agent_message: input.body };
  if (input.webhookUrl && /^https:\/\//.test(input.webhookUrl)) body.webhook = input.webhookUrl;
  if (input.newConversation) body.new_conversation = true;
  try {
    const r = await bland('/sms/send', { method: 'POST', body });
    if (!r.ok) return { ok: false, error: apiError(r.data, r.status) };
    const d = r.data?.data || r.data || {};
    return { ok: true, messageId: d.message_id ? String(d.message_id) : undefined, conversationId: d.conversation_id ? String(d.conversation_id) : undefined };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export interface BlandSmsMessage { id: string; direction: 'in' | 'out'; body: string; status: string; at: number }

/** Relit une conversation SMS (messages des deux côtés). */
export async function readSmsConversation(conversationId: string): Promise<BlandSmsMessage[] | null> {
  try {
    const r = await bland(`/sms/conversations/${encodeURIComponent(conversationId)}`);
    if (!r.ok) return null;
    const msgs = r.data?.data?.messages || r.data?.messages || [];
    return (Array.isArray(msgs) ? msgs : []).map((m: any, i: number) => {
      const at = m?.created_at ? Date.parse(m.created_at) : Date.now();
      return {
        id: String(m?.id ?? m?.message_id ?? `i${i}`),
        direction: String(m?.sender || '').toUpperCase() === 'USER' ? 'in' as const : 'out' as const,
        body: String(m?.message || m?.body || ''),
        status: String(m?.status || ''),
        at: Number.isFinite(at) ? at : Date.now(),
      };
    }).filter((m: BlandSmsMessage) => m.body);
  } catch {
    return null;
  }
}

export interface InboundConfigInput {
  number: string;
  prompt: string;
  language?: string;
  voice?: string;
  webhookUrl?: string;
  contextUrl?: string;
  maxMinutes?: number;
}

/**
 * Configure l'agent qui répond au numéro entrant (POST /v1/inbound/:number).
 * L'état de la ligne (HOLD / ANSWER / MESSAGE) et les consignes du
 * superviseur sont relus avant chaque réponse via dynamic_data (cache:false).
 * {{call_id}} / {{from}} sont des variables Bland : si elles ne sont pas
 * substituées, le serveur retombe sur le dernier appel entrant du projet.
 */
export async function configureInboundNumber(input: InboundConfigInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    voice: input.voice || callVoice(input.language),
    language: input.language || 'fr',
    record: true,
    max_duration: Math.max(1, Math.min(input.maxMinutes || 15, 30)),
  };
  if (input.webhookUrl && /^https:\/\//.test(input.webhookUrl)) {
    body.webhook = input.webhookUrl;
    body.webhook_events = ['call', 'dynamic_data'];
  }
  if (input.contextUrl && /^https:\/\//.test(input.contextUrl)) {
    body.dynamic_data = [{
      url: `${input.contextUrl}?call_id={{call_id}}&from={{from}}`,
      method: 'GET',
      cache: false,
      response_data: [
        { name: 'line_state', data: '$.line_state', context: 'État de la ligne : HOLD, ANSWER ou MESSAGE' },
        { name: 'supervisor_instructions', data: '$.instructions', context: 'Consignes en direct du superviseur humain (prioritaires)' },
      ],
    }];
  }
  try {
    const r = await bland(`/inbound/${encodeURIComponent(input.number)}`, { method: 'POST', body });
    return r.ok ? { ok: true } : { ok: false, error: apiError(r.data, r.status) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
