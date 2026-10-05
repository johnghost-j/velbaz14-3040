// ─── Photos produits servies par Velbaz : aucune adresse de fournisseur ──────
//
// [2026-10-04] Demande : « rien ne doit fuiter ». Les photos produits sont
// hébergées chez le fabricant (images-api.printify.com…) et cette adresse se
// voyait dans l'onglet réseau et dans le `src` des <img>.
//
// Toute réponse de l'API destinée au client (voir customer-text.ts) remplace
// ces adresses par `/api/img/<jeton>`. Le jeton est l'adresse réelle chiffrée
// (AES-256-GCM, clé serveur) : illisible côté client, et le proxy ne sert QUE
// des adresses émises par le serveur (impossible de s'en servir comme proxy
// ouvert). Il est déterministe (même adresse → même jeton) pour que le cache
// du navigateur fonctionne.
//
// Aller-retour : quand le client renvoie une de ces adresses (création de
// produit, validation d'aperçu…), `mediaProxyRequestRewrite()` la remet en
// adresse réelle AVANT le handler : le code serveur ne voit jamais `/api/img/`.

import { createCipheriv, createDecipheriv, createHmac, scryptSync } from 'node:crypto';
import type { Context } from 'hono';

export const MEDIA_PROXY_PREFIX = '/api/img/';

/** Hôtes des fournisseurs, outils et stockages internes dont on cache l'adresse. */
function isHiddenMediaHost(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  const under = (d: string) => h === d || h.endsWith(`.${d}`);
  return under('printify.com')
    || /^pfy-[\w-]+\.s3[\w.-]*\.amazonaws\.com$/.test(h)
    || under('cjdropshipping.com')
    || under('alicdn.com')
    || under('aliexpress-media.com')
    || under('fal.media')
    || under('replicate.delivery')
    || under('higgsfield.ai')
    || (h === 'storage.googleapis.com' && u.pathname.startsWith('/runable-'));
}

let cachedKey: Buffer | null = null;
function mediaKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.SECRET_STORE_KEY || process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('media-proxy: SECRET_STORE_KEY ou BETTER_AUTH_SECRET requis pour chiffrer les adresses des photos');
  cachedKey = scryptSync(secret, 'velbaz-media-proxy::v1', 32);
  return cachedKey;
}

/** Adresse réelle → jeton opaque (base64url : iv 12 o | tag 16 o | chiffré). */
export function toMediaToken(url: string): string {
  const key = mediaKey();
  const iv = createHmac('sha256', key).update(url).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

/** Jeton → adresse réelle, ou null si le jeton n'a pas été émis par ce serveur. */
export function fromMediaToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{40,4000}$/.test(token)) return null;
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 29) return null;
  const decipher = createDecipheriv('aes-256-gcm', mediaKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  let url: string;
  try {
    url = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    // Tag GCM invalide = jeton forgé ou d'une autre clé : ce n'est pas une erreur serveur.
    return null;
  }
  return /^https?:\/\//.test(url) ? url : null;
}

/** Une adresse : remplacée par `/api/img/<jeton>` si elle pointe chez un fournisseur. */
export function toProxiedMediaUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (!isHiddenMediaHost(u)) return url;
  return `${MEDIA_PROXY_PREFIX}${toMediaToken(url)}`;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]]+/g;

/** Toutes les adresses d'un texte (y compris une valeur `imageUrl` seule). */
export function proxyMediaUrls(text: string): string {
  return text.includes('://') ? text.replace(URL_IN_TEXT, toProxiedMediaUrl) : text;
}

const PROXIED_IN_TEXT = /(?:https?:\/\/[^\s"'<>/]+)?\/api\/img\/([A-Za-z0-9_-]{40,4000})/g;

/** Inverse : `/api/img/<jeton>` (relatif ou absolu) → adresse réelle. */
export function unproxyMediaUrls(text: string): string {
  return text.includes(MEDIA_PROXY_PREFIX)
    ? text.replace(PROXIED_IN_TEXT, (m, token: string) => fromMediaToken(token) ?? m)
    : text;
}

/** Middleware : le corps JSON reçu retrouve les adresses réelles avant le handler. */
export function mediaProxyRequestRewrite() {
  return async (c: Context, next: () => Promise<void>) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    if (!(c.req.header('content-type') || '').includes('application/json')) return next();
    const raw = c.req.raw;
    const text = await raw.clone().text();
    if (!text.includes(MEDIA_PROXY_PREFIX)) return next();
    const fixed = unproxyMediaUrls(text);
    if (fixed === text) return next();
    const headers = new Headers(raw.headers);
    headers.delete('content-length');
    c.req.raw = new Request(raw.url, { method, headers, body: fixed, signal: raw.signal });
    return next();
  };
}

/** GET /img/:token — sert la photo depuis le fournisseur, sans exposer son adresse. */
export async function serveProxiedMedia(c: Context): Promise<Response> {
  const url = fromMediaToken(c.req.param('token') || '');
  if (!url) return c.body(null, 404);
  const fwd = new Headers({ accept: 'image/*,video/*;q=0.9,*/*;q=0.5' });
  const range = c.req.header('range');
  if (range) fwd.set('range', range);
  const up = await fetch(url, { headers: fwd, redirect: 'follow' });
  if (!up.body || (up.status !== 200 && up.status !== 206)) {
    console.warn(`[media-proxy] ${up.status} pour ${new URL(url).hostname}`);
    // 4xx chez le fournisseur = photo supprimée là-bas (ex. produit retiré).
    return c.body(null, up.status >= 400 && up.status < 500 ? 404 : 502);
  }
  const out = new Headers();
  const type = up.headers.get('content-type') || '';
  out.set('content-type', /^(image|video)\//.test(type) ? type : 'application/octet-stream');
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('cache-control', 'public, max-age=86400');
  out.set('x-content-type-options', 'nosniff');
  return new Response(up.body, { status: up.status, headers: out });
}
