// ─── Conversations SMS (popup du chat + panneau de droite) ──────────────────
//
// Un fil = une entreprise × un numéro. Chaque SMS envoyé par l'IA ou par
// l'utilisateur, et chaque réponse reçue, est une ligne `sms_messages`.
// Réel : Bland /v1/sms/send, réponses reçues par webhook et relecture de la
// conversation Bland. Simulation (numéros d'exemple, CALLS_FORCE_SIM) : envoi
// marqué « simulé » et le contact répond tout seul (généré par l'IA). Sans
// numéro Bland, rien n'est simulé : le SMS est marqué en échec avec la raison.

import {
  addSmsMessage, countOutboundSince, findThread, getThread, getThreadByHook, hasSimilarMessage, insertThread,
  listSmsMessages, newId, newToken, touchThread, updateSmsMessage,
  type SmsMessage, type SmsThreadRow,
} from './store';
import { blandSmsReady, readSmsConversation, sendSmsMessage, smsModeFor } from './bland';
import { simSmsReply } from './brain';
import { normalizePhone } from './live-calls';

export const MAX_SMS_PER_DAY = 60;
const STOP_RE = /^\s*(stop|arr[eê]t(er)?|unsubscribe|d[ée]sabonn?e?r?)\b/i;

/** Indicateur « en train d'écrire… » (simulation uniquement, par fil). */
const typingUntil = new Map<string, number>();

export function publicThread(t: SmsThreadRow, messages: SmsMessage[]) {
  return {
    thread: {
      id: t.id,
      companyId: t.companyId,
      mode: t.mode,
      phone: t.phone,
      contactName: t.contactName,
      context: t.context,
      optedOut: !!t.optedOut,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      typing: (typingUntil.get(t.id) || 0) > Date.now(),
    },
    messages: messages.map((m) => ({ id: m.id, direction: m.direction, body: m.body, status: m.status, error: m.error, createdAt: m.createdAt })),
  };
}

export type SendResult = { ok: true; thread: SmsThreadRow; message: SmsMessage } | { ok: false; error: string; code: string };

