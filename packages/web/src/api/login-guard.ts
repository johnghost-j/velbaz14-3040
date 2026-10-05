// ─── Protection anti-force-brute de la connexion par mot de passe ───────────
// [2026-10-04] Avant, `POST /auth/login` n'avait qu'un rate-limit mémoire de
// 10 requêtes/min « par client », et ce client était dérivé de l'en-tête
// Authorization : en changeant cet en-tête à chaque requête, on obtenait un
// compteur neuf. Aucun blocage par compte, aucun délai, et un compte inexistant
// répondait plus vite (pas de bcrypt) → on pouvait deviner quels e-mails
// existent.
//
// Ce module :
//   • compte les tentatives PAR COMPTE (e-mail normalisé) — indépendant de l'IP
//     et des en-têtes, donc impossible à contourner en changeant d'IP ;
//   • compte aussi PAR IP (attaque d'un mot de passe sur plein de comptes) ;
//   • impose des délais qui grandissent à chaque échec, puis un blocage long ;
//   • persiste tout en base (table `login_attempts`) : un redémarrage du
//     serveur ne remet pas les compteurs à zéro ;
//   • réserve chaque tentative AVANT de vérifier le mot de passe, en une seule
//     requête SQL atomique : 100 requêtes envoyées en parallèle ne donnent pas
//     100 essais, la première qui pose un blocage ferme la porte aux autres ;
//   • traite un e-mail inconnu exactement comme un vrai compte (même compteur,
//     même bcrypt sur un hash factice, même message) : rien ne trahit qu'un
//     compte existe.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Context } from 'hono';

/** Le strict nécessaire de @libsql/client, pour pouvoir tester sur une base mémoire. */
export interface SqlClient {
  execute(stmt: string | { sql: string; args: Record<string, string | number | null> | Array<string | number | null> }): Promise<{ rows: ArrayLike<Record<string, unknown>> }>;
}

export type GuardScope = 'acct' | 'ip' | 'reset';

