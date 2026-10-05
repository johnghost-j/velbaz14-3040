// ── Étiquette « modèle » affichée sous une étape de build ───────────────────
//
// `agent_activity` ne stocke PAS le modèle utilisé (pas de colonne), donc le
// front déduit l'étiquette du rôle de l'agent. Une seule source ici : la table
// vivait en double (lib/build-store.ts et pages/chat.tsx) et les deux copies
// avaient dérivé de la réalité — elles annonçaient claude-sonnet-4.6 pour des
// agents passés sur gpt-5.4-mini le 08/09, et gemini-3.1-pro pour marketing qui
// n'y a jamais tourné.
//
// Valeurs vérifiées dans le code appelant ET dans ai_usage_events :
//  - engineering/engineer → builder (api/builder/engine.ts CODE_MODEL/EDIT_MODEL)
//  - design               → logo, fiches produits, images (modèle image Gemini)
//  - marketing            → builder/marketing-strategy.ts
//  - support, supply_chain→ agents/* et swarm (tous en gpt-5.4-mini)
// Un rôle sans appel IA propre (growth, operations, trading, browser :
// Printify, ordres, leads de démo…) retombe sur la marque plutôt que de
// s'inventer un modèle.
const ROLE_MODEL: Record<string, string> = {
  engineering: 'claude-sonnet-4.6',
  engineer: 'claude-sonnet-4.6',
  design: 'gemini-3.1-flash-lite-image',
  marketing: 'gpt-5.4-mini',
  support: 'gpt-5.4-mini',
  supply_chain: 'gpt-5.4-mini',
  ceo: 'velbaz',
};

// ── Mode Velbaz 2.0 (admin) ─────────────────────────────────────────────────
// Le serveur remplace sonnet-4.6 ET gpt-5.4-mini par GPT 6 Luna, et l'image
// flash-lite par flash-image (api/agent/model-mode.ts VELBAZ2_SUBSTITUTIONS).
// Chaque étape porte `modelMode: "velbaz2"` quand elle a tourné dans ce mode :
// sans ça, le front annonçait claude-sonnet-4.6 pour du code écrit par Luna.
// Le front ne peut pas importer model-mode.ts (node:async_hooks) : les valeurs
// sont recopiées ici et confrontées à la source par role-models.test.ts.
export const VELBAZ2_TEXT_LABEL = 'gpt-6-luna';
export const VELBAZ2_IMAGE_LABEL = 'gemini-3.1-flash-image';
const VELBAZ2_ROLE_MODEL: Record<string, string> = {
  engineering: VELBAZ2_TEXT_LABEL,
  engineer: VELBAZ2_TEXT_LABEL,
  design: VELBAZ2_IMAGE_LABEL,
  marketing: VELBAZ2_TEXT_LABEL,
  support: VELBAZ2_TEXT_LABEL,
  supply_chain: VELBAZ2_TEXT_LABEL,
  ceo: 'velbaz',
};

/** Valeur de `agent_activity.model_mode` pour une étape du mode Velbaz 2.0. */
export const VELBAZ2_MODE = 'velbaz2';

/** Étiquette par défaut : la marque, pas un modèle inventé. */
export const DEFAULT_ROLE_MODEL = 'velbaz';

export function roleModel(role?: string | null, modelMode?: string | null): string {
  const table = modelMode === VELBAZ2_MODE ? VELBAZ2_ROLE_MODEL : ROLE_MODEL;
  return (role && table[role]) || DEFAULT_ROLE_MODEL;
}

/** Modèle réel derrière la synthèse marketing de fin de build. */
export const MARKETING_MODEL = 'openai/gpt-5.4-mini';

/** Idem, selon le mode dans lequel le build a tourné. */
export function marketingModel(modelMode?: string | null): string {
  return modelMode === VELBAZ2_MODE ? `openai/${VELBAZ2_TEXT_LABEL}` : MARKETING_MODEL;
}
