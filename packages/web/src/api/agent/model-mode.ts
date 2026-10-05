// ─── Mode « Velbaz 2.0 » : substitution globale de modèles (admin seulement) ──
//
// Velbaz 2.0 n'est pas un palier de chat de plus : c'est un mode qui remplace
// les modèles de TOUT le pipeline (chat, agents, génération de code, vision,
// QA, selfheal, images) le temps d'une requête admin.
//
// Pourquoi une substitution ambiante plutôt qu'un `if` sur chaque site d'appel :
// les modèles sont figés dans ~15 fichiers de constantes (CODE_MODEL,
// EDIT_MODEL, QA_MODEL, VISION_MODEL, SMART_CHAT_MODEL, IMAGE_MODEL, les 8
// agents…) et consommés par ~500 appels `gateway(model)`. Éditer ces constantes
// aurait basculé TOUT LE MONDE sur Velbaz 2.0 — or le mode doit rester réservé
// à l'admin. On intercepte donc au seul goulot commun : `gateway()`.
//
// Le scope est porté par AsyncLocalStorage (même mécanique que
// ai-usage/context.ts) : ouvert une fois par requête, il est hérité par tout ce
// qui part en dessous — y compris les jobs de build lancés en tâche de fond
// depuis la requête, qui génèrent le code ET les images.
//
import { AsyncLocalStorage } from "node:async_hooks";

/** Modèle texte unique du mode : remplace code ET chat/agents. */
export const VELBAZ2_TEXT_MODEL: string =
  process.env.VELBAZ2_TEXT_MODEL || "openai/gpt-6-luna";

// ── Modèle IMAGE du mode ────────────────────────────────────────────────────
// Flux Schnell (`prodia/flux-fast-schnell`) était le choix demandé, mais il est
// INJOIGNABLE depuis le Runable Gateway : le gateway n'expose aucun endpoint de
// génération d'image (`/image-model`, celui que l'AI SDK appelle, répond 404),
// donc les 34 modèles `modelType: "image"` du catalogue (Flux, GPT Image,
// Recraft, Seedream, Grok Imagine) sont tous inutilisables. Appelé en texte,
// Flux répond « is an image model, not a language model ».
// Les seuls générateurs qui marchent sont les Gemini « language » multimodaux,
// via generateText + response_modalities:["IMAGE"] (cf. builder/images.ts).
// Alternative retenue, mesurée le 2026-09-26 sur le même prompt :
//   gemini-3.1-flash-lite-image (défaut actuel) : 4,3 s — JPEG 57 Ko
//   gemini-3.1-flash-image (Nano Banana 2)      : 10,2 s — PNG 1,06 Mo  ← ici
//   gemini-3-pro-image (Nano Banana Pro)        : 16,3 s — PNG 0,98 Mo
export const VELBAZ2_IMAGE_MODEL: string =
  process.env.VELBAZ2_IMAGE_MODEL || "google/gemini-3.1-flash-image";

/**
 * Table de substitution du mode. Clés = les modèles réellement figés dans le
 * code (hors Claude, couvert par VELBAZ2_REPLACED_PROVIDERS ci-dessous) ; tout
 * id absent passe inchangé (gpt-5.4-nano du palier admin Lite, gpt-5.4 des
 * chaînes de secours, modèles uncensored…).
 */
export const VELBAZ2_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  // Génération / édition de code, vision, QA, selfheal, mobile.
  "anthropic/claude-sonnet-4.6": VELBAZ2_TEXT_MODEL,
  // Agents, orchestrateur, classifieur, stratégie marketing.
  "openai/gpt-5.4-mini": VELBAZ2_TEXT_MODEL,
  // [2026-10-03] Velbaz = modèle de tout le monde : gemini-3-flash partait
  // encore à côté de Luna (3e concurrent de la course au premier mot du chat,
  // JSON « bon marché » du builder, vision genesis). Luna est aussi moins cher.
  "google/gemini-3-flash": VELBAZ2_TEXT_MODEL,
  // Images du builder (défaut Nano Banana 2 Lite).
  "google/gemini-3.1-flash-lite-image": VELBAZ2_IMAGE_MODEL,
};