export interface GuardPolicy {
  /** Paliers `[à partir de la N-ième tentative, blocage en ms]`, croissants. */
  steps: ReadonlyArray<readonly [number, number]>;
  /** Sans nouvelle tentative pendant ce temps, le compteur repart de zéro. */
  forgetAfterMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const GUARD_POLICIES: Record<GuardScope, GuardPolicy> = {
  // Compte : 4 essais libres (fautes de frappe), puis 1 min, 5 min, 15 min,
  // 30 min, et 1 h après chaque nouvel échec. ≈ 30 essais par jour au maximum.
  acct: { steps: [[5, MIN], [6, 5 * MIN], [7, 15 * MIN], [8, 30 * MIN], [9, HOUR]], forgetAfterMs: 24 * HOUR },
  // IP : 19 échecs tous comptes confondus, puis 5 min, 15 min, 1 h.
  ip: { steps: [[20, 5 * MIN], [25, 15 * MIN], [30, HOUR]], forgetAfterMs: 6 * HOUR },
  // E-mails « mot de passe oublié » : 3 par adresse et par heure.
  reset: { steps: [[3, HOUR]], forgetAfterMs: HOUR },
};

/** Blocage (ms) posé après la `n`-ième tentative. */
export function lockForCount(policy: GuardPolicy, n: number): number {
  let ms = 0;
  for (const [from, lock] of policy.steps) if (n >= from) ms = lock;
  return ms;
}

/** Essais encore possibles avant de devoir attendre (le dernier d'entre eux déclenche l'attente ; 0 = attente à chaque échec). */
export function attemptsBeforeLock(policy: GuardPolicy, n: number): number {
  return Math.max(0, policy.steps[0][0] - n);
}

/** Même calcul que `lockForCount`, en SQL, sur une expression qui donne `n`. */
function lockSql(policy: GuardPolicy, n: string): string {
  const branches = [...policy.steps].reverse().map(([from, lock]) => `WHEN ${n} >= ${Number(from)} THEN ${Number(lock)}`);
  return `(CASE ${branches.join(' ')} ELSE 0 END)`;
}

/** E-mail tel que compté : sans espaces ni majuscules (`Bob@X.com ` = `bob@x.com`). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `jean.dupont@gmail.com` → `je***@gmail.com` : lisible par l'admin, sans stocker l'adresse. */
export function maskIdentity(scope: GuardScope, value: string): string {
  if (scope === 'ip') return value;
  const at = value.lastIndexOf('@');
  if (at < 1) return value.slice(0, 2) + '***';
  return value.slice(0, Math.min(2, at)) + '***' + value.slice(at);
}

function keyFor(scope: GuardScope, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}

/**
 * IP du visiteur pour les compteurs de connexion. Ne dépend PAS de l'en-tête
 * Authorization. Ordre : Cloudflare (posé par le CDN de prod), puis Fly, puis
 * les en-têtes de proxy classiques. Ces en-têtes restent falsifiables si l'on
 * contourne le CDN : c'est pour ça que le blocage PAR COMPTE, lui, n'utilise
 * jamais l'IP. `null` quand aucune IP n'est connue (on ne mélange pas tous les
 * visiteurs anonymes dans un seul compteur IP).
 */
export function loginClientIp(c: Context): string | null {
  const pick = (h: string) => (c.req.header(h) || '').split(',')[0].trim();
  return pick('cf-connecting-ip') || pick('fly-client-ip') || pick('x-forwarded-for') || pick('x-real-ip') || null;
}

export interface Admitted { admitted: true; scope: GuardScope; key: string; ticket: string; count: number; lockedUntil: number }
export interface Refused { admitted: false; scope: GuardScope; retryAfterMs: number }
export type Admission = Admitted | Refused;

export interface LockRow { key: string; scope: GuardScope; label: string; failures: number; lockedUntil: number; lastAt: number }

export interface GuardDeps {
  client: SqlClient;
  now?: () => number;
}

export function createLoginGuard(deps: GuardDeps) {
  const { client } = deps;
  const now = deps.now ?? Date.now;
  let tableReady: Promise<void> | null = null;
  let lastPrune = 0;

  function ensureTable(): Promise<void> {
    // Mémo réinitialisé en cas d'échec : une panne réseau au démarrage ne doit
    // pas laisser la table manquante jusqu'au prochain redémarrage.
    tableReady ??= (async () => {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS login_attempts (
          key TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          label TEXT NOT NULL,
          failures INTEGER NOT NULL DEFAULT 0,
          locked_until INTEGER NOT NULL DEFAULT 0,
          last_at INTEGER NOT NULL DEFAULT 0,
          ticket TEXT
        )`);
      await client.execute(`CREATE INDEX IF NOT EXISTS login_attempts_locked_idx ON login_attempts (locked_until)`);
    })().catch((e) => { tableReady = null; throw e; });
    return tableReady;
  }

  /** Supprime les compteurs oubliés, au plus une fois toutes les 10 minutes. */
  async function prune(t: number) {
    if (t - lastPrune < 10 * MIN) return;
    lastPrune = t;
    const oldest = Math.max(...Object.values(GUARD_POLICIES).map((p) => p.forgetAfterMs));
    await client.execute({
      sql: `DELETE FROM login_attempts WHERE locked_until < :now AND last_at < :cutoff`,
      args: { now: t, cutoff: t - oldest },
    });
  }

  /**
   * Réserve une tentative. Une seule instruction SQL (donc atomique) :
   *   • bloqué → rien ne change, on renvoie le temps restant ;
   *   • sinon → compteur +1 (ou 1 si oublié), et le blocage correspondant à ce
   *     nouveau compte est posé TOUT DE SUITE, avant même de vérifier le mot de
   *     passe. Une connexion réussie efface ensuite le compteur.
   * Le `ticket` aléatoire dit sans ambiguïté si CETTE requête a été admise.
   */
  async function admit(scope: GuardScope, value: string): Promise<Admission> {
    await ensureTable();
    const policy = GUARD_POLICIES[scope];
    const t = now();
    const key = keyFor(scope, value);
    const ticket = randomUUID();
    const next = `(CASE WHEN last_at < :stale THEN 1 ELSE failures + 1 END)`;
    const res = await client.execute({
      sql: `
        INSERT INTO login_attempts (key, scope, label, failures, locked_until, last_at, ticket)
        VALUES (:key, :scope, :label, 1, :firstLock, :now, :ticket)
        ON CONFLICT(key) DO UPDATE SET
          failures     = CASE WHEN locked_until > :now THEN failures ELSE ${next} END,
          locked_until = CASE WHEN locked_until > :now THEN locked_until ELSE :now + ${lockSql(policy, next)} END,
          last_at      = CASE WHEN locked_until > :now THEN last_at ELSE :now END,
          ticket       = CASE WHEN locked_until > :now THEN ticket ELSE :ticket END
        RETURNING failures, locked_until, ticket`,
      args: {
        key, scope, label: maskIdentity(scope, value), ticket, now: t,
        stale: t - policy.forgetAfterMs,
        firstLock: t + lockForCount(policy, 1),
      },
    });
    await prune(t);
    const row = res.rows[0];
    const lockedUntil = Number(row.locked_until);
    if (row.ticket !== ticket) return { admitted: false, scope, retryAfterMs: Math.max(0, lockedUntil - t) };
    return { admitted: true, scope, key, ticket, count: Number(row.failures), lockedUntil };
  }

  /** Mot de passe correct : le compteur du compte repart de zéro. */
  async function clear(adm: Admitted) {
    await client.execute({ sql: `DELETE FROM login_attempts WHERE key = :key`, args: { key: adm.key } });
  }

  /**
   * Annule la réservation (tentative non jugée, ou réussie sur un compteur
   * qu'on ne remet pas à zéro — l'IP : se connecter à SON compte ne doit pas
   * effacer les échecs faits sur ceux des autres).
   * Si aucune autre tentative n'a été admise depuis (même ticket), le blocage
   * en place est celui que CETTE réservation a posé : il est levé aussi.
   */
  async function release(adm: Admitted) {
    await client.execute({
      sql: `UPDATE login_attempts SET
              failures = MAX(failures - 1, 0),
              locked_until = CASE WHEN ticket = :ticket THEN 0 ELSE locked_until END
            WHERE key = :key`,
      args: { key: adm.key, ticket: adm.ticket },
    });
  }

  /** Déblocage d'un compte (admin, ou mot de passe réinitialisé par e-mail). */
  async function unlock(scope: GuardScope, value: string): Promise<boolean> {
    await ensureTable();
    const v = scope === 'ip' ? value.trim() : normalizeEmail(value);
    const res = await client.execute({ sql: `DELETE FROM login_attempts WHERE key = :key RETURNING key`, args: { key: keyFor(scope, v) } });
    return res.rows.length > 0;
  }

  async function locks(): Promise<LockRow[]> {
    await ensureTable();
    const res = await client.execute({
      sql: `SELECT key, scope, label, failures, locked_until, last_at FROM login_attempts WHERE locked_until > :now ORDER BY locked_until DESC LIMIT 200`,
      args: { now: now() },
    });
    return Array.from(res.rows, (r) => ({
      key: String(r.key), scope: String(r.scope) as GuardScope, label: String(r.label),
      failures: Number(r.failures), lockedUntil: Number(r.locked_until), lastAt: Number(r.last_at),
    }));
  }

  return { admit, clear, release, unlock, locks, now };
}

export type LoginGuard = ReturnType<typeof createLoginGuard>;

// ── Vérification du mot de passe à temps constant ──────────────────────────
// Un e-mail inconnu passe aussi par bcrypt (sur un hash factice au même coût
// que les vrais, 12) : la durée de la réponse ne dit pas si le compte existe.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash(randomBytes(32).toString('hex'), 12);
  return dummyHash;
}

export async function verifyPasswordConstantTime(password: string, hash: string | null | undefined): Promise<boolean> {
  if (hash) return bcrypt.compare(password, hash);
  await bcrypt.compare(password, await getDummyHash());
  return false;
}

// ── Orchestration d'une tentative de connexion ─────────────────────────────

export type LoginOutcome<U> =
  | { kind: 'ok'; user: U }
  | { kind: 'locked'; retryAfter: number }
  | { kind: 'failed'; retryAfter: number; attemptsLeft: number; lockedNow: boolean };

/**
 * Réserve la tentative (IP puis compte), lance `verify`, puis solde les
 * compteurs. `retryAfter` est en secondes (arrondi au supérieur).
 */
export async function guardLogin<U>(
  guard: LoginGuard,
  input: { email: string; ip: string | null },
  verify: () => Promise<U | null>,
): Promise<LoginOutcome<U>> {
  const email = normalizeEmail(input.email);
  const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

  const ipAdm = input.ip ? await guard.admit('ip', input.ip) : null;
  if (ipAdm && !ipAdm.admitted) return { kind: 'locked', retryAfter: secs(ipAdm.retryAfterMs) };

  const acct = await guard.admit('acct', email);
  if (!acct.admitted) {
    // Aucun mot de passe testé : la réservation IP est rendue.
    if (ipAdm?.admitted) await guard.release(ipAdm);
    return { kind: 'locked', retryAfter: secs(acct.retryAfterMs) };
  }

  const user = await verify();
  if (user) {
    await guard.clear(acct);
    if (ipAdm?.admitted) await guard.release(ipAdm);
    return { kind: 'ok', user };
  }

  const t = guard.now();
  const until = Math.max(acct.lockedUntil, ipAdm?.admitted ? ipAdm.lockedUntil : 0);
  return {
    kind: 'failed',
    retryAfter: until > t ? secs(until - t) : 0,
    attemptsLeft: attemptsBeforeLock(GUARD_POLICIES.acct, acct.count),
    lockedNow: acct.lockedUntil > t,
  };
}
