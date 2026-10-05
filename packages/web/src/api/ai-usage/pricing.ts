// ─── Tarification IA : USD par million de tokens + conversion en crédits ─────
//
// Source unique de vérité pour le coût d'un appel IA. Utilisé par le middleware
// gateway (tous les appels texte/stream) et par les appels à coût forfaitaire
// (images). Si un modèle est inconnu, on applique DEFAULT_PRICE et on marque
// l'évènement `priced: "fallback"` pour que l'admin voie qu'il faut l'ajouter.

export interface ModelPrice {
  /** USD par million de tokens d'entrée non cachés. */
  input: number;
  /** USD par million de tokens de sortie. */
  output: number;
  /** USD par million de tokens d'entrée lus depuis le cache (défaut : 10% input). */
  cacheRead?: number;
  /** USD par million de tokens écrits en cache (défaut : 125% input). */
  cacheWrite?: number;
}

// [2026-10-03] TOUS les tarifs re-vérifiés contre le catalogue du Runable
// Gateway (`getAvailableModels()`, champ `pricing`, USD/token × 1e6) — c'est ce
// que le gateway nous facture réellement. Plusieurs lignes avaient dérivé :
//   gpt-5.4-mini   0,25/2    → 0,75/4,5   (le modèle le plus appelé : ~3× sous-facturé)
//   gpt-5.4        1,25/10   → 2,5/15
//   gpt-5.4-nano   0,05/0,4  → 0,2/1,25
//   opus-4.6/4.7   15/75     → 5/25       (sur-facturé 3×)
//   deepseek-v4    0,14/0,28 → 0,22/0,66
//   gemini-3.1-flash-image 0,3/2,5 → 0,5/3
// Le gateway n'annonce aucun surcoût d'écriture de cache pour OpenAI / Google /
// DeepSeek : cacheWrite = input (sinon le défaut 125 % sur-facturait).
// `google/gemini-3-pro` retiré : absent du gateway et appelé nulle part.
// Pour re-vérifier : getAvailableModels() puis comparer à cette table.
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "anthropic/claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "anthropic/claude-opus-4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic/claude-opus-4.7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "openai/gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  "openai/gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  // Modèle texte du mode Velbaz 2.0 (agent/model-mode.ts) ; le gateway annonce
  // bien un tarif d'écriture de cache pour lui.
  "openai/gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  // Test de clé perso OpenAI (POST /admin/provider-keys/test).
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  "deepseek/deepseek-v4-flash": { input: 0.22, output: 0.66, cacheRead: 0.022, cacheWrite: 0.22 },
  "google/gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
  // Absent du gateway (repli de agents/website.ts, donc jamais facturé par
  // lui) : tarif public Google conservé pour le cas d'une clé perso.
  "google/gemini-2.0-flash-001": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  // Modèles image : `output` = sortie TEXTE ; une image produite est comptée
  // au forfait IMAGE_FLAT_USD ci-dessous (le gateway n'expose pas ce tarif).
  "google/gemini-2.5-flash-image": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  "google/gemini-3-pro-image": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
  // Nano Banana 2 Lite — modèle image par défaut (1K uniquement).
  "google/gemini-3.1-flash-lite-image": { input: 0.25, output: 1.5, cacheRead: 0.03, cacheWrite: 0.25 },
  // Nano Banana 2 — modèle image du mode Velbaz 2.0.
  "google/gemini-3.1-flash-image": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
};

/** Utilisé quand le modèle n'est pas dans la table (estimation prudente). */
export const DEFAULT_PRICE: ModelPrice = { input: 1, output: 5 };

/**
 * Coût forfaitaire par image générée (USD). Les modèles image facturent à
 * l'image, pas au token : quand un appel produit des fichiers, on compte
 * `nbImages × forfait` au lieu des tokens de sortie.
 */
// Tarifs publics Google (standard, hors batch), vérifiés le 2026-09-09 et
// re-vérifiés le 2026-10-03 (ai.google.dev/gemini-api/docs/pricing) :
//   - 2.5 Flash Image (Nano Banana 1) ....... 0,039 $/image
//   - 3.1 Flash Lite Image (NB 2 Lite, 1K) .. 0,034 $/image
//   - 3.1 Flash Image (Nano Banana 2, 1K) ... 0,067 $/image
//   - 3 Pro Image (Nano Banana Pro) ......... 0,134 $ en 1K/2K, 0,24 $ en 4K
// (le forfait 3-pro-image reste au pire cas 4K, volontairement prudent)
export const IMAGE_FLAT_USD: Record<string, number> = {
  "google/gemini-2.5-flash-image": 0.039,
  "google/gemini-3.1-flash-lite-image": 0.034,
  "google/gemini-3.1-flash-image": 0.067,
  "google/gemini-3-pro-image": 0.24,
};

/** Combien de crédits vaut 1 USD. 3000 => 1 crédit = 0,000333 $. */
export const CREDITS_PER_USD: number = Number(process.env.AI_CREDITS_PER_USD) || 3000;

export function usdToCredits(usd: number): number {
  return Math.round(usd * CREDITS_PER_USD * 100) / 100;
}

export function isKnownModel(model: string): boolean {
  return model in MODEL_PRICES;
}

export function getPrice(model: string): ModelPrice {
  return MODEL_PRICES[model] ?? DEFAULT_PRICE;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/**
 * Coût USD d'un appel. `images > 0` bascule sur le forfait image pour la partie
 * sortie (les tokens d'entrée restent facturés normalement).
 */
export function computeCostUsd(model: string, tokens: TokenCounts, images = 0): number {
  const p = getPrice(model);
  const cacheReadPrice = p.cacheRead ?? p.input * 0.1;
  const cacheWritePrice = p.cacheWrite ?? p.input * 1.25;

  const inputUsd =
    (tokens.input * p.input + tokens.cacheRead * cacheReadPrice + tokens.cacheWrite * cacheWritePrice) / 1_000_000;

  const flat = IMAGE_FLAT_USD[model];
  const outputUsd =
    images > 0 && flat != null ? images * flat : (tokens.output * p.output) / 1_000_000;

  return Number((inputUsd + outputUsd).toFixed(6));
}
