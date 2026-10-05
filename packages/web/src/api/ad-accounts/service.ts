// ─── Logique métier : jetons frais, comptes, envoi d'une pub EN PAUSE ────────
// Utilisé par les routes HTTP (bouton « Envoyer ») ET par le mode auto
// (tâche create_ad) : un seul chemin, mêmes garde-fous.

import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database/index';
import * as schema from '../database/schema';
import { getSecret } from '../secret-store';
import {
  AdApiError, AD_PROVIDER_LABEL, missingAdKeys, providerForAdPlatform,
  googleRefresh, googleListAccounts, metaListAccounts, metaListPages,
  googleCreatePausedCampaign, metaCreatePausedCampaign,
  type AdProvider, type AdAccount, type CampaignDraft, type PushResult,
} from './providers';
import {
  getConnection, listConnections, updateTokens, saveConnection, setLastError, recordPush,
  type AdConnection,
} from './store';

/** Budget quotidien max posé par Velbaz sur une campagne créée (devise du compte). */
export const MAX_DAILY_BUDGET = 50;
export const DEFAULT_DAILY_BUDGET = 10;

export function clampBudget(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_BUDGET;
  return Math.min(MAX_DAILY_BUDGET, Math.max(1, Math.round(n * 100) / 100));
}

/** Jeton utilisable : Google expire en 1 h → rafraîchi automatiquement. */
export async function freshToken(conn: AdConnection): Promise<string> {
  if (conn.provider !== 'google_ads') {
    if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() < Date.now()) {
      throw new AdApiError('La connexion Meta Ads a expiré (60 jours) : reconnecte le compte.', 401);
    }
    return conn.accessToken;
  }
  const soon = Date.now() + 5 * 60 * 1000;
  if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() > soon) return conn.accessToken;
  if (!conn.refreshToken) throw new AdApiError('Connexion Google Ads sans jeton de rafraîchissement : reconnecte le compte.', 401);
  const t = await googleRefresh(conn.refreshToken);
  await updateTokens(conn.id, t.accessToken, t.refreshToken || null, t.expiresAt || null);
  conn.accessToken = t.accessToken;
  conn.tokenExpiresAt = t.expiresAt || null;
  return t.accessToken;
}

/** Relit les comptes (et pages Meta) depuis la régie et les enregistre. */
export async function syncAccounts(companyId: string, provider: AdProvider, tokens: { accessToken: string; refreshToken?: string | null; expiresAt?: Date | null; externalUser?: string | null }): Promise<{ accounts: AdAccount[] }> {
  const accounts = provider === 'google_ads'
    ? await googleListAccounts(tokens.accessToken)
    : await metaListAccounts(tokens.accessToken);
  const pages = provider === 'meta_ads' ? await metaListPages(tokens.accessToken) : [];
  await saveConnection({
    companyId, provider,
    externalUser: tokens.externalUser || null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || null,
    tokenExpiresAt: tokens.expiresAt || null,
    accounts, pages,
  });
  return { accounts };
}

/** Vue publique d'une connexion (jamais de jeton). */
export function publicConnection(conn: AdConnection) {
  return {
    provider: conn.provider,
    label: AD_PROVIDER_LABEL[conn.provider],
    externalUser: conn.externalUser,
    accounts: conn.accounts,
    selectedAccountId: conn.selectedAccountId,
    pages: conn.pages,
    selectedPageId: conn.selectedPageId,
    expiresAt: conn.tokenExpiresAt ? conn.tokenExpiresAt.getTime() : null,
    lastError: conn.lastError,
    ready: !!conn.selectedAccountId,
    connectedAt: conn.createdAt ? conn.createdAt.getTime() : null,
  };
}

/** Régies réellement utilisables par le mode auto (connectées + compte choisi). */
export async function readyAdProviders(companyId: string): Promise<AdProvider[]> {
  try {
    const conns = await listConnections(companyId);
    return conns.filter((c) => c.selectedAccountId && missingAdKeys(c.provider).length === 0).map((c) => c.provider);
  } catch {
    return [];
  }
}

