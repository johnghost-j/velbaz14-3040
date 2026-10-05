// ─── Stockage des comptes publicitaires connectés (jetons CHIFFRÉS) ──────────
// Tables créées au démarrage (CREATE TABLE IF NOT EXISTS, pas de db:push).
// Colonne company_id → purgées automatiquement par gdpr.purgeCompanyData.

import { randomUUID } from 'node:crypto';
import { client } from '../database/client';
import { encryptSecret, decryptSecret } from '../secret-store';
import type { AdAccount, AdPage, AdProvider } from './providers';

let ready: Promise<void> | null = null;
export function ensureAdTables(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS ad_connections (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          external_user TEXT,
          access_token_enc TEXT NOT NULL,
          refresh_token_enc TEXT,
          token_expires_at INTEGER,
          accounts TEXT,
          selected_account_id TEXT,
          pages TEXT,
          selected_page_id TEXT,
          last_error TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        )`);
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ad_conn_company_provider_idx ON ad_connections (company_id, provider)`).catch(() => {});
      await client.execute(`
        CREATE TABLE IF NOT EXISTS ad_pushes (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          ad_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          account_id TEXT,
          external_id TEXT,
          external_url TEXT,
          status TEXT NOT NULL,
          detail TEXT,
          error TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )`);
      await client.execute(`CREATE INDEX IF NOT EXISTS ad_pushes_company_idx ON ad_pushes (company_id)`).catch(() => {});
    } catch (e: any) {
      ready = null;
      console.error('[ad-accounts] table init failed:', e?.message);
    }
  })();
  return ready;
}

export type AdConnection = {
  id: string;
  companyId: string;
  provider: AdProvider;
  externalUser: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  accounts: AdAccount[];
  selectedAccountId: string | null;
  pages: AdPage[];
  selectedPageId: string | null;
  lastError: string | null;
  createdAt: Date | null;
};

function parseList<T>(v: unknown): T[] {
  try { const x = JSON.parse(String(v || '[]')); return Array.isArray(x) ? x : []; } catch { return []; }
}
const toDate = (v: unknown) => (v == null || v === '' ? null : new Date(Number(v) * 1000));

function rowToConn(r: any): AdConnection | null {
  const accessToken = decryptSecret(r.access_token_enc);
  if (!accessToken) return null; // clé maître changée : la connexion est illisible
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    provider: String(r.provider) as AdProvider,
    externalUser: r.external_user ? String(r.external_user) : null,
    accessToken,
    refreshToken: r.refresh_token_enc ? decryptSecret(r.refresh_token_enc) : null,
    tokenExpiresAt: toDate(r.token_expires_at),
    accounts: parseList<AdAccount>(r.accounts),
    selectedAccountId: r.selected_account_id ? String(r.selected_account_id) : null,
    pages: parseList<AdPage>(r.pages),
    selectedPageId: r.selected_page_id ? String(r.selected_page_id) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: toDate(r.created_at),
  };
}

export async function listConnections(companyId: string): Promise<AdConnection[]> {
  await ensureAdTables();
  const res = await client.execute({ sql: `select * from ad_connections where company_id = ? order by provider`, args: [companyId] });
  return res.rows.map(rowToConn).filter(Boolean) as AdConnection[];
}

export async function getConnection(companyId: string, provider: AdProvider): Promise<AdConnection | null> {
  await ensureAdTables();
  const res = await client.execute({ sql: `select * from ad_connections where company_id = ? and provider = ? limit 1`, args: [companyId, provider] });
  return res.rows[0] ? rowToConn(res.rows[0]) : null;
}

const secs = (d?: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);

