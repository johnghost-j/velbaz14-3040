import { TIER_MAX, TIER_PRO, TIER_LITE, TIER_LUNA, TIER_VELBAZ2 } from './brand';

// ── Paliers de modèles proposés dans la barre de saisie ──
// Une seule source pour les DEUX sélecteurs (accueil + chat projet) : ils
// étaient déjà des copies l'un de l'autre, et y dupliquer en plus la règle
// « admin seulement » aurait garanti qu'ils divergent un jour — un palier
// interne oublié dans un seul des deux menus, c'est une fuite.
export type ModelTier = 'velbaz2' | 'luna' | 'max' | 'pro' | 'lite';

export interface ModelTierOption {
  id: ModelTier;
  label: string;
  desc: string;
  tokens: string;
}

/**
 * [2026-10-03] « Velbaz » (id 'velbaz2', ex-« Velbaz 2.0 ») est le modèle
 * unique de tous les comptes normaux, tous plans : ils n'ont AUCUN choix (le
 * sélecteur ne s'affiche pas pour eux). Tous les autres paliers sont admin.
 * Miroir de `ADMIN_ONLY_TIERS` (api/plans.ts) : c'est LÀ que la règle est
 * appliquée (capTier). Ici on ne fait que cacher le menu — confort
 * d'affichage, aucune sécurité (n'importe qui peut poster `tier: 'max'`).
 */
// Même ordre que `ADMIN_ONLY_TIERS` côté serveur (api/plans.ts) : un test
// compare les deux listes à l'identique, ordre inclus.
export const ADMIN_ONLY_TIERS: readonly ModelTier[] = ['luna', 'max', 'pro', 'lite'];

/** Le modèle de tout le monde (miroir de PUBLIC_TIER côté serveur). */
export const PUBLIC_TIER: ModelTier = 'velbaz2';

// Ordre du menu admin : Velbaz (le modèle public, par défaut) en tête, puis
// les paliers internes du plus puissant au plus léger.
const ALL_TIERS: ModelTierOption[] = [
  { id: 'velbaz2', label: TIER_VELBAZ2, desc: 'Default model — everyone', tokens: '1× tokens' },
  { id: 'max',  label: TIER_MAX,  desc: 'Internal — admin',          tokens: '3× tokens' },
  { id: 'luna', label: TIER_LUNA, desc: 'Internal — admin',          tokens: '1× tokens' },
  { id: 'pro',  label: TIER_PRO,  desc: 'Internal — admin',          tokens: '2× tokens' },
  { id: 'lite', label: TIER_LITE, desc: 'Internal — admin',          tokens: '1× tokens' },
];

export function modelTiers(isAdmin: boolean): ModelTierOption[] {
  return isAdmin ? ALL_TIERS : ALL_TIERS.filter((t) => !ADMIN_ONLY_TIERS.includes(t.id));
}

/** Un compte normal n'a qu'un modèle : pas de sélecteur à afficher. */
export function canPickModel(isAdmin: boolean): boolean {
  return modelTiers(isAdmin).length > 1;
}

export const MODEL_TIER_KEY = 'velbaz_model_tier';

/**
 * Palier par défaut : Velbaz, pour tout le monde (admin compris tant qu'il
 * n'a rien choisi d'autre).
 * [2026-09-08] Était 'max', puis 'lite' ; [2026-10-03] 'velbaz2'.
 */
export const DEFAULT_TIER: ModelTier = PUBLIC_TIER;

/** Palier mémorisé localement, ramené à une valeur connue. */
export function readStoredTier(): ModelTier {
  try {
    const raw = localStorage.getItem(MODEL_TIER_KEY) as ModelTier | null;
    return raw && ALL_TIERS.some((t) => t.id === raw) ? raw : DEFAULT_TIER;
  } catch {
    return DEFAULT_TIER;
  }
}

/**
 * Palier réellement utilisable par ce compte.
 * Un compte normal est TOUJOURS ramené à Velbaz : un ancien choix ('max',
 * 'lite'…) resté en localStorage ne fuit pas dans la requête. Sert aussi de
 * filet pendant la fraction de seconde où l'identité n'est pas chargée (sans
 * ça le `find()` du sélecteur rendait `undefined` et la barre plantait).
 */
export function resolveTier(tier: ModelTier, isAdmin: boolean): ModelTier {
  const allowed = modelTiers(isAdmin);
  return allowed.some((t) => t.id === tier) ? tier : DEFAULT_TIER;
}
