import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import {
  createLoginGuard, guardLogin, GUARD_POLICIES, lockForCount, attemptsBeforeLock,
  normalizeEmail, maskIdentity, loginClientIp, verifyPasswordConstantTime, type LoginGuard, type SqlClient,
} from './login-guard';

const MIN = 60_000;

function setup() {
  const client = createClient({ url: ':memory:', intMode: 'number' }) as unknown as SqlClient;
  let t = 1_800_000_000_000;
  const clock = { advance: (ms: number) => { t += ms; } };
  const guard = createLoginGuard({ client, now: () => t });
  return { client, guard, clock };
}

/** Une tentative de connexion : `good` = le mot de passe est-il le bon. */
function attempt(guard: LoginGuard, email: string, good: boolean, ip: string | null = '9.9.9.9') {
  return guardLogin(guard, { email, ip }, async () => (good ? { id: 'u1' } : null));
}

describe('paliers de blocage', () => {
  it('compte : 4 essais libres puis 1 min, 5 min, 15 min, 30 min, 1 h', () => {
    const p = GUARD_POLICIES.acct;
    expect([1, 2, 3, 4].map((n) => lockForCount(p, n))).toEqual([0, 0, 0, 0]);
    expect(lockForCount(p, 5)).toBe(MIN);
    expect(lockForCount(p, 6)).toBe(5 * MIN);
    expect(lockForCount(p, 7)).toBe(15 * MIN);
    expect(lockForCount(p, 8)).toBe(30 * MIN);
    expect(lockForCount(p, 9)).toBe(60 * MIN);
    expect(lockForCount(p, 40)).toBe(60 * MIN);
  });
  it('essais restants avant le premier blocage', () => {
    expect(attemptsBeforeLock(GUARD_POLICIES.acct, 1)).toBe(4);
    expect(attemptsBeforeLock(GUARD_POLICIES.acct, 4)).toBe(1);
    expect(attemptsBeforeLock(GUARD_POLICIES.acct, 5)).toBe(0);
    expect(attemptsBeforeLock(GUARD_POLICIES.acct, 9)).toBe(0);
  });
});

