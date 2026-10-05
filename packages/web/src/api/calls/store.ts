// ─── Stockage : appels en direct + fils SMS ─────────────────────────────────
//
// Tables créées au démarrage (CREATE TABLE IF NOT EXISTS, pas de db:push).
// Tout passe par le client libSQL brut : une seule source de vérité pour la
// carte d'appel du chat, le flux SSE, les webhooks Bland et le panneau SMS —
// ce qui marche aussi quand le webhook arrive sur une autre instance que
// celle qui sert le flux.

import { randomBytes } from 'node:crypto';
import { client } from '../database/client';

export type CallStatus = 'dialing' | 'ringing' | 'live' | 'ended' | 'failed' | 'canceled';
/** Appel entrant : pending = ça sonne chez le propriétaire (popup), auto = l'IA
 *  décroche seule (mode auto), accepted / declined = choix du propriétaire,
 *  timeout = personne n'a répondu à la popup → l'IA décroche quand même. */
export type InboundState = 'pending' | 'auto' | 'accepted' | 'declined' | 'timeout';
/** ai = l'IA au téléphone · contact = l'interlocuteur · user = consigne du superviseur ·
 *  note = réponse PRIVÉE de l'IA au superviseur · directive = consigne transmise à l'IA
 *  au téléphone · system = statut / info. */
export type CallEventKind = 'ai' | 'contact' | 'user' | 'note' | 'directive' | 'system';

export interface LiveCallRow {
  id: string;
  companyId: string;
  userId: string;
  mode: 'bland' | 'sim';
  providerCallId: string | null;
  phone: string;
  contactName: string | null;
  goal: string;
  language: string;
  status: CallStatus;
  hookToken: string;
  hookSeen: number;
  error: string | null;
  summary: string | null;
  recordingUrl: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
  /** out = l'IA appelle quelqu'un · in = quelqu'un appelle le numéro du projet. */
  direction: 'out' | 'in';
  inboundState: InboundState | null;
  /** Appel entrant en attente : au-delà, l'IA décroche toute seule. */
  ringUntil: number | null;
}

export interface CallEvent { id: number; kind: CallEventKind; text: string; at: number }

export interface SmsThreadRow {
  id: string;
  companyId: string;
  userId: string;
  mode: 'bland' | 'sim';
  phone: string;
  contactName: string | null;
  context: string | null;
  conversationId: string | null;
  hookToken: string;
  lastSyncAt: number;
  optedOut: number;
  createdAt: number;
  updatedAt: number;
}

export interface SmsMessage {
  id: string;
  threadId: string;
  direction: 'in' | 'out';
  body: string;
  status: string;
  extId: string | null;
  error: string | null;
  createdAt: number;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;
export const newToken = () => randomBytes(24).toString('base64url');

let ensured: Promise<void> | null = null;
export function ensureCallTables(): Promise<void> {
  if (ensured) return ensured;
  ensured = (async () => {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS live_calls (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        provider_call_id TEXT,
        phone TEXT NOT NULL,
        contact_name TEXT,
        goal TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'fr',
        status TEXT NOT NULL,
        hook_token TEXT NOT NULL,
        hook_seen INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        summary TEXT,
        recording_url TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        updated_at INTEGER NOT NULL
      )`);
    await client.execute(`CREATE INDEX IF NOT EXISTS live_calls_company_idx ON live_calls (company_id)`);
    // Appels entrants (2026-10-01) : colonnes ajoutées après coup, ALTER idempotent.
    for (const ddl of [
      `ALTER TABLE live_calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'out'`,
      `ALTER TABLE live_calls ADD COLUMN inbound_state TEXT`,
      `ALTER TABLE live_calls ADD COLUMN ring_until INTEGER`,
    ]) {
      await client.execute(ddl).catch((e: any) => { if (!/duplicate column/i.test(String(e?.message || e))) throw e; });
    }
    await client.execute(`CREATE INDEX IF NOT EXISTS live_calls_user_dir_idx ON live_calls (user_id, direction, status)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS live_calls_provider_idx ON live_calls (provider_call_id)`);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS inbound_lines (
        company_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        phone_number TEXT,
        hook_token TEXT NOT NULL,
        configured_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS inbound_lines_hook_idx ON inbound_lines (hook_token)`);
    await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS live_calls_hook_idx ON live_calls (hook_token)`);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS live_call_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        ext_id TEXT,
        created_at INTEGER NOT NULL
      )`);
    await client.execute(`CREATE INDEX IF NOT EXISTS live_call_events_call_idx ON live_call_events (call_id, id)`);
    await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS live_call_events_ext_idx ON live_call_events (call_id, ext_id)`);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS sms_threads (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        phone TEXT NOT NULL,
        contact_name TEXT,
        context TEXT,
        conversation_id TEXT,
        hook_token TEXT NOT NULL,
        last_sync_at INTEGER NOT NULL DEFAULT 0,
        opted_out INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await client.execute(`CREATE INDEX IF NOT EXISTS sms_threads_company_idx ON sms_threads (company_id, phone)`);
    await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS sms_threads_hook_idx ON sms_threads (hook_token)`);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS sms_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        ext_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      )`);
    await client.execute(`CREATE INDEX IF NOT EXISTS sms_messages_thread_idx ON sms_messages (thread_id, created_at)`);
    await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_ext_idx ON sms_messages (thread_id, ext_id)`);
  })().catch((e) => { ensured = null; throw e; });
  return ensured;
}

