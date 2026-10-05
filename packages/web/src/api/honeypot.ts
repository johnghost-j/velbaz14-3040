// ─── Leurres, canaris et bannissement automatique ───────────────────────────
//
// IDÉE
// Un attaquant ne connaît pas l'app : il la SONDE. Il demande /api/.env,
// /api/admin.php, /api/backup.zip, /wp-login.php, /api/graphql, /api/debug…
// Aucune de ces routes n'existe dans Velbaz : un vrai utilisateur ne les
// demandera JAMAIS. On en fait donc des LEURRES :
//
//   1. Le leurre répond quelque chose de crédible — un faux .env, une fausse
//      liste d'utilisateurs, un faux fichier de config — avec un délai qui
//      ralentit le scan.
//   2. Les fausses clés qu'il contient sont des CANARIS : aucune n'est valide.
//      Si l'une d'elles réapparaît un jour dans une requête (en-tête, corps,
//      query), c'est la preuve que l'appelant a mordu au leurre → bannissement
//      immédiat, et la trace part dans les journaux.
//   3. Au bout de quelques leurres touchés, l'IP est BANNIE : tout /api/*
//      répond 404 pendant un temps croissant. Le scanner perd sa carte.
//
// LIMITES ASSUMÉES
// Ça n'« empêche » pas un pirate déterminé : ça coûte cher aux outils
// automatisés (99 % des attaques), ça donne une alerte précoce, et ça pollue la
// cartographie de l'app. La vraie sécurité reste l'authentification, les
// contrôles de propriété (requireCompanyOwner) et les secrets côté serveur.

import type { Context } from 'hono';

// ── Mémoire (un seul process Bun ; persistée sur globalThis pour le HMR) ────
interface Offender {
  hits: number;
  firstAt: number;
  lastAt: number;
  bannedUntil: number;
  paths: string[];
}
const offenders: Map<string, Offender> =
  ((globalThis as any).__velbaz_honeypot ??= new Map<string, Offender>());

const HITS_BEFORE_BAN = 3;            // 3 leurres touchés = scan caractérisé
const BAN_MS = 30 * 60_000;           // 30 min, doublé à chaque récidive
const MAX_BAN_MS = 24 * 3600_000;
const OFFENDER_TTL_MS = 6 * 3600_000;

/** Journal des dernières détections — lu par la page admin de sécurité. */
export interface SecurityEvent {
  at: number;
  kind: 'honeypot' | 'canary' | 'banned-request' | 'injection' | 'login-lock';
  ip: string;
  path: string;
  detail?: string;
  ua?: string;
}
const events: SecurityEvent[] = ((globalThis as any).__velbaz_sec_events ??= []);
const MAX_EVENTS = 500;

export function recordSecurityEvent(e: SecurityEvent) {
  events.push(e);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  console.warn(`[security:${e.kind}] ${e.ip} ${e.path}${e.detail ? ` — ${e.detail}` : ''}`);
}

export function securityEvents(limit = 100): SecurityEvent[] {
  return events.slice(-limit).reverse();
}

export function bannedList(): Array<{ ip: string; hits: number; bannedUntil: number; paths: string[] }> {
  const now = Date.now();
  return [...offenders.entries()]
    .filter(([, o]) => o.bannedUntil > now)
    .map(([ip, o]) => ({ ip, hits: o.hits, bannedUntil: o.bannedUntil, paths: o.paths.slice(-10) }));
}

/** Lève un bannissement (bouton « débannir » côté admin). */
export function unban(ip: string): boolean {
  return offenders.delete(ip);
}

export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return c.req.header('x-real-ip') || c.req.header('fly-client-ip') || 'inconnue';
}

function sweep() {
  const now = Date.now();
  for (const [ip, o] of offenders) {
    if (o.bannedUntil < now && now - o.lastAt > OFFENDER_TTL_MS) offenders.delete(ip);
  }
}

/** Compte une touche de leurre et bannit au-delà du seuil. Renvoie l'état. */
export function flag(ip: string, path: string, kind: SecurityEvent['kind'], detail?: string, ua?: string): Offender {
  sweep();
  const now = Date.now();
  const o = offenders.get(ip) || { hits: 0, firstAt: now, lastAt: now, bannedUntil: 0, paths: [] };
  o.hits++;
  o.lastAt = now;
  o.paths.push(path);
  if (o.paths.length > 30) o.paths.splice(0, o.paths.length - 30);
  // Un canari utilisé = preuve directe : bannissement immédiat.
  const immediate = kind === 'canary';
  if (immediate || o.hits >= HITS_BEFORE_BAN) {
    const previous = o.bannedUntil > now ? o.bannedUntil - now : 0;
    o.bannedUntil = now + Math.min(MAX_BAN_MS, Math.max(BAN_MS, previous * 2));
  }
  offenders.set(ip, o);
  recordSecurityEvent({ at: now, kind, ip, path, detail, ua });
  return o;
}

export function isBanned(ip: string): boolean {
  const o = offenders.get(ip);
  return !!o && o.bannedUntil > Date.now();
}