/** Crée le fil si besoin puis envoie le premier SMS. */
export async function startSmsThread(input: {
  companyId: string; userId: string; to: unknown; contactName?: unknown; message: unknown; context?: unknown; origin?: string;
}): Promise<SendResult> {
  const phone = normalizePhone(input.to);
  if (!phone) return { ok: false, error: 'Numéro invalide (format international attendu, ex. +33612345678).', code: 'bad_phone' };
  const contactName = String(input.contactName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  const context = String(input.context ?? '').replace(/\s+/g, ' ').trim().slice(0, 600) || null;
  let thread = await findThread(input.companyId, phone);
  if (!thread) {
    await insertThread({
      id: newId('st'), companyId: input.companyId, userId: input.userId, mode: smsModeFor(phone).real ? 'bland' : 'sim',
      phone, contactName, context, hookToken: newToken(), createdAt: Date.now(),
    });
    thread = await findThread(input.companyId, phone);
    if (!thread) return { ok: false, error: 'Fil SMS introuvable après création', code: 'internal' };
  } else if (contactName && !thread.contactName) {
    await touchThread(thread.id, { contactName });
  }
  return sendInThread(thread, input.message, input.origin);
}

export async function sendInThread(thread: SmsThreadRow, rawBody: unknown, origin?: string): Promise<SendResult> {
  const body = String(rawBody ?? '').trim().slice(0, 1200);
  if (!body) return { ok: false, error: 'Message vide', code: 'empty' };
  if (thread.optedOut) return { ok: false, error: 'Ce contact a répondu STOP : plus aucun SMS ne peut lui être envoyé.', code: 'opted_out' };
  const sent = await countOutboundSince(thread.companyId, Date.now() - 24 * 3600_000);
  if (sent >= MAX_SMS_PER_DAY) return { ok: false, error: `Plafond atteint : ${MAX_SMS_PER_DAY} SMS par jour et par projet.`, code: 'daily_cap' };

  // Le mode suit les clés ACTUELLES : un fil démarré en simulation passe en
  // réel dès que la clé est ajoutée (et inversement si elle est retirée).
  // Plus de fausse réponse générée par l'IA hors numéros d'exemple : sans
  // numéro Bland, le SMS est marqué « échec » avec la raison, c'est tout.
  const how = smsModeFor(thread.phone);
  const real = how.real;
  if (!how.real && !how.sim) {
    const failed = await addSmsMessage({ threadId: thread.id, direction: 'out', body, status: 'failed', extId: null, error: how.reason });
    if (!failed) return { ok: false, error: 'Enregistrement impossible', code: 'internal' };
    return { ok: true, thread, message: failed };
  }
  if (real && thread.mode !== 'bland') await touchThread(thread.id, { mode: 'bland' });
  const msg = await addSmsMessage({ threadId: thread.id, direction: 'out', body, status: real ? 'sending' : 'simulated', extId: null, error: null });
  if (!msg) return { ok: false, error: 'Enregistrement impossible', code: 'internal' };

  if (real) {
    const o = (origin || '').replace(/\/$/, '');
    const r = await sendSmsMessage({ to: thread.phone, body, webhookUrl: o ? `${o}/api/hooks/sms/${thread.hookToken}` : undefined });
    if (!r.ok) {
      await updateSmsMessage(msg.id, { status: 'failed', error: r.error });
      return { ok: true, thread, message: { ...msg, status: 'failed', error: r.error } };
    }
    await updateSmsMessage(msg.id, { status: 'sent', extId: r.messageId || null });
    if (r.conversationId) await touchThread(thread.id, { conversationId: r.conversationId });
    return { ok: true, thread, message: { ...msg, status: 'sent' } };
  }

  void simulateReply(thread.id);
  return { ok: true, thread, message: msg };
}

const simPending = new Set<string>();
async function simulateReply(threadId: string) {
  if (simPending.has(threadId)) return;
  simPending.add(threadId);
  try {
    await new Promise((r) => setTimeout(r, 1800));
    typingUntil.set(threadId, Date.now() + 9000);
    const thread = await getThread(threadId);
    if (!thread) return;
    const history = (await listSmsMessages(threadId)).map((m) => ({ direction: m.direction, body: m.body }));
    const [reply] = await Promise.all([
      simSmsReply({ contactName: thread.contactName, context: thread.context, history }),
      new Promise((r) => setTimeout(r, 2600)),
    ]);
    typingUntil.delete(threadId);
    await addSmsMessage({ threadId, direction: 'in', body: reply, status: 'received', extId: null, error: null });
    if (STOP_RE.test(reply)) await touchThread(threadId, { optedOut: true });
  } catch (e: any) {
    console.error('[sms] simulated reply failed:', e?.message);
  } finally {
    typingUntil.delete(threadId);
    simPending.delete(threadId);
  }
}

/** Relit la conversation Bland (au plus toutes les 4 s) pour récupérer les réponses. */
export async function syncThread(thread: SmsThreadRow): Promise<void> {
  if (thread.mode !== 'bland' || !thread.conversationId || !blandSmsReady()) return;
  if (Date.now() - thread.lastSyncAt < 4000) return;
  await touchThread(thread.id, { lastSyncAt: Date.now() });
  const remote = await readSmsConversation(thread.conversationId);
  if (!remote) return;
  for (const m of remote) {
    const ext = `b:${m.id}`;
    // Un SMS envoyé d'ici existe déjà sans id Bland : on le relie au lieu de le dupliquer.
    const local = await hasSimilarMessage(thread.id, m.direction, m.body, m.at);
    if (local) { await updateSmsMessage(local, { extId: ext, status: m.direction === 'out' ? normStatus(m.status) : undefined }); continue; }
    await addSmsMessage({ threadId: thread.id, direction: m.direction, body: m.body, status: m.direction === 'in' ? 'received' : normStatus(m.status), extId: ext, error: null, createdAt: m.at });
    if (m.direction === 'in' && STOP_RE.test(m.body)) await touchThread(thread.id, { optedOut: true });
  }
}

const normStatus = (s: string) => /deliver/i.test(s) ? 'delivered' : /fail|undeliver|error/i.test(s) ? 'failed' : 'sent';

/** Webhook Bland SMS : réponse entrante ou statut de livraison. */
export async function handleSmsHook(token: string, body: any): Promise<number> {
  const thread = await getThreadByHook(token);
  if (!thread) return 404;
  const d = body?.data || body || {};
  if (d.conversation_id) await touchThread(thread.id, { conversationId: String(d.conversation_id) });
  const text = String(d.message ?? d.body ?? d.text ?? d.user_message ?? '').trim();
  const sender = String(d.sender ?? d.direction ?? d.from_type ?? '').toUpperCase();
  const inbound = sender === 'USER' || sender === 'INBOUND' || (!!d.user_message && !d.agent_message);
  if (text && inbound) {
    const ext = d.message_id || d.id ? `b:${d.message_id || d.id}` : null;
    await addSmsMessage({ threadId: thread.id, direction: 'in', body: text, status: 'received', extId: ext, error: null });
    if (STOP_RE.test(text)) await touchThread(thread.id, { optedOut: true });
  }
  return 200;
}

export { getThread, listSmsMessages };