function landingUrl(company: any): string | null {
  if (!company?.published) return null;
  const domain = String(company.customDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (domain && company.customDomainStatus === 'live') {
    return `${company.customDomainSsl === 'active' ? 'https' : 'http'}://${domain}`;
  }
  const sub = String(company.subdomain || '').trim().toLowerCase();
  if (!sub) return null;
  const base = (getSecret('PUBLIC_URL') || process.env.PUBLIC_URL || 'https://velbaz.com').replace(/\/+$/, '');
  return `${base}/s/${sub}`;
}

export type PushOutcome =
  | ({ ok: true; provider: AdProvider; accountId: string; pushId: string; dailyBudget: number; currency: string | null } & PushResult)
  | { ok: false; status: number; error: string; code?: string };

/**
 * Envoie un brouillon de pub (table `ads`) sur la régie connectée, sous forme
 * de campagne EN PAUSE. Ne lance jamais de dépense.
 */
export async function pushAdDraft(opts: { companyId: string; adId: string; provider?: AdProvider | null; dailyBudget?: number | null }): Promise<PushOutcome> {
  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, opts.companyId)).get();
  if (!company) return { ok: false, status: 404, error: 'Projet introuvable.' };
  const ad = await db.select().from(schema.ads).where(eq(schema.ads.id, opts.adId)).get();
  if (!ad || ad.companyId !== company.id) return { ok: false, status: 404, error: 'Pub introuvable.' };

  const provider = opts.provider || providerForAdPlatform(ad.platform);
  if (!provider) return { ok: false, status: 400, error: `Aucune régie connectable pour une pub « ${ad.platform} » (Google Ads et Meta Ads seulement).` };
  const missing = missingAdKeys(provider);
  if (missing.length) return { ok: false, status: 501, error: `${AD_PROVIDER_LABEL[provider]} n'est pas configuré : clés manquantes dans Admin → API Keys : ${missing.join(', ')}.`, code: 'not_configured' };

  const conn = await getConnection(company.id, provider);
  if (!conn) return { ok: false, status: 400, error: `Connecte d'abord un compte ${AD_PROVIDER_LABEL[provider]}.`, code: 'not_connected' };
  const account = conn.accounts.find((a) => a.id === conn.selectedAccountId);
  if (!account) return { ok: false, status: 400, error: `Choisis le compte ${AD_PROVIDER_LABEL[provider]} à utiliser.`, code: 'no_account' };

  const finalUrl = landingUrl(company);
  if (!finalUrl) return { ok: false, status: 400, error: 'Publie d\'abord le site : la pub doit pointer vers une page en ligne.', code: 'not_published' };

  const dailyBudget = clampBudget(opts.dailyBudget ?? ad.dailyBudget);
  const draft: CampaignDraft = {
    name: company.name || 'Projet',
    headline: ad.headline,
    primaryText: ad.primaryText,
    callToAction: ad.callToAction,
    finalUrl,
    dailyBudget,
    brand: company.name || '',
    country: (company as any).country || null,
  };

  try {
    const token = await freshToken(conn);
    const res = provider === 'google_ads'
      ? await googleCreatePausedCampaign(token, account, draft)
      : await metaCreatePausedCampaign(token, account, draft, conn.selectedPageId);
    const pushId = await recordPush({
      companyId: company.id, adId: ad.id, provider, accountId: account.id,
      externalId: res.externalId, externalUrl: res.externalUrl, status: 'paused',
      detail: { created: res.created, note: res.note, dailyBudget, finalUrl }, error: null,
    });
    await db.update(schema.ads).set({ status: 'paused', dailyBudget }).where(eq(schema.ads.id, ad.id)).catch(() => {});
    await setLastError(conn.id, null);
    await db.insert(schema.agentActivity).values({
      id: uuidv4(), companyId: company.id, agentRole: 'marketing', action: 'completed',
      message: `Campagne ${AD_PROVIDER_LABEL[provider]} créée EN PAUSE (« ${ad.headline.slice(0, 40)} », ${dailyBudget}/jour) — à activer par toi dans ${AD_PROVIDER_LABEL[provider]}.`,
    }).catch(() => {});
    return { ok: true, provider, accountId: account.id, pushId, dailyBudget, currency: account.currency || null, ...res };
  } catch (e: any) {
    const msg = e instanceof AdApiError ? e.message : `${AD_PROVIDER_LABEL[provider]} injoignable : ${e?.message || 'erreur réseau'}`;
    await setLastError(conn.id, msg);
    await recordPush({
      companyId: company.id, adId: ad.id, provider, accountId: account.id,
      externalId: null, externalUrl: null, status: 'failed', detail: null, error: msg,
    }).catch(() => '');
    return { ok: false, status: e instanceof AdApiError && e.status < 500 ? e.status : 502, error: msg, code: e?.code };
  }
}
