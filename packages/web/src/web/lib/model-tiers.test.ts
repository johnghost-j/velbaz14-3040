import { describe, it, expect } from 'bun:test';
import { modelTiers, canPickModel, resolveTier, DEFAULT_TIER, ADMIN_ONLY_TIERS, PUBLIC_TIER } from './model-tiers';
import { capTier, ADMIN_ONLY_TIERS as SERVER_ADMIN_ONLY_TIERS, PUBLIC_TIER as SERVER_PUBLIC_TIER } from '../../api/plans';

// Ce qui compte ici : un compte normal ne doit NI voir NI router un autre
// palier que Velbaz, même si la valeur traîne en localStorage ou est forgée.

// [2026-10-03] « Velbaz 2.0 » renommé « Velbaz » : modèle UNIQUE des comptes
// normaux (pas de sélecteur). L'admin garde tout.
describe('modelTiers', () => {
  it("un compte normal n'a qu'un modèle : Velbaz", () => {
    const tiers = modelTiers(false);
    expect(tiers.map((t) => t.id)).toEqual(['velbaz2']);
    expect(tiers[0].label).toBe('Velbaz');
    expect(canPickModel(false)).toBe(false);
  });

  it("l'admin voit tout, Velbaz en tête", () => {
    expect(modelTiers(true).map((t) => t.id)).toEqual(['velbaz2', 'max', 'luna', 'pro', 'lite']);
    expect(canPickModel(true)).toBe(true);
  });

  it('nomme le palier interne « GPT 6 Luna »', () => {
    expect(modelTiers(true).find((t) => t.id === 'luna')?.label).toBe('GPT 6 Luna');
  });

  it('plus aucune trace du nom « Velbaz 2.0 »', () => {
    expect(modelTiers(true).some((t) => t.label.includes('2.0'))).toBe(false);
  });
});

describe('resolveTier', () => {
  it('Velbaz par défaut pour tout le monde', () => {
    expect(DEFAULT_TIER).toBe('velbaz2');
  });

  it("un ancien choix mémorisé ne fuit pas pour un compte normal", () => {
    for (const t of ['max', 'pro', 'lite', 'luna'] as const) {
      expect(resolveTier(t, false)).toBe('velbaz2');
    }
    expect(resolveTier('velbaz2', false)).toBe('velbaz2');
  });

  it("l'admin garde son choix", () => {
    expect(resolveTier('luna', true)).toBe('luna');
    expect(resolveTier('max', true)).toBe('max');
  });
});

describe('capTier — miroir serveur', () => {
  it('compte normal : Velbaz quoi qu’il envoie', () => {
    expect(capTier('max', 'business')).toBe(PUBLIC_TIER);
    expect(capTier('luna', 'free')).toBe(PUBLIC_TIER);
  });

  it("admin : le palier demandé", () => {
    expect(capTier('luna', 'free', { admin: true })).toBe('luna');
  });

  it('garde les listes admin-only et le palier public alignés', () => {
    expect([...ADMIN_ONLY_TIERS]).toEqual([...SERVER_ADMIN_ONLY_TIERS]);
    expect(PUBLIC_TIER).toBe(SERVER_PUBLIC_TIER);
  });
});
