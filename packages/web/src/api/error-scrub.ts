// ─── Nettoyage des réponses : ne jamais décrire l'intérieur du serveur ──────
//
// Beaucoup de routes renvoient `e?.message` au client (`{ error: e.message }`).
// C'est pratique en développement, mais le message d'une erreur réelle raconte
// l'architecture : chemin absolu des fichiers (/home/user/velbaz/packages/…),
// requête SQL et noms de tables, URL de la base Turso, nom des bibliothèques et
// leur version, parfois un jeton ou une URL signée. C'est exactement la
// cartographie qu'un attaquant cherche avant d'attaquer.
//
// Plutôt que de corriger 113 appels un par un (et de rater les suivants), on
// nettoie au POINT DE SORTIE : un middleware relit chaque réponse JSON et
// masque les motifs sensibles. Les admins, eux, reçoivent le message brut —
// c'est ce qui permet de déboguer et de faire marcher l'auto-réparation.

import type { Context } from 'hono';

/** Motifs à masquer dans tout texte renvoyé à un non-admin. */
const PATTERNS: Array<[RegExp, string]> = [
  // Chemins de fichiers du serveur (le plus parlant pour un attaquant).
  [/(?:\/(?:home|Users|root|var|etc|opt|usr|tmp)\/[^\s"'`,;)\]]+)/g, '[chemin]'],
  [/[A-Za-z]:\\[^\s"'`,;)\]]+/g, '[chemin]'],
  // Pile d'appel.
  [/\bat\s+[\w$.<>[\]]+\s*\([^)]*\)/g, '[pile]'],
  [/\b\w+\.[jt]sx?:\d+:\d+/g, '[source]'],
  // Base de données : URL Turso/libsql, DSN Postgres/Mongo/Redis, SQL brut.
  [/\b(?:libsql|wss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'`,;)\]]+/gi, '[base]'],
  [/\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE)\b[\s\S]{0,200}/gi, '[requête]'],
  [/\bSQLITE_[A-Z_]+\b/g, '[base]'],
  // Jetons / clés qui se seraient glissés dans un message.
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g, '[clé]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jeton]'],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [jeton]'],
  // Réseau interne.
  [/\b(?:10|127|192\.168|169\.254)(?:\.\d{1,3}){2,3}(?::\d+)?\b/g, '[hôte interne]'],
  [/\b[a-z0-9-]+\.internal(?::\d+)?\b/gi, '[hôte interne]'],
  // Versions de bibliothèques (aide au choix d'un exploit connu).
  [/\bnode_modules\/[^\s"'`,;)\]]+/g, '[dépendance]'],
];

/** Masque les détails internes d'une chaîne destinée au public. */
export function scrubMessage(input: string): string {
  let out = String(input ?? '');
  if (out.length > 600) out = `${out.slice(0, 600)}…`;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Nettoie récursivement les champs texte d'un objet de réponse. */
export function scrubPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return scrubMessage(value);
  if (Array.isArray(value)) return value.map((v) => scrubPayload(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubPayload(v, depth + 1);
    return out;
  }
  return value;
}

/** Champs dont le contenu est nettoyé (les autres passent tels quels). */
const RISKY_KEYS = new Set([
  'error', 'message', 'detail', 'details', 'reason', 'stack', 'cause',
  'stderr', 'hint', 'description', 'errors', 'warning',
]);

/**
 * Middleware : nettoie les réponses d'ERREUR (>= 400) en JSON pour les appelants
 * non admin. Les réponses normales ne sont pas touchées (coût nul sur le chemin
 * chaud), les admins reçoivent le message brut.
 *
 * `isAdmin` est injecté (le vérificateur vit dans index.ts) et ne doit jamais
 * jeter : en cas de doute, on nettoie.
 */
export function scrubErrors(isAdmin: (c: Context) => Promise<boolean>) {
  return async (c: Context, next: () => Promise<void>) => {
    await next();
    const res = c.res;
    if (!res || res.status < 400) return;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) return;
    // Le flux d'un chat en erreur n'est pas rejoué : on ne touche qu'au JSON court.
    const len = Number(res.headers.get('content-length') || '0');
    if (len > 200_000) return;

    let admin = false;
    try { admin = await isAdmin(c); } catch { admin = false; }
    if (admin) return;

    let parsed: unknown;
    try {
      parsed = await res.clone().json();
    } catch {
      return; // corps non relisible : on n'y touche pas
    }
    if (!parsed || typeof parsed !== 'object') return;

    const obj = parsed as Record<string, unknown>;
    let changed = false;
    for (const [k, v] of Object.entries(obj)) {
      if (!RISKY_KEYS.has(k)) continue;
      const cleaned = scrubPayload(v);
      if (JSON.stringify(cleaned) !== JSON.stringify(v)) { obj[k] = cleaned; changed = true; }
    }
    if (!changed) return;

    const headers = new Headers(res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify(obj), { status: res.status, headers });
  };
}
