// ─── Régies publicitaires : Google Ads + Meta Ads (OAuth + API réelles) ──────
//
// Chaque entreprise connecte SON compte publicitaire (OAuth). Velbaz peut alors
// lister ses comptes et y créer de vraies campagnes à partir des pubs générées
// par l'IA — TOUJOURS EN PAUSE : rien ne dépense tant que le propriétaire n'a
// pas activé la campagne lui-même dans Google Ads / le Gestionnaire de pubs.
//
// Clés (Admin → API Keys) :
//   Google Ads : GOOGLE_ADS_DEVELOPER_TOKEN (obligatoire) + client OAuth
//                GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET (repli : le
//                client « Continuer avec Google » GOOGLE_CLIENT_ID / _SECRET).
//                Optionnel : GOOGLE_ADS_LOGIN_CUSTOMER_ID (compte MCC).
//   Meta Ads   : META_APP_ID + META_APP_SECRET (app Meta, produit
//                « Marketing API », permissions ads_management / ads_read).
//
// Limites réelles (aucune ne se contourne par du code) :
//   • Google : un developer token « Test » ne marche que sur des comptes de
//     test ; il faut l'accès « Basic » validé par Google pour les vrais comptes.
//     Le scope adwords est « sensible » : écran de consentement à faire valider.
//   • Meta : ads_management exige l'App Review (sinon seuls les admins/testeurs
//     de l'app peuvent se connecter). Une pub Meta exige une Page Facebook.

import { getSecret } from '../secret-store';

export type AdProvider = 'google_ads' | 'meta_ads';
export const AD_PROVIDERS: AdProvider[] = ['google_ads', 'meta_ads'];

export const AD_PROVIDER_LABEL: Record<AdProvider, string> = {
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
};

/** Plateforme des brouillons (`ads.platform`) → régie. */
export function providerForAdPlatform(platform: string): AdProvider | null {
  const p = String(platform || '').toLowerCase();
  if (p === 'google' || p === 'google_ads') return 'google_ads';
  if (p === 'meta' || p === 'facebook' || p === 'instagram' || p === 'meta_ads') return 'meta_ads';
  return null;
}

export function isAdProvider(v: string): v is AdProvider {
  return (AD_PROVIDERS as string[]).includes(v);
}

export const GOOGLE_ADS_VERSION = () => getSecret('GOOGLE_ADS_API_VERSION') || 'v25';
export const META_GRAPH_VERSION = () => getSecret('META_GRAPH_VERSION') || 'v26.0';

function googleClient(): { id: string; secret: string } {
  return {
    id: getSecret('GOOGLE_ADS_CLIENT_ID') || getSecret('GOOGLE_CLIENT_ID'),
    secret: getSecret('GOOGLE_ADS_CLIENT_SECRET') || getSecret('GOOGLE_CLIENT_SECRET'),
  };
}

/** Clés manquantes pour qu'une régie soit connectable (vide = prête). */
export function missingAdKeys(provider: AdProvider): string[] {
  if (provider === 'google_ads') {
    const m: string[] = [];
    if (!getSecret('GOOGLE_ADS_DEVELOPER_TOKEN')) m.push('GOOGLE_ADS_DEVELOPER_TOKEN');
    const c = googleClient();
    if (!c.id) m.push('GOOGLE_ADS_CLIENT_ID (ou GOOGLE_CLIENT_ID)');
    if (!c.secret) m.push('GOOGLE_ADS_CLIENT_SECRET (ou GOOGLE_CLIENT_SECRET)');
    return m;
  }
  const m: string[] = [];
  if (!getSecret('META_APP_ID')) m.push('META_APP_ID');
  if (!getSecret('META_APP_SECRET')) m.push('META_APP_SECRET');
  return m;
}

export type AdTokens = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  externalUser?: string | null;
};

export type AdAccount = {
  id: string;            // Google : customer id sans tirets · Meta : act_123
  name: string;
  currency?: string | null;
  manager?: boolean;     // compte MCC Google : pas de campagne possible
  loginCustomerId?: string | null; // MCC par lequel on accède au compte
  status?: string | null;
};

export type AdPage = { id: string; name: string };

export class AdApiError extends Error {
  constructor(message: string, public status = 502, public code?: string) {
    super(message);
  }
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text.slice(0, 400) }; }
}