// ── Appels ──────────────────────────────────────────────────────────────────

const callFromRow = (r: any): LiveCallRow => ({
  id: String(r.id),
  companyId: String(r.company_id),
  userId: String(r.user_id),
  mode: r.mode === 'bland' ? 'bland' : 'sim',
  providerCallId: r.provider_call_id ?? null,
  phone: String(r.phone),
  contactName: r.contact_name ?? null,
  goal: String(r.goal),
  language: String(r.language || 'fr'),
  status: String(r.status) as CallStatus,
  hookToken: String(r.hook_token),
  hookSeen: Number(r.hook_seen || 0),
  error: r.error ?? null,
  summary: r.summary ?? null,
  recordingUrl: r.recording_url ?? null,
  createdAt: Number(r.created_at),
  startedAt: r.started_at == null ? null : Number(r.started_at),
  endedAt: r.ended_at == null ? null : Number(r.ended_at),
  updatedAt: Number(r.updated_at),
  direction: r.direction === 'in' ? 'in' : 'out',
  inboundState: (r.inbound_state ?? null) as InboundState | null,
  ringUntil: r.ring_until == null ? null : Number(r.ring_until),
});

export type NewCallRow = Omit<LiveCallRow, 'hookSeen' | 'error' | 'summary' | 'recordingUrl' | 'startedAt' | 'endedAt' | 'updatedAt' | 'direction' | 'inboundState' | 'ringUntil'>
  & Partial<Pick<LiveCallRow, 'direction' | 'inboundState' | 'ringUntil'>>;

export async function insertCall(row: NewCallRow): Promise<void> {
  await ensureCallTables();
  await client.execute({
    sql: `INSERT INTO live_calls (id, company_id, user_id, mode, provider_call_id, phone, contact_name, goal, language, status, hook_token, created_at, updated_at, direction, inbound_state, ring_until)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [row.id, row.companyId, row.userId, row.mode, row.providerCallId, row.phone, row.contactName, row.goal, row.language, row.status, row.hookToken, row.createdAt, row.createdAt,
      row.direction || 'out', row.inboundState ?? null, row.ringUntil ?? null],
  });
}

export async function getCallByProviderId(providerCallId: string): Promise<LiveCallRow | null> {
  if (!providerCallId) return null;
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM live_calls WHERE provider_call_id = ? LIMIT 1`, args: [providerCallId] });
  return r.rows[0] ? callFromRow(r.rows[0]) : null;
}

/** Appels entrants qui sonnent encore chez cet utilisateur (popup). */
export async function listRingingInbound(userId: string, isAdmin = false): Promise<LiveCallRow[]> {
  await ensureCallTables();
  const r = await client.execute({
    sql: `SELECT * FROM live_calls WHERE direction = 'in' AND inbound_state = 'pending'
            AND status NOT IN ('ended','failed','canceled') AND created_at >= ?
            ${isAdmin ? '' : 'AND user_id = ?'} ORDER BY created_at DESC LIMIT 5`,
    args: isAdmin ? [Date.now() - 3 * 60_000] : [Date.now() - 3 * 60_000, userId],
  });
  return r.rows.map(callFromRow);
}

/** Appels entrants récemment décidés (auto / répondu / refusé / délai) : le
 *  client s'en sert pour rafraîchir le chat du projet concerné. */
export async function listRecentDecidedInbound(userId: string, sinceMs = 3 * 60_000): Promise<LiveCallRow[]> {
  await ensureCallTables();
  const r = await client.execute({
    sql: `SELECT * FROM live_calls WHERE direction = 'in' AND user_id = ? AND inbound_state IS NOT NULL
            AND inbound_state != 'pending' AND created_at >= ? ORDER BY created_at DESC LIMIT 10`,
    args: [userId, Date.now() - sinceMs],
  });
  return r.rows.map(callFromRow);
}

