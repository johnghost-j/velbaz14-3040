/**
 * Attribution : d'où vient une visite.
 *
 * Logique pure (aucun accès DB, aucun I/O) pour être testable et déterministe.
 * Elle transforme les signaux bruts du navigateur (referrer, UTM, user-agent)
 * en un canal exploitable par le Strategist : sans ça, « 340 visites » ne dit
 * pas si le canal d'acquisition marche ou pas.
 */

/** Canaux d'acquisition. `paid` = pub payée, `social` = réseaux, `organic` = moteurs. */
export type Channel = 'direct' | 'organic' | 'social' | 'paid' | 'email' | 'referral' | 'internal';

export type AttributionInput = {
  referrer?: string | null;
  /** URL complète de la page visitée (pour lire les UTM). */
  url?: string | null;
  userAgent?: string | null;
};

export type Attribution = {
  channel: Channel;
  /** Domaine source lisible (« google.com », « instagram.com »), '' si direct. */
  referrerHost: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  device: 'mobile' | 'tablet' | 'desktop';
  /** Trafic non humain (crawler, monitoring) → à exclure des métriques. */
  bot: boolean;
};

const SEARCH_HOSTS = [
  'google.', 'bing.com', 'duckduckgo.com', 'yahoo.', 'ecosia.org', 'qwant.com',
  'baidu.com', 'yandex.', 'brave.com', 'startpage.com', 'search.marcia',
];

const SOCIAL_HOSTS = [
  'facebook.com', 'fb.me', 'instagram.com', 'twitter.com', 't.co', 'x.com',
  'linkedin.com', 'lnkd.in', 'tiktok.com', 'pinterest.', 'reddit.com',
  'youtube.com', 'youtu.be', 'snapchat.com', 'threads.net', 'whatsapp.com',
  'telegram.', 't.me', 'discord.com', 'news.ycombinator.com', 'producthunt.com',
];

const EMAIL_HOSTS = ['mail.google.com', 'outlook.', 'mail.yahoo.', 'webmail.'];

/** Hôtes Velbaz : une visite qui vient de l'éditeur n'est pas un vrai visiteur. */
const INTERNAL_HOSTS = ['velbaz.com', 'velbaz.site', 'velbaz.app', 'localhost', '127.0.0.1'];

const BOT_PATTERNS = [
  'bot', 'crawler', 'spider', 'crawl', 'slurp', 'facebookexternalhit',
  'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'curl/', 'wget/',
  'python-requests', 'axios/', 'go-http-client', 'pingdom', 'uptimerobot',
  'lighthouse', 'gtmetrix', 'ahrefs', 'semrush', 'mj12', 'dotbot', 'bytespider',
  'gptbot', 'claudebot', 'ccbot', 'perplexitybot',
];

/** Médiums UTM qui signifient « pub payée ». */
const PAID_MEDIUMS = ['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paidsocial', 'paid_social', 'display', 'banner', 'retargeting', 'cpm'];
/** Sources UTM de régies publicitaires. */
const PAID_SOURCES = ['google_ads', 'googleads', 'adwords', 'meta_ads', 'facebook_ads', 'fb_ads', 'tiktok_ads', 'linkedin_ads', 'bing_ads', 'gravity'];

function hostOf(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

function matchesAny(host: string, list: string[]): boolean {
  return list.some((h) => host === h.replace(/\.$/, '') || host.includes(h));
}

function readUtm(url: string | null | undefined): { source: string | null; medium: string | null; campaign: string | null } {
  if (!url) return { source: null, medium: null, campaign: null };
  try {
    const u = new URL(url.includes('://') ? url : `https://x.invalid${url.startsWith('/') ? '' : '/'}${url}`);
    const g = (k: string) => {
      const v = u.searchParams.get(k);
      return v && v.trim() ? v.trim().slice(0, 120).toLowerCase() : null;
    };
    // gclid / fbclid : marqueurs de clic publicitaire sans UTM explicite.
    let source = g('utm_source');
    let medium = g('utm_medium');
    if (!source && u.searchParams.has('gclid')) { source = 'google_ads'; medium = medium || 'cpc'; }
    if (!source && (u.searchParams.has('fbclid') || u.searchParams.has('igshid'))) { source = 'meta_ads'; medium = medium || 'paid_social'; }
    if (!source && u.searchParams.has('ttclid')) { source = 'tiktok_ads'; medium = medium || 'paid_social'; }
    return { source, medium, campaign: g('utm_campaign') };
  } catch { return { source: null, medium: null, campaign: null }; }
}

export function detectDevice(userAgent?: string | null): 'mobile' | 'tablet' | 'desktop' {
  const ua = (userAgent || '').toLowerCase();
  if (/ipad|tablet|playbook|silk|kindle/.test(ua)) return 'tablet';
  if (/android(?!.*mobile)/.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|windows phone|opera mini/.test(ua)) return 'mobile';
  return 'desktop';
}

export function isBot(userAgent?: string | null): boolean {
  const ua = (userAgent || '').toLowerCase();
  if (!ua) return true; // un vrai navigateur envoie toujours un UA
  return BOT_PATTERNS.some((p) => ua.includes(p));
}

export function attribute(input: AttributionInput): Attribution {
  const utm = readUtm(input.url);
  const referrerHost = hostOf(input.referrer);
  const device = detectDevice(input.userAgent);
  const bot = isBot(input.userAgent);

  let channel: Channel;
  if (utm.medium && PAID_MEDIUMS.includes(utm.medium)) channel = 'paid';
  else if (utm.source && PAID_SOURCES.includes(utm.source)) channel = 'paid';
  else if (utm.medium === 'email' || utm.medium === 'newsletter') channel = 'email';
  else if (utm.medium === 'social' || (utm.source && matchesAny(utm.source, SOCIAL_HOSTS))) channel = 'social';
  else if (utm.medium === 'organic') channel = 'organic';
  else if (!referrerHost) channel = 'direct';
  else if (matchesAny(referrerHost, INTERNAL_HOSTS)) channel = 'internal';
  else if (matchesAny(referrerHost, SEARCH_HOSTS)) channel = 'organic';
  else if (matchesAny(referrerHost, SOCIAL_HOSTS)) channel = 'social';
  else if (matchesAny(referrerHost, EMAIL_HOSTS)) channel = 'email';
  else channel = 'referral';

  // Un UTM explicite mais non reconnu reste une source identifiée : on garde le
  // canal déduit du referrer plutôt que « direct ».
  if (channel === 'direct' && utm.source) channel = 'referral';

  return {
    channel,
    referrerHost,
    utmSource: utm.source,
    utmMedium: utm.medium,
    utmCampaign: utm.campaign,
    device,
    bot,
  };
}

/** Normalise un chemin pour l'agrégation : minuscule, sans query, sans slash final. */
export function normalizePath(url: string | null | undefined): string {
  if (!url) return '/';
  let p = url;
  try {
    if (p.includes('://')) p = new URL(p).pathname;
  } catch {}
  p = p.split('?')[0].split('#')[0].trim();
  if (!p.startsWith('/')) p = `/${p}`;
  // Chemin RELATIF AU SITE mesuré, pas à l'hébergeur. Un site publié est servi
  // sous /s/<sous-domaine>/… (et /api/s/… en interne) : sans ce nettoyage, toutes
  // les pages remontaient comme « /s/monsite/… » et « page d'accueil » devenait
  // indistinguable du préfixe d'hébergement pour les agents qui lisent topPaths.
  p = p.replace(/^\/api(?=\/|$)/, '');
  p = p.replace(/^\/s\/[^/]+/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return (p || '/').slice(0, 300);
}