// ─── Google Ads ──────────────────────────────────────────────────────────────

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/adwords';

export function googleAuthUrl(state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: googleClient().id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${GOOGLE_SCOPE} openid email`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

async function googleToken(params: Record<string, string>): Promise<any> {
  const c = googleClient();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const body = await readJson(res);
  if (!res.ok || !body.access_token) {
    throw new AdApiError(`Google a refusé le jeton : ${body.error_description || body.error || `HTTP ${res.status}`}`, 400, body.error);
  }
  return body;
}

export async function googleExchangeCode(code: string, redirectUri: string): Promise<AdTokens> {
  const body = await googleToken({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  let email: string | null = null;
  try {
    const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${body.access_token}` }, signal: AbortSignal.timeout(10000),
    }).then((r) => r.json());
    email = info?.email || null;
  } catch { /* facultatif */ }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000),
    externalUser: email,
  };
}

export async function googleRefresh(refreshToken: string): Promise<AdTokens> {
  const body = await googleToken({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000),
  };
}

/** Message lisible depuis une erreur de l'API Google Ads. */
export function googleAdsErrorMessage(body: any, status: number): { message: string; code?: string } {
  const err = body?.error || {};
  const details = Array.isArray(err.details) ? err.details : [];
  for (const d of details) {
    const first = Array.isArray(d?.errors) ? d.errors[0] : null;
    if (first) {
      const codeObj = first.errorCode || {};
      const code = Object.values(codeObj)[0] as string | undefined;
      let message = String(first.message || err.message || `HTTP ${status}`);
      if (code === 'DEVELOPER_TOKEN_NOT_APPROVED' || /test accounts/i.test(message)) {
        message = 'Le developer token Google Ads n\'est approuvé que pour des comptes de test : demande l\'accès « Basic » dans Google Ads → Outils → Centre API.';
      } else if (code === 'DEVELOPER_TOKEN_PROHIBITED' || code === 'DEVELOPER_TOKEN_INVALID') {
        message = 'Developer token Google Ads invalide : vérifie GOOGLE_ADS_DEVELOPER_TOKEN dans Admin → API Keys.';
      } else if (code === 'USER_PERMISSION_DENIED') {
        message = 'Ce compte Google n\'a pas accès à ce compte Google Ads (ou il faut renseigner GOOGLE_ADS_LOGIN_CUSTOMER_ID pour un compte géré par un MCC).';
      }
      return { message: `Google Ads : ${message}`, code };
    }
  }
  if (status === 404) {
    return { message: `Google Ads : version d'API introuvable (${GOOGLE_ADS_VERSION()}). Mets à jour GOOGLE_ADS_API_VERSION.`, code: 'NOT_FOUND' };
  }
  return { message: `Google Ads : ${err.message || body?.raw || `HTTP ${status}`}`, code: err.status };
}