export async function saveConnection(input: {
  companyId: string;
  provider: AdProvider;
  externalUser?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  accounts: AdAccount[];
  pages?: AdPage[];
}): Promise<void> {
  await ensureAdTables();
  const prev = await getConnection(input.companyId, input.provider);
  const usable = input.accounts.filter((a) => !a.manager);
  // On garde le choix précédent s'il existe encore, sinon le seul compte possible.
  const selected = prev?.selectedAccountId && input.accounts.some((a) => a.id === prev.selectedAccountId)
    ? prev.selectedAccountId
    : (usable.length === 1 ? usable[0].id : null);
  const pages = input.pages || [];
  const page = prev?.selectedPageId && pages.some((p) => p.id === prev.selectedPageId)
    ? prev.selectedPageId
    : (pages.length === 1 ? pages[0].id : null);
  // Google ne renvoie le refresh_token qu'au premier consentement : on garde l'ancien.
  const refresh = input.refreshToken || prev?.refreshToken || null;
  await client.execute({
    sql: `insert into ad_connections (id, company_id, provider, external_user, access_token_enc, refresh_token_enc, token_expires_at, accounts, selected_account_id, pages, selected_page_id, last_error, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, unixepoch())
          on conflict(company_id, provider) do update set
            external_user = excluded.external_user, access_token_enc = excluded.access_token_enc,
            refresh_token_enc = excluded.refresh_token_enc, token_expires_at = excluded.token_expires_at,
            accounts = excluded.accounts, selected_account_id = excluded.selected_account_id,
            pages = excluded.pages, selected_page_id = excluded.selected_page_id,
            last_error = null, updated_at = unixepoch()`,
    args: [
      prev?.id || randomUUID(), input.companyId, input.provider, input.externalUser || null,
      encryptSecret(input.accessToken), refresh ? encryptSecret(refresh) : null, secs(input.tokenExpiresAt),
      JSON.stringify(input.accounts), selected, JSON.stringify(pages), page,
    ],
  });
}

export async function updateTokens(id: string, accessToken: string, refreshToken: string | null, expiresAt: Date | null): Promise<void> {
  await client.execute({
    sql: `update ad_connections set access_token_enc = ?, refresh_token_enc = coalesce(?, refresh_token_enc), token_expires_at = ?, updated_at = unixepoch() where id = ?`,
    args: [encryptSecret(accessToken), refreshToken ? encryptSecret(refreshToken) : null, secs(expiresAt), id],
  });
}

export async function setSelection(companyId: string, provider: AdProvider, patch: { accountId?: string | null; pageId?: string | null }): Promise<void> {
  await ensureAdTables();
  if (patch.accountId !== undefined) {
    await client.execute({ sql: `update ad_connections set selected_account_id = ?, updated_at = unixepoch() where company_id = ? and provider = ?`, args: [patch.accountId, companyId, provider] });
  }
  if (patch.pageId !== undefined) {
    await client.execute({ sql: `update ad_connections set selected_page_id = ?, updated_at = unixepoch() where company_id = ? and provider = ?`, args: [patch.pageId, companyId, provider] });
  }
}

export async function setLastError(id: string, error: string | null): Promise<void> {
  await client.execute({ sql: `update ad_connections set last_error = ?, updated_at = unixepoch() where id = ?`, args: [error, id] }).catch(() => {});
}

export async function deleteConnection(companyId: string, provider: AdProvider): Promise<boolean> {
  await ensureAdTables();
  const res = await client.execute({ sql: `delete from ad_connections where company_id = ? and provider = ?`, args: [companyId, provider] });
  return (res.rowsAffected || 0) > 0;
}

export type AdPush = {
  id: string; adId: string; provider: string; accountId: string | null;
  externalId: string | null; externalUrl: string | null; status: string;
  detail: any; error: string | null; createdAt: Date | null;
};

export async function recordPush(p: Omit<AdPush, 'id' | 'createdAt'> & { companyId: string }): Promise<string> {
  await ensureAdTables();
  const id = randomUUID();
  await client.execute({
    sql: `insert into ad_pushes (id, company_id, ad_id, provider, account_id, external_id, external_url, status, detail, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, p.companyId, p.adId, p.provider, p.accountId, p.externalId, p.externalUrl, p.status, p.detail ? JSON.stringify(p.detail) : null, p.error],
  });
  return id;
}

export async function listPushes(companyId: string): Promise<AdPush[]> {
  await ensureAdTables();
  const res = await client.execute({ sql: `select * from ad_pushes where company_id = ? order by created_at desc limit 100`, args: [companyId] });
  return res.rows.map((r: any) => ({
    id: String(r.id), adId: String(r.ad_id), provider: String(r.provider),
    accountId: r.account_id ? String(r.account_id) : null,
    externalId: r.external_id ? String(r.external_id) : null,
    externalUrl: r.external_url ? String(r.external_url) : null,
    status: String(r.status),
    detail: (() => { try { return r.detail ? JSON.parse(String(r.detail)) : null; } catch { return null; } })(),
    error: r.error ? String(r.error) : null,
    createdAt: toDate(r.created_at),
  }));
}
