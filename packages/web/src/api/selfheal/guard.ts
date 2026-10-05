// ─── Garde-fous de l'auto-réparation ────────────────────────────────────────
//
// Ce fichier est la seule chose qui sépare « l'IA répare un bug » de « l'IA
// casse Velbaz en production ». Tout ce qui est refusé ici n'est PAS appliqué :
// c'est envoyé par e-mail pour validation humaine.
//
// Quatre verrous, indépendants les uns des autres :
//
//   1. Interrupteur général (app_config) — coupe tout, instantanément.
//   2. Fichiers interdits — auth, paiements, schéma DB, crypto, secrets, et
//      le module d'auto-réparation lui-même. Jamais patchés automatiquement.
//   3. Contenu sensible — même dans un fichier autorisé, un patch qui touche
//      une session, un mot de passe, une clé, une suppression en base ou une
//      exécution de commande est refusé.
//   4. Cadence — 3 correctifs/heure maximum, et coupe-circuit automatique
//      après 2 annulations consécutives (l'IA se trompe → elle s'arrête).
//
import { db } from '../database/index';
import * as schema from '../database/schema';
import { eq, gte, desc, sql } from 'drizzle-orm';

/** Racine du dépôt — tout patch doit rester à l'intérieur. */
export const REPO_ROOT = '/home/user/velbaz';
/** Seule arborescence patchable. */
export const PATCHABLE_ROOT = 'packages/web/src';

export const MAX_FIXES_PER_HOUR = 3;
export const CIRCUIT_BREAKER_ROLLBACKS = 2;
export const MAX_EDITS_PER_PATCH = 3;
export const MAX_NEW_CHARS_PER_EDIT = 4000;

const KILL_SWITCH_KEY = 'selfheal_enabled';

// ── 2. Fichiers JAMAIS patchés automatiquement ──────────────────────────────
// Chemins relatifs à la racine du dépôt. Un préfixe suffit (dossier entier).
const CRITICAL_PATHS = [
  // Authentification / sessions / accès
  'packages/web/src/api/security.ts',
  'packages/web/src/api/gdpr.ts',
  // Paiements — encaissement réel, argent des clients
  'packages/web/src/api/stripe-connect.ts',
  'packages/web/src/api/revenue/',
  'packages/web/src/api/plans.ts',
  // Base de données — un schéma cassé = données perdues
  'packages/web/src/api/database/',
  // Secrets et chiffrement
  'packages/web/src/api/secret-store.ts',
  'packages/web/src/api/crypto/',
  // Le module d'auto-réparation lui-même : il ne se réécrit pas.
  'packages/web/src/api/selfheal/',
  // Plomberie du template managé (vérifiée par `bun run lint`).
  'packages/web/src/api/__core/',
];

// Fichiers autorisés seulement en lecture pour le diagnostic : jamais modifiés.
const CRITICAL_BASENAMES = ['package.json', 'tsconfig.json', 'vite.config.ts', 'drizzle.config.ts'];