async function googleAds(path: string, accessToken: string, init: { method?: string; body?: any; loginCustomerId?: string | null } = {}): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': getSecret('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type': 'application/json',
  };
  const login = (init.loginCustomerId || getSecret('GOOGLE_ADS_LOGIN_CUSTOMER_ID') || '').replace(/\D/g, '');
  if (login) headers['login-customer-id'] = login;
  const res = await fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_VERSION()}/${path}`, {
    method: init.method || (init.body ? 'POST' : 'GET'),
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const body = await readJson(res);
  if (!res.ok) {
    const e = googleAdsErrorMessage(body, res.status);
    throw new AdApiError(e.message, res.status === 401 ? 401 : 502, e.code);
  }
  return body;
}

export async function googleListAccounts(accessToken: string): Promise<AdAccount[]> {
  const list = await googleAds('customers:listAccessibleCustomers', accessToken, { loginCustomerId: '' });
  const ids: string[] = (list.resourceNames || []).map((r: string) => r.split('/')[1]).filter(Boolean).slice(0, 20);
  const out: AdAccount[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    try {
      const res = await googleAds(`customers/${id}/googleAds:search`, accessToken, {
        loginCustomerId: id,
        body: { query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.status FROM customer LIMIT 1' },
      });
      const c = res.results?.[0]?.customer || {};
      const manager = !!c.manager;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, name: c.descriptiveName || `Compte ${id}`, currency: c.currencyCode || null, manager, loginCustomerId: id, status: c.status || null });
      }
      if (manager) {
        // Comptes clients gérés par ce MCC (niveau 1).
        const kids = await googleAds(`customers/${id}/googleAds:search`, accessToken, {
          loginCustomerId: id,
          body: { query: 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level = 1' },
        }).catch(() => ({ results: [] }));
        for (const r of kids.results || []) {
          const cc = r.customerClient || {};
          const cid = String(cc.id || '');
          if (!cid || seen.has(cid)) continue;
          seen.add(cid);
          out.push({ id: cid, name: cc.descriptiveName || `Compte ${cid}`, currency: cc.currencyCode || null, manager: !!cc.manager, loginCustomerId: id, status: cc.status || null });
        }
      }
    } catch (e: any) {
      // Une erreur de developer token touche tous les comptes : on la remonte.
      if (e instanceof AdApiError && /developer token/i.test(e.message)) throw e;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, name: `Compte ${id}`, currency: null, manager: false, loginCustomerId: null, status: null });
      }
    }
  }
  return out;
}

const cut = (s: string, n: number) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const sliced = t.slice(0, n);
  const sp = sliced.lastIndexOf(' ');
  return (sp > n * 0.6 ? sliced.slice(0, sp) : sliced).replace(/[\s,;:.-]+$/, '');
};

export type CampaignDraft = {
  name: string;
  headline: string;
  primaryText: string;
  callToAction?: string | null;
  finalUrl: string;
  dailyBudget: number;     // en unité de la devise du compte
  brand: string;
  country?: string | null; // ISO-2
};

/** Titres/descriptions d'une annonce responsive Google (limites strictes). */
export function googleRsaAssets(d: Pick<CampaignDraft, 'headline' | 'primaryText' | 'callToAction' | 'brand'>): { headlines: string[]; descriptions: string[] } {
  const brand = cut(d.brand, 30);
  const cta = cut(d.callToAction || '', 30);
  const pool = [
    cut(d.headline, 30),
    brand,
    cta && brand ? cut(`${cta} — ${brand}`, 30) : cta,
    cut(d.primaryText, 30),
    'Découvrez notre offre',
    'Commandez en ligne',
  ];
  const headlines: string[] = [];
  for (const h of pool) {
    const k = h.toLowerCase();
    if (h && !headlines.some((x) => x.toLowerCase() === k)) headlines.push(h);
    if (headlines.length >= 5) break;
  }
  const descs = [cut(d.primaryText, 90), cut(`${brand} : ${d.headline}. ${cta || 'En savoir plus'}.`, 90), cut(d.headline, 90)];
  const descriptions: string[] = [];
  for (const s of descs) {
    if (s && !descriptions.some((x) => x.toLowerCase() === s.toLowerCase())) descriptions.push(s);
    if (descriptions.length >= 3) break;
  }
  while (descriptions.length < 2) descriptions.push(descriptions.length ? 'Livraison rapide et service client réactif.' : cut(brand, 90) || 'Découvrez notre offre.');
  return { headlines, descriptions };
}

export type PushResult = {
  externalId: string;
  externalUrl: string | null;
  status: 'paused';
  created: string[];
  note?: string;
};

/** Crée campagne + budget + groupe + annonce responsive — campagne EN PAUSE. */
export async function googleCreatePausedCampaign(accessToken: string, account: AdAccount, d: CampaignDraft): Promise<PushResult> {
  if (account.manager) throw new AdApiError('Ce compte est un compte administrateur (MCC) : choisis un compte client pour créer une campagne.', 400);
  const cid = account.id.replace(/\D/g, '');
  const { headlines, descriptions } = googleRsaAssets(d);
  if (headlines.length < 3) throw new AdApiError('Texte trop court pour une annonce Google (3 titres minimum).', 400);
  const micros = Math.round(Math.max(1, d.dailyBudget) * 1_000_000);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const body = {
    mutateOperations: [
      { campaignBudgetOperation: { create: { resourceName: `customers/${cid}/campaignBudgets/-1`, name: `Velbaz ${d.name} ${stamp}`, amountMicros: String(micros), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
      { campaignOperation: { create: {
        resourceName: `customers/${cid}/campaigns/-2`,
        name: `Velbaz — ${d.name} (${stamp})`,
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        manualCpc: {},
        campaignBudget: `customers/${cid}/campaignBudgets/-1`,
        networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      } } },
      { adGroupOperation: { create: { resourceName: `customers/${cid}/adGroups/-3`, name: `Velbaz — ${cut(d.headline, 40)}`, campaign: `customers/${cid}/campaigns/-2`, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: '1000000' } } },
      { adGroupAdOperation: { create: { adGroup: `customers/${cid}/adGroups/-3`, status: 'ENABLED', ad: { finalUrls: [d.finalUrl], responsiveSearchAd: { headlines: headlines.map((text) => ({ text })), descriptions: descriptions.map((text) => ({ text })) } } } } },
    ],
  };
  const res = await googleAds(`customers/${cid}/googleAds:mutate`, accessToken, { body, loginCustomerId: account.loginCustomerId });
  const responses = res.mutateOperationResponses || [];
  const campaignRes = responses.find((r: any) => r.campaignResult)?.campaignResult?.resourceName || '';
  const campaignId = campaignRes.split('/').pop() || '';
  return {
    externalId: campaignId,
    externalUrl: campaignId ? `https://ads.google.com/aw/campaigns?campaignId=${campaignId}&__c=${cid}` : null,
    status: 'paused',
    created: ['budget', 'campagne (en pause)', 'groupe d\'annonces', 'annonce responsive'],
    note: 'Ajoute des mots-clés dans Google Ads avant d\'activer la campagne.',
  };
}