// ── Canaris : fausses valeurs servies par les leurres ───────────────────────
// Elles n'ouvrent RIEN. Leur seul rôle est d'être reconnaissables : si l'une
// revient dans une requête, l'appelant a lu un leurre.
export const CANARY_TOKENS = [
  'vlbz_live_sk_7f3a91d4c85b2e60a1f9', // faux « secret key » Velbaz
  'vlbz_admin_2f8c41ba90e7',           // faux jeton admin
  'sk-velbaz-Xy82Kd0LmQ4pRv7TnAe1',    // faux jeton style OpenAI
  'VLBZ-DB-BACKUP-KEY-0092',           // fausse clé de sauvegarde
];
const CANARY_RE = new RegExp(CANARY_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

/** Contenu des leurres — crédible, entièrement faux. */
const FAKE_ENV = `# Velbaz — production (généré automatiquement, ne pas committer)
NODE_ENV=production
APP_REGION=eu-west-3
DATABASE_URL=libsql://velbaz-prod-eu.turso.io
DATABASE_AUTH_TOKEN=${CANARY_TOKENS[3]}
SESSION_SECRET=${CANARY_TOKENS[1]}
STRIPE_SECRET_KEY=${CANARY_TOKENS[0]}
OPENAI_API_KEY=${CANARY_TOKENS[2]}
S3_BUCKET=velbaz-prod-assets
LEGACY_ADMIN_PANEL=/api/v1/internal/console
`;

const FAKE_USERS = {
  page: 1,
  per_page: 50,
  total: 3,
  users: [
    { id: 1041, email: 'admin@velbaz.com', role: 'superadmin', plan: 'enterprise', created_at: '2025-11-02T09:14:00Z' },
    { id: 1042, email: 'billing@velbaz.com', role: 'staff', plan: 'enterprise', created_at: '2025-12-19T16:41:00Z' },
    { id: 1043, email: 'support@velbaz.com', role: 'staff', plan: 'pro', created_at: '2026-02-07T11:03:00Z' },
  ],
  next: '/api/v1/internal/users?page=2',
  _token: CANARY_TOKENS[1],
};

const FAKE_CONFIG = {
  app: 'velbaz',
  version: '3.8.1',
  debug: false,
  api_key: CANARY_TOKENS[0],
  services: { db: 'turso', queue: 'redis://cache-01.internal:6379', storage: 's3' },
  admin_console: '/api/v1/internal/console',
};

// ── Table des leurres ───────────────────────────────────────────────────────
// Chemins que SEUL un scanner demande. Tous relatifs à la base /api.
interface Decoy { test: (p: string) => boolean; serve: (c: Context) => Response | Promise<Response>; }

const envLike = ['/.env', '/.env.local', '/.env.production', '/env', '/config/.env'];
const adminLike = ['/admin.php', '/administrator', '/wp-login.php', '/wp-admin', '/phpmyadmin', '/pma', '/adminer.php'];
const configLike = ['/config.json', '/config.yml', '/settings.json', '/appsettings.json', '/credentials.json'];
const dumpLike = ['/backup.zip', '/backup.sql', '/dump.sql', '/db.sqlite', '/database.sql', '/backup.tar.gz'];
const srcLike = ['/.git/config', '/.git/HEAD', '/.svn/entries', '/server.js.map', '/app.js.map', '/source.zip', '/src.zip'];
const introspectLike = ['/graphql', '/graphiql', '/debug', '/debug/vars', '/actuator/env', '/actuator/health', '/swagger.json', '/openapi.json', '/api-docs'];
const internalLike = ['/v1/internal/users', '/v1/internal/console', '/internal/users', '/internal/admin', '/admin/api/users'];

function text(c: Context, body: string, type = 'text/plain; charset=utf-8', status = 200) {
  return c.newResponse(body, status as any, { 'Content-Type': type, 'X-Robots-Tag': 'noindex, nofollow' });
}

const DECOYS: Decoy[] = [
  { test: (p) => envLike.includes(p), serve: (c) => text(c, FAKE_ENV) },
  { test: (p) => configLike.includes(p), serve: (c) => c.json(FAKE_CONFIG) },
  { test: (p) => internalLike.includes(p), serve: (c) => c.json(FAKE_USERS) },
  {
    test: (p) => adminLike.includes(p),
    serve: (c) => text(c, [
      '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Console — connexion</title>',
      '<meta name="robots" content="noindex"></head><body style="font-family:system-ui;background:#0b0b0d;color:#eee;display:grid;place-items:center;height:100vh;margin:0">',
      '<form method="post" action="/api/v1/internal/console" style="width:320px;display:grid;gap:10px">',
      '<h1 style="font-size:18px;margin:0 0 6px">Console interne</h1>',
      '<input name="user" placeholder="Identifiant" style="padding:10px;border-radius:8px;border:1px solid #333;background:#141417;color:#eee">',
      '<input name="pass" type="password" placeholder="Mot de passe" style="padding:10px;border-radius:8px;border:1px solid #333;background:#141417;color:#eee">',
      '<button style="padding:10px;border-radius:8px;border:0;background:#3b6cff;color:#fff">Se connecter</button>',
      `<!-- build token: ${CANARY_TOKENS[1]} -->`,
      '</form></body></html>',
    ].join(''), 'text/html; charset=utf-8'),
  },
  {
    test: (p) => dumpLike.includes(p) || srcLike.includes(p),
    // Un « téléchargement » qui n'arrive jamais : le scanner attend, puis reçoit 20 octets.
    serve: (c) => text(c, 'PK\u0003\u0004\u0014\u0000\u0000\u0000\u0008\u0000archive corrompue\n', 'application/octet-stream'),
  },
  {
    test: (p) => introspectLike.includes(p),
    serve: (c) => c.json({
      error: 'introspection disabled in production',
      hint: 'use /api/v1/internal/console with an operator token',
      version: '3.8.1',
    }, 403),
  },
];

function normalizePath(path: string): string {
  const p = (path || '/').replace(/^\/api/, '') || '/';
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Le chemin correspond-il à un leurre ? (utilisé aussi par les tests) */
export function isDecoyPath(path: string): boolean {
  const p = normalizePath(path);
  return DECOYS.some((d) => d.test(p));
}

/** Un canari apparaît-il dans cette requête ? */
export function requestCarriesCanary(c: Context): string | null {
  const url = c.req.url;
  if (CANARY_RE.test(url)) return url.match(CANARY_RE)?.[0] ?? 'canari';
  for (const h of ['authorization', 'x-api-key', 'x-admin-token', 'cookie', 'x-auth-token']) {
    const v = c.req.header(h);
    if (v && CANARY_RE.test(v)) return v.match(CANARY_RE)?.[0] ?? 'canari';
  }
  return null;
}

/** Le corps contient-il un canari ? (appelé après lecture du corps) */
export function bodyCarriesCanary(body: string): string | null {
  return CANARY_RE.test(body) ? (body.match(CANARY_RE)?.[0] ?? 'canari') : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Taille max de corps inspectée : au-delà, on laisse passer sans lire. */
const MAX_BODY_PEEK = 64 * 1024;

/**
 * Cherche un canari dans le corps d'une requête SANS le consommer.
 *
 * Précautions : uniquement sur les méthodes à corps, uniquement les types
 * textuels (pas de multipart/octet-stream : ce sont des téléversements, et les
 * lire doublerait la mémoire), uniquement si `content-length` est connu et
 * petit (un flux SSE ou un envoi de fichier n'est jamais inspecté), et tout
 * échec de clonage est ignoré — la sécurité ne doit jamais casser une requête
 * légitime.
 */
async function peekBodyCanary(c: Context): Promise<string | null> {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  const type = (c.req.header('content-type') || '').toLowerCase();
  const textual =
    type.includes('json') ||
    type.includes('text/') ||
    type.includes('x-www-form-urlencoded');
  if (!textual) return null;

  const len = Number(c.req.header('content-length'));
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY_PEEK) return null;

  try {
    const text = await c.req.raw.clone().text();
    return bodyCarriesCanary(text);
  } catch {
    return null;
  }
}

/**
 * Middleware Hono à monter EN PREMIER sur /api/* :
 *   • IP bannie → 404 sur tout, sans toucher à la base ni à l'IA ;
 *   • canari présenté → bannissement immédiat ;
 *   • chemin-leurre → fausse réponse crédible + comptage.
 */
export function honeypot() {
  return async (c: Context, next: () => Promise<void>) => {
    const ip = clientIp(c);
    const path = normalizePath(c.req.path);
    const ua = c.req.header('user-agent') || '';

    // 1. Canari : preuve qu'un leurre a été lu et exploité.
    const canary = requestCarriesCanary(c);
    if (canary) {
      flag(ip, path, 'canary', `jeton canari utilisé (${canary.slice(0, 12)}…)`, ua);
      await sleep(1500);
      return c.notFound();
    }

    // 1 bis. Canari dans le CORPS de la requête (ex. un jeton lu dans le faux
    // .env renvoyé plus tard dans un POST JSON). On lit un CLONE : le corps
    // original reste intact pour le vrai handler.
    const bodyCanary = await peekBodyCanary(c);
    if (bodyCanary) {
      flag(ip, path, 'canary', `jeton canari dans le corps (${bodyCanary.slice(0, 12)}…)`, ua);
      await sleep(1500);
      return c.notFound();
    }

    // 2. Déjà banni : plus rien ne répond, et le ban se prolonge s'il insiste.
    if (isBanned(ip)) {
      recordSecurityEvent({ at: Date.now(), kind: 'banned-request', ip, path, ua });
      await sleep(2000);
      return c.notFound();
    }

    // 3. Leurres.
    const decoy = DECOYS.find((d) => d.test(path));
    if (decoy) {
      const o = flag(ip, path, 'honeypot', 'leurre servi', ua);
      // Ralentissement croissant : un scan de 200 chemins devient très long.
      await sleep(Math.min(8000, 400 * o.hits));
      return decoy.serve(c);
    }

    return next();
  };
}