/** Derniers appels entrants d'un projet (onglet Téléphone). */
export async function listInboundCalls(companyId: string, limit = 20): Promise<LiveCallRow[]> {
  await ensureCallTables();
  const r = await client.execute({
    sql: `SELECT * FROM live_calls WHERE company_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT ?`,
    args: [companyId, limit],
  });
  return r.rows.map(callFromRow);
}

/** Change l'état d'un appel entrant SEULEMENT s'il est encore « pending » (une seule décision gagne). */
export async function decideInbound(id: string, state: Exclude<InboundState, 'pending'>): Promise<boolean> {
  await ensureCallTables();
  const r = await client.execute({
    sql: `UPDATE live_calls SET inbound_state = ?, updated_at = ? WHERE id = ? AND inbound_state = 'pending' AND status NOT IN ('ended','failed','canceled')`,
    args: [state, Date.now(), id],
  });
  if (r.rowsAffected > 0) notify(id);
  return r.rowsAffected > 0;
}

// ── Lignes entrantes (numéro Bland d'un projet) ─────────────────────────────

export interface InboundLineRow {
  companyId: string;
  userId: string;
  phoneNumber: string | null;
  hookToken: string;
  configuredAt: number | null;
  lastError: string | null;
}

const lineFromRow = (r: any): InboundLineRow => ({
  companyId: String(r.company_id),
  userId: String(r.user_id),
  phoneNumber: r.phone_number ?? null,
  hookToken: String(r.hook_token),
  configuredAt: r.configured_at == null ? null : Number(r.configured_at),
  lastError: r.last_error ?? null,
});

export async function getInboundLine(companyId: string): Promise<InboundLineRow | null> {
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM inbound_lines WHERE company_id = ?`, args: [companyId] });
  return r.rows[0] ? lineFromRow(r.rows[0]) : null;
}

export async function getInboundLineByHook(token: string): Promise<InboundLineRow | null> {
  if (!token || token.length < 20) return null;
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM inbound_lines WHERE hook_token = ?`, args: [token] });
  return r.rows[0] ? lineFromRow(r.rows[0]) : null;
}

/** Crée la ligne si besoin (jeton stable), puis applique le patch. */
export async function upsertInboundLine(companyId: string, userId: string, patch: { phoneNumber?: string | null; configuredAt?: number | null; lastError?: string | null } = {}): Promise<InboundLineRow> {
  await ensureCallTables();
  const now = Date.now();
  await client.execute({
    sql: `INSERT OR IGNORE INTO inbound_lines (company_id, user_id, hook_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: [companyId, userId, newToken(), now, now],
  });
  const sets: string[] = ['updated_at = ?'];
  const args: any[] = [now];
  if (patch.phoneNumber !== undefined) { sets.push('phone_number = ?'); args.push(patch.phoneNumber); }
  if (patch.configuredAt !== undefined) { sets.push('configured_at = ?'); args.push(patch.configuredAt); }
  if (patch.lastError !== undefined) { sets.push('last_error = ?'); args.push(patch.lastError); }
  args.push(companyId);
  await client.execute({ sql: `UPDATE inbound_lines SET ${sets.join(', ')} WHERE company_id = ?`, args });
  return (await getInboundLine(companyId))!;
}

export async function getCall(id: string): Promise<LiveCallRow | null> {
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM live_calls WHERE id = ?`, args: [id] });
  return r.rows[0] ? callFromRow(r.rows[0]) : null;
}