describe('identité comptée', () => {
  it('e-mail normalisé (casse, espaces)', () => {
    expect(normalizeEmail('  Bob@Example.COM ')).toBe('bob@example.com');
  });
  it("masque l'adresse pour l'admin", () => {
    expect(maskIdentity('acct', 'jean.dupont@gmail.com')).toBe('je***@gmail.com');
    expect(maskIdentity('ip', '1.2.3.4')).toBe('1.2.3.4');
  });
  it("IP lue sans jamais regarder l'en-tête Authorization", () => {
    const ctx = (h: Record<string, string>) => ({ req: { header: (k: string) => h[k.toLowerCase()] } }) as any;
    expect(loginClientIp(ctx({ authorization: 'Bearer abc' }))).toBeNull();
    expect(loginClientIp(ctx({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('1.1.1.1');
    expect(loginClientIp(ctx({ 'x-forwarded-for': '3.3.3.3, 10.0.0.1' }))).toBe('3.3.3.3');
  });
});

describe('guardLogin — blocage par compte', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it('délais progressifs puis blocage, avec retryAfter en secondes', async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await attempt(s.guard, 'a@x.com', false);
      expect(r).toMatchObject({ kind: 'failed', retryAfter: 0, attemptsLeft: 5 - i });
    }
    expect(await attempt(s.guard, 'a@x.com', false)).toMatchObject({ kind: 'failed', retryAfter: 0, attemptsLeft: 1 });
    // 5e échec → 1 minute d'attente.
    expect(await attempt(s.guard, 'a@x.com', false)).toMatchObject({ kind: 'failed', retryAfter: 60, lockedNow: true, attemptsLeft: 0 });
    expect(await attempt(s.guard, 'a@x.com', false)).toEqual({ kind: 'locked', retryAfter: 60 });
    s.clock.advance(30_000);
    expect(await attempt(s.guard, 'a@x.com', false)).toEqual({ kind: 'locked', retryAfter: 30 });
    s.clock.advance(30_000);
    // 6e échec → 5 minutes.
    expect(await attempt(s.guard, 'a@x.com', false)).toMatchObject({ kind: 'failed', retryAfter: 300 });
    s.clock.advance(5 * MIN);
    expect(await attempt(s.guard, 'a@x.com', false)).toMatchObject({ kind: 'failed', retryAfter: 900 });
  });

  it('le BON mot de passe est refusé tant que le compte est bloqué', async () => {
    for (let i = 0; i < 5; i++) await attempt(s.guard, 'b@x.com', false);
    expect(await attempt(s.guard, 'b@x.com', true)).toMatchObject({ kind: 'locked' });
    s.clock.advance(MIN);
    expect(await attempt(s.guard, 'b@x.com', true)).toMatchObject({ kind: 'ok' });
  });

  it('une connexion réussie remet le compteur du compte à zéro', async () => {
    for (let i = 0; i < 4; i++) await attempt(s.guard, 'c@x.com', false);
    expect(await attempt(s.guard, 'c@x.com', true)).toMatchObject({ kind: 'ok' });
    expect(await attempt(s.guard, 'c@x.com', false)).toMatchObject({ kind: 'failed', attemptsLeft: 4, retryAfter: 0 });
  });

  it("changer d'IP (ou ne pas en donner) ne contourne pas le blocage du compte", async () => {
    for (let i = 0; i < 5; i++) await attempt(s.guard, 'd@x.com', false, `10.0.0.${i}`);
    expect(await attempt(s.guard, 'd@x.com', true, '172.16.0.1')).toMatchObject({ kind: 'locked' });
    expect(await attempt(s.guard, 'd@x.com', true, null)).toMatchObject({ kind: 'locked' });
  });

  it("majuscules et espaces dans l'e-mail ne donnent pas un compteur neuf", async () => {
    for (let i = 0; i < 5; i++) await attempt(s.guard, i % 2 ? ' E@X.com' : 'e@x.COM ', false);
    expect(await attempt(s.guard, 'e@x.com', true)).toMatchObject({ kind: 'locked' });
  });

  it("un e-mail inconnu est traité comme un vrai compte (rien ne trahit l'existence)", async () => {
    const known = []; const unknown = [];
    for (let i = 0; i < 6; i++) {
      known.push(await guardLogin(s.guard, { email: 'real@x.com', ip: null }, async () => null));
      unknown.push(await guardLogin(s.guard, { email: 'ghost@x.com', ip: null }, async () => null));
    }
    expect(unknown).toEqual(known);
  });

  it('le compteur est oublié après 24 h sans tentative', async () => {
    for (let i = 0; i < 4; i++) await attempt(s.guard, 'f@x.com', false);
    s.clock.advance(24 * 60 * MIN + 1);
    expect(await attempt(s.guard, 'f@x.com', false)).toMatchObject({ kind: 'failed', attemptsLeft: 4 });
  });

  it('100 essais envoyés en parallèle ne passent pas tous', async () => {
    let checked = 0;
    const all = await Promise.all(Array.from({ length: 100 }, () =>
      guardLogin(s.guard, { email: 'g@x.com', ip: null }, async () => { checked++; return null; })));
    // 5 essais jugés au maximum (le 5e pose le blocage), tout le reste refusé.
    expect(checked).toBeLessThanOrEqual(5);
    expect(all.filter((r) => r.kind === 'locked').length).toBeGreaterThanOrEqual(95);
  });
});

describe('guardLogin — blocage par IP', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it('une IP qui essaie plein de comptes est bloquée au 20e échec', async () => {
    for (let i = 1; i < 20; i++) expect((await attempt(s.guard, `v${i}@x.com`, false, '6.6.6.6')).kind).toBe('failed');
    expect(await attempt(s.guard, 'v20@x.com', false, '6.6.6.6')).toMatchObject({ kind: 'failed', retryAfter: 300 });
    expect(await attempt(s.guard, 'v21@x.com', true, '6.6.6.6')).toMatchObject({ kind: 'locked', retryAfter: 300 });
    // Une autre IP n'est pas concernée.
    expect(await attempt(s.guard, 'v21@x.com', true, '7.7.7.7')).toMatchObject({ kind: 'ok' });
  });

  it("se connecter à SON compte n'efface pas les échecs faits sur les autres", async () => {
    for (let i = 1; i < 19; i++) await attempt(s.guard, `w${i}@x.com`, false, '5.5.5.5');
    expect(await attempt(s.guard, 'mine@x.com', true, '5.5.5.5')).toMatchObject({ kind: 'ok' });
    await attempt(s.guard, 'w19@x.com', false, '5.5.5.5');
    expect(await attempt(s.guard, 'w20@x.com', false, '5.5.5.5')).toMatchObject({ kind: 'failed', retryAfter: 300 });
  });

  it("un compte bloqué ne fait pas grimper le compteur de l'IP", async () => {
    for (let i = 0; i < 5; i++) await attempt(s.guard, 'h@x.com', false, '4.4.4.4');
    for (let i = 0; i < 30; i++) expect((await attempt(s.guard, 'h@x.com', false, '4.4.4.4')).kind).toBe('locked');
    // 5 échecs réels sur l'IP : il en reste 14 avant son blocage.
    for (let i = 0; i < 14; i++) expect(await attempt(s.guard, `k${i}@x.com`, false, '4.4.4.4')).toMatchObject({ retryAfter: 0 });
  });
});

describe('déblocage, liste admin, e-mails de réinitialisation', () => {
  it("unlock lève le blocage d'un compte (admin ou mot de passe réinitialisé)", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) await attempt(s.guard, 'm@x.com', false, null);
    const locks = await s.guard.locks();
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ scope: 'acct', label: 'm***@x.com', failures: 5 });
    expect(JSON.stringify(locks)).not.toContain('m@x.com');
    expect(await s.guard.unlock('acct', ' M@x.com')).toBe(true);
    expect(await attempt(s.guard, 'm@x.com', true, null)).toMatchObject({ kind: 'ok' });
    expect(await s.guard.unlock('acct', 'm@x.com')).toBe(false);
  });

  it("3 e-mails « mot de passe oublié » par adresse et par heure", async () => {
    const s = setup();
    const sent = [];
    for (let i = 0; i < 6; i++) sent.push((await s.guard.admit('reset', 'r@x.com')).admitted);
    expect(sent).toEqual([true, true, true, false, false, false]);
    s.clock.advance(60 * MIN);
    expect((await s.guard.admit('reset', 'r@x.com')).admitted).toBe(true);
  });
});

describe('verifyPasswordConstantTime', () => {
  it('vrai hash : compare réellement ; pas de hash : bcrypt factice puis false', async () => {
    const hash = await bcrypt.hash('bonmotdepasse', 4);
    expect(await verifyPasswordConstantTime('bonmotdepasse', hash)).toBe(true);
    expect(await verifyPasswordConstantTime('autre', hash)).toBe(false);
    const t0 = performance.now();
    expect(await verifyPasswordConstantTime('bonmotdepasse', null)).toBe(false);
    // Le hash factice est au coût 12 : la réponse prend le temps d'un vrai bcrypt.
    expect(performance.now() - t0).toBeGreaterThan(50);
  }, 20_000);
});
