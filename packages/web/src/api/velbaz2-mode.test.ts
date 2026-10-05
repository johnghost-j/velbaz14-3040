import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runWithModelMode,
  activateVelbaz2,
  isVelbaz2Active,
  mapModelId,
  VELBAZ2_SUBSTITUTIONS,
  VELBAZ2_TEXT_MODEL,
  VELBAZ2_IMAGE_MODEL,
} from './agent/model-mode';
import { capTier, ADMIN_ONLY_TIERS, PUBLIC_TIER } from './plans';

const read = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8');

describe('Velbaz 2.0 — substitution de modèles', () => {
  it('ne substitue RIEN hors du mode', () => {
    expect(isVelbaz2Active()).toBe(false);
    expect(mapModelId('anthropic/claude-sonnet-4.6')).toBe('anthropic/claude-sonnet-4.6');
    expect(mapModelId('openai/gpt-5.4-mini')).toBe('openai/gpt-5.4-mini');
    expect(mapModelId('google/gemini-3.1-flash-lite-image')).toBe('google/gemini-3.1-flash-lite-image');
  });

  it('remplace les trois modèles visés quand le mode est actif', () => {
    runWithModelMode(() => {
      activateVelbaz2();
      expect(isVelbaz2Active()).toBe(true);
      expect(mapModelId('anthropic/claude-sonnet-4.6')).toBe(VELBAZ2_TEXT_MODEL);
      expect(mapModelId('openai/gpt-5.4-mini')).toBe(VELBAZ2_TEXT_MODEL);
      expect(mapModelId('google/gemini-3.1-flash-lite-image')).toBe(VELBAZ2_IMAGE_MODEL);
    });
  });

  it('remplace TOUT Claude (haiku, sonnet-5, opus, test de clé…) par Luna', () => {
    runWithModelMode(() => {
      activateVelbaz2();
      for (const id of [
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-sonnet-4.5',
        'anthropic/claude-opus-4.7',
        'anthropic/claude-3-5-haiku-latest',
        'anthropic/claude-futur-9',
      ]) {
        expect(mapModelId(id)).toBe(VELBAZ2_TEXT_MODEL);
      }
    });
    // Hors mode, Claude reste Claude.
    expect(mapModelId('anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5');
  });

  it('aucun id anthropic/* figé dans le code ne survit au mode', () => {
    const files = new Bun.Glob('**/*.ts').scanSync({ cwd: import.meta.dir });
    const ids = new Set<string>();
    for (const f of files) {
      if (f.endsWith('.test.ts') || f.startsWith('builder/scaffold')) continue;
      for (const m of read(f).matchAll(/['"`](anthropic\/claude-[a-z0-9.-]+)['"`]/g)) ids.add(m[1]);
    }
    expect(ids.size).toBeGreaterThan(0);
    runWithModelMode(() => {
      activateVelbaz2();
      for (const id of ids) expect(mapModelId(id)).toBe(VELBAZ2_TEXT_MODEL);
    });
  });

  it("la course au premier mot ne lance pas deux fois Luna", () => {
    const src = read('agents/orchestrator.ts');
    expect(src).toMatch(/function safeStreamTextRace[\s\S]{0,800}mapModelId\(m\)/);
  });

  it('laisse passer les modèles hors périmètre (nano, uncensored)', () => {
    runWithModelMode(() => {
      activateVelbaz2();
      for (const id of [
        'openai/gpt-5.4-nano',
        'openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ]) {
        expect(mapModelId(id)).toBe(id);
      }
    });
  });

  it("le scope ne fuit pas hors de la requête qui l'a ouvert", () => {
    runWithModelMode(() => activateVelbaz2());
    expect(isVelbaz2Active()).toBe(false);
    expect(mapModelId('openai/gpt-5.4-mini')).toBe('openai/gpt-5.4-mini');
  });

  it('activateVelbaz2 est inopérant sans scope (jobs de fond non instrumentés)', () => {
    activateVelbaz2();
    expect(isVelbaz2Active()).toBe(false);
  });

  it('le mode est hérité par le travail asynchrone lancé dans le scope', async () => {
    const seen = await runWithModelMode(async () => {
      activateVelbaz2();
      await new Promise((r) => setTimeout(r, 1));
      return mapModelId('anthropic/claude-sonnet-4.6');
    });
    expect(seen).toBe(VELBAZ2_TEXT_MODEL);
    expect(isVelbaz2Active()).toBe(false);
  });

  it('gemini-3-flash (course au premier mot, JSON du builder, vision) passe aussi sur Luna', () => {
    expect(mapModelId('google/gemini-3-flash')).toBe('google/gemini-3-flash');
    runWithModelMode(() => {
      activateVelbaz2();
      expect(mapModelId('google/gemini-3-flash')).toBe(VELBAZ2_TEXT_MODEL);
      // Les 3 concurrents de la course (haiku, gpt-5.4-mini, gemini-3-flash)
      // se réduisent à UN seul modèle effectif : Luna.
      const eff = new Set(['anthropic/claude-haiku-4.5', 'openai/gpt-5.4-mini', 'google/gemini-3-flash'].map(mapModelId));
      expect([...eff]).toEqual([VELBAZ2_TEXT_MODEL]);
    });
  });

  it('texte = GPT 6 Luna, image = un générateur réellement joignable par le gateway', () => {
    expect(VELBAZ2_TEXT_MODEL).toBe('openai/gpt-6-luna');
    // Le gateway Runable n'expose aucun endpoint image : seuls les modèles
    // Gemini « language » multimodaux génèrent des images (generateText +
    // response_modalities). Un id de type image (flux, gpt-image, recraft,
    // seedream…) planterait en production — d'où ce garde-fou.
    expect(VELBAZ2_IMAGE_MODEL.startsWith('google/gemini-')).toBe(true);
    expect(VELBAZ2_IMAGE_MODEL).toContain('image');
  });
});

// [2026-10-03] « Velbaz 2.0 » renommé « Velbaz » : le modèle unique de TOUS
// les comptes normaux. Les autres paliers sont réservés à l'admin.
describe('Velbaz — modèle de tout le monde', () => {
  it('capTier : un compte normal est TOUJOURS en Velbaz, sur tous les plans', () => {
    for (const plan of ['free', 'business', 'enterprise', null, undefined]) {
      expect(capTier(undefined, plan)).toBe('velbaz2');
      expect(capTier('velbaz2', plan)).toBe('velbaz2');
    }
  });

  it('capTier : un palier forgé par un compte normal est ignoré', () => {
    for (const forged of ['max', 'luna', 'pro', 'lite', 'n-importe-quoi']) {
      expect(capTier(forged, 'free')).toBe(PUBLIC_TIER);
      expect(capTier(forged, 'business', { admin: false })).toBe(PUBLIC_TIER);
      expect(capTier(forged, 'enterprise')).toBe(PUBLIC_TIER);
    }
  });

  it("capTier : l'admin garde tous les paliers, Velbaz par défaut", () => {
    for (const t of ['velbaz2', 'luna', 'max', 'pro', 'lite'] as const) {
      expect(capTier(t, 'free', { admin: true })).toBe(t);
    }
    expect(capTier(undefined, 'free', { admin: true })).toBe('velbaz2');
    expect(capTier('inconnu', 'free', { admin: true })).toBe('velbaz2');
  });

  it('velbaz2 est le palier public, tous les autres sont admin-only', () => {
    expect(PUBLIC_TIER).toBe('velbaz2');
    expect(ADMIN_ONLY_TIERS).not.toContain('velbaz2');
    expect([...ADMIN_ONLY_TIERS].sort()).toEqual(['lite', 'luna', 'max', 'pro']);
  });

  it('le plan ne plafonne plus le modèle (maxTier / advancedModels retirés)', () => {
    const plans = read('./plans.ts');
    expect(plans).not.toMatch(/maxTier/);
    expect(plans).not.toMatch(/advancedModels/);
  });
});

describe('Velbaz 2.0 — câblage', () => {
  it('gateway() substitue AVANT de router vers un provider', () => {
    const gw = read('./agent/gateway.ts');
    // La substitution doit être la première chose faite : si elle passait après
    // le routage, un id substitué partirait chez le provider de l'id d'origine.
    const body = gw.slice(gw.indexOf('export function gateway('));
    expect(body).toContain('mapModelId(requestedModelId)');
    expect(body.indexOf('mapModelId(requestedModelId)')).toBeLessThan(
      body.indexOf('modelId.startsWith("openrouter/")'),
    );
    // `meter()` doit recevoir l'id SUBSTITUÉ : c'est lui qui facture l'appel.
    expect(body).not.toContain('requestedModelId,');
  });

  it('le scope est ouvert par le middleware global, pas par chaque route', () => {
    expect(read('./index.ts')).toContain('runWithModelMode(() => next())');
  });

  it('les routes de build appliquent le mode du compte (velbazModeForUser)', () => {
    const idx = read('./index.ts');
    // applyVelbaz2Mode = velbazModeForUser : compte normal → toujours Velbaz,
    // admin → son choix mémorisé. Seule porte d'entrée hors palier de chat.
    expect(idx).toMatch(/async function applyVelbaz2Mode[\s\S]{0,300}velbazModeForUser\(user\)/);
    expect(idx.match(/applyVelbaz2Mode\(user\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('le palier de chat arme le mode AVANT les branches qui rendent tôt', () => {
    const idx = read('./index.ts');
    const route = idx.slice(idx.indexOf("app.post('/chat/stream'"), idx.indexOf("app.post('/chat',"));
    const armed = route.indexOf('resolveChatModel(tier, model, chatUser)');
    expect(armed).toBeGreaterThan(-1);
    // Conversion mobile et reprise d'un build annulé rendent avant la fin de la
    // route : armé après elles, le mode ne s'appliquait pas à ces jobs.
    expect(armed).toBeLessThan(route.indexOf('streamAddPlatform(c,'));
    expect(armed).toBeLessThan(route.indexOf('startBuildWebsite('));
    // Et le palier admin doit passer par capTier (porte admin) plutôt que par
    // une comparaison brute sur le tier reçu du client.
    expect(idx).toMatch(/async function applyVelbaz2Tier[\s\S]{0,1200}capTier\(/);
    // Le modèle du chat et le mode du pipeline sortent de la MÊME décision.
    expect(idx).toMatch(/async function resolveChatModel[\s\S]{0,400}applyVelbaz2Tier\(tier, user\)/);
    // Plus aucun `model` brut honoré selon le plan.
    expect(idx).not.toContain("'advancedModels'");
  });

  it('la table de substitution cible bien les constantes figées dans le code', () => {
    // Si un jour CODE_MODEL/IMAGE_MODEL changent de valeur, la substitution
    // devient silencieusement inopérante : ce test casse à ce moment-là.
    const engine = read('./builder/engine.ts');
    const gwFile = read('./agent/gateway.ts');
    const codeModel = engine.match(/CODE_MODEL\s*=\s*["']([^"']+)["']/)?.[1];
    const imageModel = gwFile.match(/process\.env\.IMAGE_MODEL \|\| "([^"]+)"/)?.[1];
    expect(codeModel).toBeTruthy();
    expect(imageModel).toBeTruthy();
    expect(Object.keys(VELBAZ2_SUBSTITUTIONS)).toContain(codeModel!);
    expect(Object.keys(VELBAZ2_SUBSTITUTIONS)).toContain(imageModel!);
  });
});

// [2026-10-03] Chaque étape de build enregistre le mode dans lequel elle a
// tourné, sans que les ~150 sites d'insert aient à le passer.
describe('Velbaz 2.0 — agent_activity.model_mode', () => {
  const { drizzle } = require('drizzle-orm/libsql');
  const { createClient } = require('@libsql/client');
  const schema = require('./database/schema');
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  const row = { id: 'x', companyId: 'c', agentRole: 'engineering', action: 'executing', message: 'm' };
  const modeParam = () => {
    const q = db.insert(schema.agentActivity).values(row).toSQL();
    // Les colonnes nulles / à défaut SQL sont inlinées (null, (unixepoch())) :
    // seuls les « ? » consomment un paramètre, on les compte jusqu'à model_mode.
    const cols = q.sql.match(/\(([^)]*)\) values/)![1].split(',').map((s: string) => s.trim().replace(/"/g, ''));
    const vals = q.sql.match(/values \((.*)\)$/)![1].split(/,\s*(?![^(]*\))/);
    const i = cols.indexOf('model_mode');
    expect(vals[i].trim()).toBe('?');
    return q.params[vals.slice(0, i).filter((v: string) => v.trim() === '?').length];
  };

  it('vaut "velbaz2" quand l\'insert part du mode', () => {
    runWithModelMode(() => {
      activateVelbaz2();
      expect(modeParam()).toBe('velbaz2');
    });
  });

  it('vaut "normal" hors du mode', () => {
    expect(modeParam()).toBe('normal');
    runWithModelMode(() => expect(modeParam()).toBe('normal'));
  });

  it('est renvoyé au front par GET /jobs', () => {
    expect(read('index.ts')).toContain('modelMode: a.modelMode || undefined');
  });

  it('openai/gpt-6-luna a un vrai tarif (pas DEFAULT_PRICE)', () => {
    const { MODEL_PRICES } = require('./ai-usage/pricing');
    expect(MODEL_PRICES[VELBAZ2_TEXT_MODEL]).toBeTruthy();
  });
});