export async function getCallByHook(token: string): Promise<LiveCallRow | null> {
  if (!token || token.length < 20) return null;
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM live_calls WHERE hook_token = ?`, args: [token] });
  return r.rows[0] ? callFromRow(r.rows[0]) : null;
}

const CALL_COLS: Record<string, string> = {
  providerCallId: 'provider_call_id', status: 'status', hookSeen: 'hook_seen', error: 'error',
  summary: 'summary', recordingUrl: 'recording_url', startedAt: 'started_at', endedAt: 'ended_at',
};

export async function updateCall(id: string, patch: Partial<Pick<LiveCallRow, 'providerCallId' | 'status' | 'hookSeen' | 'error' | 'summary' | 'recordingUrl' | 'startedAt' | 'endedAt'>>): Promise<void> {
  const sets: string[] = [];
  const args: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = CALL_COLS[k];
    if (!col || v === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  args.push(Date.now(), id);
  await client.execute({ sql: `UPDATE live_calls SET ${sets.join(', ')} WHERE id = ?`, args });
  notify(id);
}

/** Passe un appel à un état terminal UNE seule fois (pas de retour en arrière). */
export async function finishCall(id: string, status: 'ended' | 'failed' | 'canceled', extra: { error?: string | null; summary?: string | null; recordingUrl?: string | null } = {}): Promise<boolean> {
  const r = await client.execute({
    sql: `UPDATE live_calls SET status = ?, ended_at = ?, updated_at = ?,
            error = COALESCE(?, error), summary = COALESCE(?, summary), recording_url = COALESCE(?, recording_url)
          WHERE id = ? AND status NOT IN ('ended','failed','canceled')`,
    args: [status, Date.now(), Date.now(), extra.error ?? null, extra.summary ?? null, extra.recordingUrl ?? null, id],
  });
  notify(id);
  return r.rowsAffected > 0;
}

export async function addCallEvent(callId: string, kind: CallEventKind, text: string, extId?: string | null, at?: number): Promise<boolean> {
  const t = String(text || '').trim();
  if (!t) return false;
  await ensureCallTables();
  const r = await client.execute({
    sql: `INSERT OR IGNORE INTO live_call_events (call_id, kind, text, ext_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: [callId, kind, t.slice(0, 4000), extId ?? null, at ?? Date.now()],
  });
  if (r.rowsAffected > 0) notify(callId);
  return r.rowsAffected > 0;
}

export async function listCallEvents(callId: string, afterId = 0): Promise<CallEvent[]> {
  await ensureCallTables();
  const r = await client.execute({
    sql: `SELECT id, kind, text, created_at FROM live_call_events WHERE call_id = ? AND id > ? ORDER BY id ASC LIMIT 500`,
    args: [callId, afterId],
  });
  return r.rows.map((x: any) => ({ id: Number(x.id), kind: String(x.kind) as CallEventKind, text: String(x.text), at: Number(x.created_at) }));
}

// ── Réveil des flux SSE (même instance) ─────────────────────────────────────
// Les flux relisent aussi la base à intervalle fixe : ce réveil n'est qu'une
// accélération, jamais la seule source.
const waiters = new Map<string, Set<() => void>>();
export function notify(key: string) {
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  for (const fn of set) fn();
}
export function waitFor(key: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const set = waiters.get(key) || new Set();
    const done = () => { clearTimeout(t); set.delete(done); resolve(); };
    const t = setTimeout(done, ms);
    set.add(done);
    waiters.set(key, set);
  });
}

// ── SMS ─────────────────────────────────────────────────────────────────────

const threadFromRow = (r: any): SmsThreadRow => ({
  id: String(r.id),
  companyId: String(r.company_id),
  userId: String(r.user_id),
  mode: r.mode === 'bland' ? 'bland' : 'sim',
  phone: String(r.phone),
  contactName: r.contact_name ?? null,
  context: r.context ?? null,
  conversationId: r.conversation_id ?? null,
  hookToken: String(r.hook_token),
  lastSyncAt: Number(r.last_sync_at || 0),
  optedOut: Number(r.opted_out || 0),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const msgFromRow = (r: any): SmsMessage => ({
  id: String(r.id),
  threadId: String(r.thread_id),
  direction: r.direction === 'in' ? 'in' : 'out',
  body: String(r.body),
  status: String(r.status),
  extId: r.ext_id ?? null,
  error: r.error ?? null,
  createdAt: Number(r.created_at),
});

/** Un fil par (entreprise, numéro) : un 2e SMS au même contact rejoint le fil. */
export async function findThread(companyId: string, phone: string): Promise<SmsThreadRow | null> {
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM sms_threads WHERE company_id = ? AND phone = ? ORDER BY created_at DESC LIMIT 1`, args: [companyId, phone] });
  return r.rows[0] ? threadFromRow(r.rows[0]) : null;
}

export async function insertThread(row: Omit<SmsThreadRow, 'lastSyncAt' | 'updatedAt' | 'conversationId' | 'optedOut'>): Promise<void> {
  await ensureCallTables();
  await client.execute({
    sql: `INSERT INTO sms_threads (id, company_id, user_id, mode, phone, contact_name, context, hook_token, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [row.id, row.companyId, row.userId, row.mode, row.phone, row.contactName, row.context, row.hookToken, row.createdAt, row.createdAt],
  });
}

export async function getThread(id: string): Promise<SmsThreadRow | null> {
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM sms_threads WHERE id = ?`, args: [id] });
  return r.rows[0] ? threadFromRow(r.rows[0]) : null;
}

export async function getThreadByHook(token: string): Promise<SmsThreadRow | null> {
  if (!token || token.length < 20) return null;
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM sms_threads WHERE hook_token = ?`, args: [token] });
  return r.rows[0] ? threadFromRow(r.rows[0]) : null;
}

