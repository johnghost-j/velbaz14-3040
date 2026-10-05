/**
 * DÉCOUVRABILITÉ DES SITES PUBLIÉS (sitemap / robots / IndexNow)
 *
 * [2026-09-17] Constat mesuré avant d'écrire ce module : `realWorldBrief()`
 * renvoyait « AUCUNE visite mesurée » sur 100 % des sociétés existantes. La
 * cause n'était pas le produit ni le pricing — c'est qu'un site publié par
 * Velbaz n'était signalé à PERSONNE. Aucun sitemap.xml, aucun robots.txt,
 * aucune soumission aux moteurs : les pages n'étaient donc jamais crawlées, et
 * la promesse « business autonome qui génère du revenu » s'arrêtait là, faute
 * du tout premier visiteur.
 *
 * Ce module fabrique les trois artefacts que les moteurs attendent et pousse
 * les URLs via IndexNow (Bing, Yandex, Seznam, Naver — protocole ouvert, pas
 * de compte à créer, contrairement à la Search Console de Google qui exige une
 * validation manuelle par humain et ne peut donc pas être autonome).
 *
 * Fonctions pures et testables ici ; les routes HTTP et le déclenchement à la
 * publication vivent dans index.ts.
 */

import { createHash } from 'crypto';

export interface SeoPage {
  slug: string;
  lang?: string | null;
  updatedAt?: string | Date | null;
}

/**
 * URL canonique racine d'un site publié.
 *
 * Un domaine personnalisé gagne toujours : c'est lui que le client promeut, et
 * faire pointer les moteurs vers l'URL d'hébergement interne alors qu'un vrai
 * domaine existe crée du contenu dupliqué qui dilue le référencement.
 * Sans domaine, on retombe sur l'hébergement interne `<origin>/s/<sous-domaine>`.
 * Pas de slash final : toutes les concaténations ici ajoutent le leur.
 */