/**
 * Providers remplacés EN BLOC par le modèle texte du mode : en Velbaz 2.0, plus
 * AUCUN appel ne part chez Anthropic — haiku (premier mot du chat), sonnet-4.6
 * (code, QA, vision), sonnet-5 (palier max), opus, le test de clé… et tout
 * futur id `anthropic/*` sans avoir à l'ajouter à la table.
 * Ne touche pas aux ids `openrouter/…` (routage uncensored, géré à part).
 */
export const VELBAZ2_REPLACED_PROVIDERS: readonly string[] = ["anthropic"];

interface ModelModeScope {
  /** Vrai quand la requête courante tourne en Velbaz 2.0. */
  velbaz2: boolean;
  /**
   * Vrai quand la requête a CHOISI son mode (palier envoyé par le chat) : le
   * mode mémorisé (flag admin, appliqué dès l'authentification) ne le
   * réécrit plus ensuite, même si getUser() est rappelé plus bas.
   */
  explicit: boolean;
}

const storage = new AsyncLocalStorage<ModelModeScope>();

/**
 * Ouvre un scope de mode pour la requête. À appeler tôt (middleware), car le
 * scope doit exister AVANT que l'identité de l'appelant soit connue : c'est
 * `activateVelbaz2()` qui le bascule ensuite, sur l'objet déjà en place.
 */
export function runWithModelMode<T>(fn: () => T): T {
  return storage.run({ velbaz2: false, explicit: false }, fn);
}

/**
 * Bascule la requête courante en Velbaz 2.0. Sans effet hors scope — un job de
 * fond non instrumenté reste donc sur les modèles normaux, jamais l'inverse.
 *
 * L'appelant est responsable du contrôle d'accès : ne l'appeler qu'après avoir
 * vérifié que le compte est admin (cf. resolveVelbaz2Mode dans api/index.ts).
 */
export function activateVelbaz2(): void {
  setVelbaz2ForRequest(true);
}

/**
 * Choix EXPLICITE du mode pour la requête courante (palier du chat) : active
 * OU désactive, et verrouille le scope contre la réactivation ambiante.
 */
export function setVelbaz2ForRequest(on: boolean): void {
  const scope = storage.getStore();
  if (!scope) return;
  scope.velbaz2 = on;
  scope.explicit = true;
}

/**
 * Applique le mode MÉMORISÉ (flag admin) à la requête courante — appelé à
 * l'authentification, pour que TOUTES les routes d'un admin en Velbaz 2.0
 * (validation de produit, synchro du catalogue, création Printify…) suivent le
 * mode, pas seulement build/création/reprise. Sans effet si la requête a déjà
 * fait un choix explicite.
 */
export function applyRememberedVelbaz2(on: boolean): void {
  const scope = storage.getStore();
  if (!scope || scope.explicit) return;
  scope.velbaz2 = on;
}

/** Vrai si la requête courante tourne en Velbaz 2.0. */
export function isVelbaz2Active(): boolean {
  return storage.getStore()?.velbaz2 === true;
}

/**
 * Id de modèle effectif : substitué si le mode est actif, inchangé sinon.
 * Appelé par `gateway()` — donc par tous les sites d'appel d'un coup.
 */
export function mapModelId(modelId: string): string {
  if (!isVelbaz2Active()) return modelId;
  const exact = VELBAZ2_SUBSTITUTIONS[modelId];
  if (exact) return exact;
  const provider = modelId.slice(0, Math.max(0, modelId.indexOf("/")));
  if (VELBAZ2_REPLACED_PROVIDERS.includes(provider)) return VELBAZ2_TEXT_MODEL;
  return modelId;
}