export async function touchThread(id: string, patch: { conversationId?: string | null; lastSyncAt?: number; contactName?: string | null; optedOut?: boolean; mode?: 'bland' | 'sim' } = {}): Promise<void> {
  await client.execute({
    sql: `UPDATE sms_threads SET updated_at = ?, conversation_id = COALESCE(?, conversation_id),
            last_sync_at = COALESCE(?, last_sync_at), contact_name = COALESCE(contact_name, ?),
            opted_out = MAX(opted_out, ?), mode = COALESCE(?, mode) WHERE id = ?`,
    args: [Date.now(), patch.conversationId ?? null, patch.lastSyncAt ?? null, patch.contactName ?? null, patch.optedOut ? 1 : 0, patch.mode ?? null, id],
  });
}

/** Messages envoyés par une entreprise depuis `since` (plafond quotidien). */
export async function countOutboundSince(companyId: string, since: number): Promise<number> {
  await ensureCallTables();
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM sms_messages m JOIN sms_threads t ON t.id = m.thread_id
          WHERE t.company_id = ? AND m.direction = 'out' AND m.created_at >= ?`,
    args: [companyId, since],
  });
  return Number((r.rows[0] as any)?.n || 0);
}

/** Appels lancés par une entreprise depuis `since`, et appels encore actifs d'un utilisateur. */
export async function callQuota(companyId: string, userId: string, since: number): Promise<{ today: number; active: number }> {
  await ensureCallTables();
  const a = await client.execute({ sql: `SELECT COUNT(*) AS n FROM live_calls WHERE company_id = ? AND direction = 'out' AND created_at >= ?`, args: [companyId, since] });
  const b = await client.execute({ sql: `SELECT COUNT(*) AS n FROM live_calls WHERE user_id = ? AND direction = 'out' AND status IN ('dialing','ringing','live') AND created_at >= ?`, args: [userId, Date.now() - 45 * 60_000] });
  return { today: Number((a.rows[0] as any)?.n || 0), active: Number((b.rows[0] as any)?.n || 0) };
}

export async function addSmsMessage(m: Omit<SmsMessage, 'id' | 'createdAt'> & { createdAt?: number }): Promise<SmsMessage | null> {
  await ensureCallTables();
  const id = newId('sm');
  const createdAt = m.createdAt ?? Date.now();
  const r = await client.execute({
    sql: `INSERT OR IGNORE INTO sms_messages (id, thread_id, direction, body, status, ext_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, m.threadId, m.direction, m.body.slice(0, 1600), m.status, m.extId, m.error, createdAt],
  });
  if (!r.rowsAffected) return null;
  await touchThread(m.threadId);
  notify(`sms:${m.threadId}`);
  return { ...m, id, createdAt };
}

export async function updateSmsMessage(id: string, patch: { status?: string; extId?: string | null; error?: string | null }): Promise<void> {
  await client.execute({
    sql: `UPDATE sms_messages SET status = COALESCE(?, status), ext_id = COALESCE(?, ext_id), error = COALESCE(?, error) WHERE id = ?`,
    args: [patch.status ?? null, patch.extId ?? null, patch.error ?? null, id],
  });
}

export async function listSmsMessages(threadId: string): Promise<SmsMessage[]> {
  await ensureCallTables();
  const r = await client.execute({ sql: `SELECT * FROM sms_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 500`, args: [threadId] });
  return r.rows.map(msgFromRow);
}

/** Message déjà connu sous ce texte/direction ? (dédoublonnage sync Bland ↔ local). */
export async function hasSimilarMessage(threadId: string, direction: 'in' | 'out', body: string, aroundMs: number, windowMs = 10 * 60_000): Promise<string | null> {
  const r = await client.execute({
    sql: `SELECT id FROM sms_messages WHERE thread_id = ? AND direction = ? AND body = ? AND ext_id IS NULL AND ABS(created_at - ?) < ? LIMIT 1`,
    args: [threadId, direction, body.slice(0, 1600), aroundMs, windowMs],
  });
  return r.rows[0] ? String((r.rows[0] as any).id) : null;
}
