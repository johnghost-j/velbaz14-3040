// [2026-10-03] Régression « même en Velbaz 2.0, ça utilise toujours
// anthropic/claude-sonnet-4.6 ». Le mode mémorisé (flag admin) n'était relu que
// par 3 routes ; validation de produit / synchro catalogue / selfheal partaient
// sur Claude, et un appel de chat SANS palier remettait le flag à 0.
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runWithModelMode,
  isVelbaz2Active,
  mapModelId,
  applyRememberedVelbaz2,
  setVelbaz2ForRequest,
  VELBAZ2_TEXT_MODEL,
} from './agent/model-mode';
import { applyRememberedVelbaz2ForUser, runWithRememberedVelbaz2, resetVelbaz2FlagCache, velbazModeForUser } from './agent/velbaz2-flag';

const read = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8');
const SONNET = 'anthropic/claude-sonnet-4.6';
const ADMIN = { email: 'x@y.z', role: 'admin' };
const USER = { email: 'client@y.z', role: 'user' };
/** Simule le flag en base sans toucher à la base (cache du module). */
const setCachedFlag = (value: boolean) => { (globalThis as any).__velbaz2_flag_cache = { value, at: Date.now() }; };

afterEach(() => resetVelbaz2FlagCache());

describe('Velbaz 2.0 mémorisé — scope de requête', () => {
  it('le mode mémorisé bascule la requête (toutes les routes, pas que le build)', () => {
    runWithModelMode(() => {
      applyRememberedVelbaz2(true);
      expect(isVelbaz2Active()).toBe(true);
      expect(mapModelId(SONNET)).toBe(VELBAZ2_TEXT_MODEL);
    });
  });

  it('un palier normal choisi explicitement gagne sur le mode mémorisé', () => {
    runWithModelMode(() => {
      applyRememberedVelbaz2(true);   // checkAuth (flag = 1)
      setVelbaz2ForRequest(false);    // palier « lite » envoyé par le chat
      applyRememberedVelbaz2(true);   // getUser() rappelé plus bas
      expect(isVelbaz2Active()).toBe(false);
      expect(mapModelId(SONNET)).toBe(SONNET);
    });
  });

  it('sans scope : inopérant', () => {
    applyRememberedVelbaz2(true);
    expect(isVelbaz2Active()).toBe(false);
  });
});

describe('Velbaz mémorisé — choix admin, compte normal toujours en Velbaz', () => {
  it('admin + flag → Luna, y compris pour le travail lancé en fond depuis la requête', async () => {
    setCachedFlag(true);
    await runWithModelMode(async () => {
      expect(await applyRememberedVelbaz2ForUser(ADMIN)).toBe(true);
      const bg = await new Promise<string>((r) => setTimeout(() => r(mapModelId(SONNET)), 1));
      expect(bg).toBe(VELBAZ2_TEXT_MODEL);
    });
  });

  // [2026-10-03] Velbaz est devenu le modèle de tout le monde : un compte
  // normal y est TOUJOURS, que le flag admin soit allumé ou éteint.
  it('non-admin : toujours Velbaz, flag allumé OU éteint', async () => {
    for (const flag of [true, false]) {
      setCachedFlag(flag);
      await runWithModelMode(async () => {
        expect(await applyRememberedVelbaz2ForUser(USER)).toBe(true);
        expect(mapModelId(SONNET)).toBe(VELBAZ2_TEXT_MODEL);
      });
    }
  });

  it('velbazModeForUser : normal → true ; admin → son flag ; aucun compte → false', async () => {
    setCachedFlag(false);
    expect(await velbazModeForUser(USER)).toBe(true);
    expect(await velbazModeForUser({ email: 'free@y.z', role: null })).toBe(true);
    expect(await velbazModeForUser(ADMIN)).toBe(false);
    setCachedFlag(true);
    expect(await velbazModeForUser(ADMIN)).toBe(true);
    expect(await velbazModeForUser(null)).toBe(false);
  });

  it('flag éteint : modèles normaux', async () => {
    setCachedFlag(false);
    await runWithModelMode(async () => {
      await applyRememberedVelbaz2ForUser(ADMIN);
      expect(mapModelId(SONNET)).toBe(SONNET);
    });
  });

  it('job hors requête (selfheal) : suit le flag dans son propre scope', async () => {
    setCachedFlag(true);
    expect(await runWithRememberedVelbaz2(async () => mapModelId(SONNET))).toBe(VELBAZ2_TEXT_MODEL);
    setCachedFlag(false);
    expect(await runWithRememberedVelbaz2(async () => mapModelId(SONNET))).toBe(SONNET);
    expect(mapModelId(SONNET)).toBe(SONNET); // ne fuit pas après
  });
});

describe('Velbaz 2.0 mémorisé — câblage', () => {
  it("checkAuth applique le mode (chemin en cache ET chemin base)", () => {
    const idx = read('./index.ts');
    const body = idx.slice(idx.indexOf('async function checkAuth('), idx.indexOf('async function getUser(c: any)'));
    expect(body.match(/applyRememberedVelbaz2ForUser\(/g)?.length).toBe(2);
  });

  it('le getUser du builder applique aussi le mode', () => {
    const r = read('./builder/routes.ts');
    const body = r.slice(r.indexOf('async function getUser('), r.indexOf('async function ownedCompany('));
    expect(body).toContain('applyRememberedVelbaz2ForUser(user)');
  });

  it("un appel de chat sans palier ne remet plus le flag à 0", () => {
    const idx = read('./index.ts');
    const fn = idx.slice(idx.indexOf('async function applyVelbaz2Tier('));
    const noTier = fn.indexOf('if (!tier)');
    expect(noTier).toBeGreaterThan(-1);
    expect(noTier).toBeLessThan(fn.indexOf('setVelbaz2Flag(false'));
  });

  it("selfheal ouvre un scope qui suit le flag", () => {
    expect(read('./selfheal/healer.ts')).toMatch(/runWithRememberedVelbaz2\(\(\) => runWithAiContext\(\s*\{ feature: 'selfheal-diagnose' \}/);
  });

  it("plus de lecture du flag en double dans index.ts", () => {
    const idx = read('./index.ts');
    expect(idx).not.toContain("async function getVelbaz2Flag(");
    expect(idx).not.toContain("async function setVelbaz2Flag(");
  });
});

describe('Velbaz — jobs planifiés hors requête', () => {
  it("autopilot, heartbeat, money-maker et monitor social suivent le mode du propriétaire", () => {
    expect(read('./autopilot.ts')).toContain("runWithVelbazModeForCompany(config.companyId, () => tick(config.companyId))");
    expect(read('./autopilot.ts')).toContain("import { runWithVelbazModeForCompany } from './agent/velbaz2-flag'");
    expect(read('./money-maker.ts')).toMatch(/runWithVelbazModeForUser\(cfg\.userId,[\s\S]{0,120}reconcileSlots\(cfg\.userId\)[\s\S]{0,80}bossTick\(cfg\.userId\)/);
    expect(read('./money-maker.ts')).toContain("import { runWithVelbazModeForUser } from './agent/velbaz2-flag'");
    expect(read('./index.ts')).toContain('runWithVelbazModeForCompany(company.id, () => runHeartbeatWithCheckpoint(company.id))');
    expect(read('./social/monitor.ts').match(/runWithVelbazModeForCompany\([^,]+, \(\) => runEngagementBrain\(/g)?.length).toBe(2);
  });
});