// ─── Meta Ads (Marketing API) ────────────────────────────────────────────────

const META_SCOPES = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement'];

export function metaAuthUrl(state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: getSecret('META_APP_ID'),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: META_SCOPES.join(','),
    state,
  });
  return `https://www.facebook.com/${META_GRAPH_VERSION()}/dialog/oauth?${q.toString()}`;
}

export function metaErrorMessage(body: any, status: number): string {
  const e = body?.error || {};
  const msg = e.error_user_msg || e.message || body?.raw || `HTTP ${status}`;
  if (e.code === 190) return 'Meta : la connexion a expiré — reconnecte le compte Meta Ads.';
  if (e.code === 200 || e.code === 10) return `Meta : permission manquante (${msg}). L'app Meta doit avoir ads_management validé (App Review) ou tu dois être admin/testeur de l'app.`;
  return `Meta : ${msg}`;
}

async function meta(path: string, accessToken: string, init: { method?: string; form?: Record<string, any> } = {}): Promise<any> {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION()}/${path.replace(/^\//, '')}`);
  let body: string | undefined;
  if (init.form) {
    const f = new URLSearchParams();
    for (const [k, v] of Object.entries(init.form)) {
      if (v === undefined || v === null) continue;
      f.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    f.set('access_token', accessToken);
    body = f.toString();
  } else {
    url.searchParams.set('access_token', accessToken);
  }
  const res = await fetch(url.toString(), {
    method: init.method || (init.form ? 'POST' : 'GET'),
    headers: init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    body,
    signal: AbortSignal.timeout(30000),
  });
  const json = await readJson(res);
  if (!res.ok || json?.error) throw new AdApiError(metaErrorMessage(json, res.status), json?.error?.code === 190 ? 401 : 502, String(json?.error?.code || ''));
  return json;
}

export async function metaExchangeCode(code: string, redirectUri: string): Promise<AdTokens> {
  const appId = getSecret('META_APP_ID');
  const secret = getSecret('META_APP_SECRET');
  const shortRes = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION()}/oauth/access_token?${new URLSearchParams({ client_id: appId, client_secret: secret, redirect_uri: redirectUri, code })}`, { signal: AbortSignal.timeout(20000) });
  const short = await readJson(shortRes);
  if (!shortRes.ok || !short.access_token) throw new AdApiError(metaErrorMessage(short, shortRes.status), 400);
  // Jeton long (~60 jours) : sinon la connexion expirerait au bout d'une heure.
  let token = short.access_token as string;
  let expiresIn = Number(short.expires_in) || 3600;
  try {
    const longRes = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION()}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: secret, fb_exchange_token: token })}`, { signal: AbortSignal.timeout(20000) });
    const long = await readJson(longRes);
    if (longRes.ok && long.access_token) { token = long.access_token; expiresIn = Number(long.expires_in) || 60 * 24 * 3600; }
  } catch { /* on garde le jeton court */ }
  let name: string | null = null;
  try { name = (await meta('me?fields=id,name', token))?.name || null; } catch { /* facultatif */ }
  return { accessToken: token, refreshToken: null, expiresAt: new Date(Date.now() + expiresIn * 1000), externalUser: name };
}