// ── 3. Motifs sensibles : un patch qui les contient est refusé ──────────────
// Testés sur l'ancien ET le nouveau texte de chaque édition : l'IA ne peut ni
// introduire ni supprimer ces zones-là.
const SENSITIVE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\b(bcrypt|scrypt|argon2|createHash|createHmac|createCipher|randomBytes)\b/, why: 'cryptographie' },
  { re: /\b(password|passwordHash|resetToken|sessionToken|bearer)\b/i, why: 'authentification' },
  { re: /\brequireAdmin\b|\bisAdmin\b|\bgetUser\s*\(/, why: 'contrôle d’accès' },
  { re: /\b(stripe|STRIPE_)\w*/i, why: 'paiements' },
  { re: /\b(process\.env|getSecret|decryptSecret|encryptSecret)\b/, why: 'secrets' },
  { re: /db\s*\.\s*delete\s*\(|DROP\s+TABLE|DELETE\s+FROM/i, why: 'suppression de données' },
  { re: /\b(child_process|execSync|spawnSync|\bexec\s*\(|\beval\s*\(|new\s+Function)\b/, why: 'exécution de commandes' },
  { re: /\b(rmSync|unlinkSync|rm\s*\(|rmdir)\b/, why: 'suppression de fichiers' },
];

export interface PatchEdit {
  file: string;   // chemin relatif à la racine du dépôt
  old: string;
  new: string;
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; status: 'blocked_critical' | 'rate_limited' | 'circuit_open'; reason: string };

// ── 1. Interrupteur général ─────────────────────────────────────────────────

/** Faux = auto-réparation désactivée (défaut : activée). */
export async function isSelfHealEnabled(): Promise<boolean> {
  // La variable d'env gagne toujours : coupure possible sans accès à la DB.
  if (process.env.SELFHEAL_DISABLED === '1') return false;
  try {
    const row = await db.select().from(schema.appConfig)
      .where(eq(schema.appConfig.key, KILL_SWITCH_KEY)).get();
    return row?.value !== '0';
  } catch {
    // DB injoignable → on ne patche pas (on ne répare pas à l'aveugle).
    return false;
  }
}

export async function setSelfHealEnabled(enabled: boolean, byUserId?: string): Promise<void> {
  const value = enabled ? '1' : '0';
  const existing = await db.select().from(schema.appConfig)
    .where(eq(schema.appConfig.key, KILL_SWITCH_KEY)).get();
  if (existing) {
    await db.update(schema.appConfig)
      .set({ value, updatedBy: byUserId || null, updatedAt: new Date() })
      .where(eq(schema.appConfig.key, KILL_SWITCH_KEY));
  } else {
    await db.insert(schema.appConfig)
      .values({ key: KILL_SWITCH_KEY, value, updatedBy: byUserId || null });
  }
}

// ── 2. Test « fichier critique » ────────────────────────────────────────────

function normalize(file: string): string {
  let f = file.replace(/\\/g, '/').trim();
  if (f.startsWith(REPO_ROOT)) f = f.slice(REPO_ROOT.length);
  f = f.replace(/^\/+/, '');
  return f;
}

/** Null si le fichier est patchable, sinon la raison du refus. */
export function criticalFileReason(file: string): string | null {
  const f = normalize(file);

  if (!f) return 'chemin vide';
  // Pas de remontée d'arborescence, pas de chemin absolu hors dépôt.
  if (f.includes('..')) return 'chemin relatif suspect (..)';
  if (!f.startsWith(PATCHABLE_ROOT + '/')) return `hors de ${PATCHABLE_ROOT}/`;
  if (!/\.(ts|tsx)$/.test(f)) return 'seuls les fichiers .ts/.tsx sont patchables';

  const base = f.split('/').pop() || '';
  if (CRITICAL_BASENAMES.includes(base)) return `fichier de configuration (${base})`;
  // Plomberie du template : `bun run lint` en vérifie l'intégrité.
  if (base.startsWith('__') || f.includes('/__')) return 'fichier géré par le template (préfixe __)';
  // Les tests sont la référence qui valide les correctifs : l'IA ne les réécrit
  // pas, sinon elle pourrait « réparer » en supprimant la preuve.
  if (/\.test\.(ts|tsx)$/.test(base)) return 'fichier de test (sert de preuve, non modifiable)';

  for (const p of CRITICAL_PATHS) {
    if (f === p || f.startsWith(p)) return `fichier critique (${p})`;
  }
  return null;
}

// ── 3. Test « contenu sensible » ────────────────────────────────────────────

/** Null si le patch est inoffensif, sinon la raison du refus. */
export function sensitiveContentReason(edits: PatchEdit[]): string | null {
  if (edits.length === 0) return 'patch vide';
  if (edits.length > MAX_EDITS_PER_PATCH)
    return `patch trop large (${edits.length} éditions, max ${MAX_EDITS_PER_PATCH})`;

  for (const e of edits) {
    if (e.new.length > MAX_NEW_CHARS_PER_EDIT)
      return `édition trop longue (${e.new.length} caractères, max ${MAX_NEW_CHARS_PER_EDIT})`;
    const haystack = `${e.old}\n${e.new}`;
    for (const { re, why } of SENSITIVE_PATTERNS) {
      if (re.test(haystack)) return `zone sensible : ${why} (${e.file})`;
    }
  }
  return null;
}

// ── 4. Cadence et coupe-circuit ─────────────────────────────────────────────

export interface RateState {
  fixesLastHour: number;
  consecutiveRollbacks: number;
  circuitOpen: boolean;
}

/**
 * État lu en base (donc exact après un redémarrage, qui est justement l'une
 * des actions de ce système).
 */
export async function readRateState(): Promise<RateState> {
  const hourAgo = new Date(Date.now() - 3600_000);

  const applied = await db.select({ c: sql<number>`count(*)` })
    .from(schema.selfHealAttempts)
    .where(sql`${schema.selfHealAttempts.createdAt} >= ${Math.floor(hourAgo.getTime() / 1000)}
               AND ${schema.selfHealAttempts.status} IN ('applied','rolled_back')`)
    .get();

  // Coupe-circuit : on regarde les dernières tentatives qui ont réellement
  // touché au code (les refus de garde-fou ne comptent pas comme des échecs).
  const recent = await db.select({ status: schema.selfHealAttempts.status })
    .from(schema.selfHealAttempts)
    .where(sql`${schema.selfHealAttempts.status} IN ('applied','rolled_back')`)
    .orderBy(desc(schema.selfHealAttempts.createdAt))
    .limit(CIRCUIT_BREAKER_ROLLBACKS)
    .all();

  let consecutiveRollbacks = 0;
  for (const r of recent) {
    if (r.status === 'rolled_back') consecutiveRollbacks++;
    else break;
  }

  return {
    fixesLastHour: Number(applied?.c ?? 0),
    consecutiveRollbacks,
    circuitOpen: consecutiveRollbacks >= CIRCUIT_BREAKER_ROLLBACKS,
  };
}

/**
 * Le verdict complet, avant toute écriture sur disque.
 * `edits` peut être omis pour un pré-contrôle (cadence seulement).
 */
export async function guardPatch(edits?: PatchEdit[]): Promise<GuardVerdict> {
  const state = await readRateState();
  if (state.circuitOpen) {
    return {
      ok: false, status: 'circuit_open',
      reason: `coupe-circuit ouvert : ${state.consecutiveRollbacks} annulations consécutives — réarmement manuel requis`,
    };
  }
  if (state.fixesLastHour >= MAX_FIXES_PER_HOUR) {
    return {
      ok: false, status: 'rate_limited',
      reason: `plafond atteint : ${state.fixesLastHour}/${MAX_FIXES_PER_HOUR} correctifs sur la dernière heure`,
    };
  }

  if (edits) {
    for (const e of edits) {
      const why = criticalFileReason(e.file);
      if (why) return { ok: false, status: 'blocked_critical', reason: `${e.file} : ${why}` };
    }
    const sensitive = sensitiveContentReason(edits);
    if (sensitive) return { ok: false, status: 'blocked_critical', reason: sensitive };
  }

  return { ok: true };
}

/** Réarme le coupe-circuit en neutralisant les annulations passées. */
export async function resetCircuitBreaker(byUserId?: string): Promise<number> {
  const recent = await db.select({ id: schema.selfHealAttempts.id })
    .from(schema.selfHealAttempts)
    .where(eq(schema.selfHealAttempts.status, 'rolled_back'))
    .orderBy(desc(schema.selfHealAttempts.createdAt))
    .limit(10).all();
  if (recent.length === 0) return 0;
  let n = 0;
  for (const r of recent) {
    await db.update(schema.selfHealAttempts)
      .set({ status: 'failed', rollbackReason: `annulation acquittée${byUserId ? ` par ${byUserId}` : ''}` })
      .where(eq(schema.selfHealAttempts.id, r.id));
    n++;
  }
  return n;
}