export function siteBaseUrl(
  company: { subdomain?: string | null; customDomain?: string | null },
  origin: string,
): string | null {
  const domain = (company.customDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (domain) return `https://${domain}`;
  const sub = (company.subdomain || '').trim().toLowerCase();
  if (!sub) return null;
  return `${origin.replace(/\/+$/, '')}/s/${sub}`;
}

/**
 * URL publique d'une page. Le slug `index` est la racine du site : l'exposer
 * comme `/index` en plus de `/` produirait deux URLs pour la même page.
 */
export function pageUrl(base: string, page: SeoPage): string {
  const slug = (page.slug || '').replace(/^\/+/, '');
  if (!slug || slug === 'index') return `${base}/`;
  return `${base}/${slug}`;
}

/** Date au format W3C attendu dans `<lastmod>` (AAAA-MM-JJ). */
function lastmod(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * sitemap.xml conforme au protocole sitemaps.org 0.9.
 *
 * L'accueil reçoit la priorité 1.0 et une fréquence `daily` ; les autres pages
 * 0.8 / `weekly`. Les doublons d'URL sont écartés : une même page déclinée en
 * plusieurs langues peut retomber sur la même URL si le slug est identique, et
 * un sitemap avec des `<loc>` répétés est rejeté par certains moteurs.
 */
export function buildSitemap(base: string, pages: SeoPage[]): string {
  const seen = new Set<string>();
  const entries: string[] = [];

  // L'accueil est toujours listé, même si aucune page ne porte le slug `index`
  // (un site d'une seule page peut avoir un slug métier) : sans lui, la racine
  // du site — l'URL que tout le monde partage — serait absente du sitemap.
  const home = `${base}/`;
  const homePage = pages.find(p => !p.slug || p.slug === 'index' || p.slug === '/');
  seen.add(home);
  entries.push([
    '  <url>',
    `    <loc>${xmlEscape(home)}</loc>`,
    ...(lastmod(homePage?.updatedAt) ? [`    <lastmod>${lastmod(homePage?.updatedAt)}</lastmod>`] : []),
    '    <changefreq>daily</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
  ].join('\n'));

  for (const page of pages) {
    const url = pageUrl(base, page);
    if (seen.has(url)) continue;
    seen.add(url);
    const mod = lastmod(page.updatedAt);
    entries.push([
      '  <url>',
      `    <loc>${xmlEscape(url)}</loc>`,
      ...(mod ? [`    <lastmod>${mod}</lastmod>`] : []),
      '    <changefreq>weekly</changefreq>',
      '    <priority>0.8</priority>',
      '  </url>',
    ].join('\n'));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
}

/**
 * robots.txt permissif + déclaration du sitemap.
 *
 * Un site privé (visibility `private`) doit au contraire tout interdire : le
 * propriétaire a explicitement demandé qu'il ne soit pas public, l'indexer
 * serait une fuite.
 */
export function buildRobots(base: string, opts: { private?: boolean } = {}): string {
  if (opts.private) {
    return 'User-agent: *\nDisallow: /\n';
  }
  return [
    'User-agent: *',
    'Allow: /',
    '',
    // Les crawlers d'entraînement IA sont laissés passer volontairement : pour
    // une jeune marque, être cité par un assistant est un canal d'acquisition,
    // pas une menace.
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * Clé IndexNow d'une société : stable (les moteurs revérifient le fichier à
 * chaque soumission, elle ne peut donc pas changer à chaque redémarrage) et
 * non devinable (dérivée d'un secret serveur, sinon n'importe qui pourrait
 * soumettre des URLs au nom du site).
 */
export function indexNowKey(companyId: string, secret: string): string {
  return createHash('sha256').update(`indexnow:${companyId}:${secret || 'velbaz-fallback'}`).digest('hex').slice(0, 32);
}

export interface IndexNowResult {
  submitted: boolean;
  status?: number;
  urls: number;
  reason?: string;
}

/**
 * Soumet les URLs à IndexNow.
 *
 * `keyLocation` est indispensable ici : sur l'hébergement interne, un site vit
 * dans un sous-dossier (`velbaz.site/s/<sub>`) et non à la racine du host. Le
 * protocole autorise une clé placée dans le sous-dossier, qui n'authentifie
 * alors que les URLs de ce sous-dossier — exactement ce qu'on veut, un site ne
 * devant jamais pouvoir soumettre les URLs d'un autre.
 *
 * Ne lève jamais : une soumission ratée ne doit pas faire échouer une
 * publication. Un site hors ligne (localhost, domaine de test) est écarté
 * avant l'appel réseau, les moteurs refusant de toute façon ces URLs.
 */
export async function submitToIndexNow(
  base: string,
  urls: string[],
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IndexNowResult> {
  const list = [...new Set(urls)].filter(u => /^https?:\/\//.test(u));
  if (list.length === 0) return { submitted: false, urls: 0, reason: 'no_urls' };

  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    return { submitted: false, urls: list.length, reason: 'bad_base_url' };
  }
  // Un host non résolvable publiquement n'est pas indexable : inutile de
  // brûler un appel réseau (et de polluer les logs) en dev.
  // Nom d'hôte sans le port, sinon un `127.0.0.1:4200` échappe aux ancres.
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const nonPublic =
    hostname === 'localhost' ||
    hostname === '::1' ||
    /\.(local|localhost|test|invalid|internal|example)$/i.test(hostname) ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^0\./.test(hostname) ||
    !hostname.includes('.');
  if (nonPublic) {
    return { submitted: false, urls: list.length, reason: 'non_public_host' };
  }

  try {
    const res = await fetchImpl('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `${base}/${key}.txt`,
        urlList: list.slice(0, 10000),
      }),
      signal: AbortSignal.timeout(10000),
    });
    // 200 = accepté, 202 = accepté mais clé en cours de validation : les deux
    // sont des succès côté protocole.
    return { submitted: res.status === 200 || res.status === 202, status: res.status, urls: list.length };
  } catch (e: any) {
    return { submitted: false, urls: list.length, reason: e?.message || 'network_error' };
  }
}