export async function metaListAccounts(accessToken: string): Promise<AdAccount[]> {
  const res = await meta('me/adaccounts?fields=id,account_id,name,currency,account_status&limit=50', accessToken);
  const STATUS: Record<number, string> = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED' };
  return (res.data || []).map((a: any) => ({
    id: String(a.id || `act_${a.account_id}`),
    name: a.name || `Compte ${a.account_id}`,
    currency: a.currency || null,
    manager: false,
    status: STATUS[Number(a.account_status)] || String(a.account_status ?? ''),
  }));
}

export async function metaListPages(accessToken: string): Promise<AdPage[]> {
  try {
    const res = await meta('me/accounts?fields=id,name&limit=50', accessToken);
    return (res.data || []).map((p: any) => ({ id: String(p.id), name: String(p.name || p.id) }));
  } catch {
    return [];
  }
}

const META_CTA: Record<string, string> = {
  'shop now': 'SHOP_NOW', 'acheter': 'SHOP_NOW', 'buy': 'SHOP_NOW', 'commander': 'ORDER_NOW', 'order now': 'ORDER_NOW',
  'sign up': 'SIGN_UP', "s'inscrire": 'SIGN_UP', 'inscription': 'SIGN_UP', 'book now': 'BOOK_TRAVEL', 'réserver': 'BOOK_TRAVEL',
  'contact us': 'CONTACT_US', 'contact': 'CONTACT_US', 'download': 'DOWNLOAD', 'get offer': 'GET_OFFER',
};
export function metaCta(cta?: string | null): string {
  const k = String(cta || '').toLowerCase().trim();
  for (const [word, type] of Object.entries(META_CTA)) if (k.includes(word)) return type;
  return 'LEARN_MORE';
}

/** Campagne (trafic) + ensemble de pubs + créa + pub — tout EN PAUSE. */
export async function metaCreatePausedCampaign(accessToken: string, account: AdAccount, d: CampaignDraft, pageId: string | null): Promise<PushResult> {
  const act = account.id.startsWith('act_') ? account.id : `act_${account.id}`;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const created: string[] = [];
  const campaign = await meta(`${act}/campaigns`, accessToken, { form: {
    name: `Velbaz — ${d.name} (${stamp})`,
    objective: 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  } });
  created.push('campagne (en pause)');
  const campaignId = String(campaign.id);
  const country = /^[A-Z]{2}$/.test(String(d.country || '').toUpperCase()) ? String(d.country).toUpperCase() : 'FR';
  const adset = await meta(`${act}/adsets`, accessToken, { form: {
    name: `Velbaz — ${cut(d.headline, 40)}`,
    campaign_id: campaignId,
    status: 'PAUSED',
    daily_budget: String(Math.round(Math.max(1, d.dailyBudget) * 100)),
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    destination_type: 'WEBSITE',
    targeting: { geo_locations: { countries: [country] }, targeting_automation: { advantage_audience: 1 } },
  } });
  created.push('ensemble de publicités (en pause)');
  let note: string | undefined;
  if (pageId) {
    const creative = await meta(`${act}/adcreatives`, accessToken, { form: {
      name: `Velbaz — ${cut(d.headline, 40)}`,
      object_story_spec: {
        page_id: pageId,
        link_data: { link: d.finalUrl, message: d.primaryText, name: cut(d.headline, 40), call_to_action: { type: metaCta(d.callToAction), value: { link: d.finalUrl } } },
      },
    } });
    created.push('créa');
    await meta(`${act}/ads`, accessToken, { form: {
      name: `Velbaz — ${cut(d.headline, 40)}`,
      adset_id: String(adset.id),
      creative: { creative_id: String(creative.id) },
      status: 'PAUSED',
    } });
    created.push('publicité (en pause)');
  } else {
    note = 'Aucune Page Facebook liée : campagne et ensemble créés, mais la pub elle-même demande une Page (choisis-en une puis renvoie la pub).';
  }
  return {
    externalId: campaignId,
    externalUrl: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act.replace('act_', '')}&selected_campaign_ids=${campaignId}`,
    status: 'paused',
    created,
    note,
  };
}
