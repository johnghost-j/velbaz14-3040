// ─── « Ajoute-moi un produit » depuis le chat ────────────────────────────────
// [2026-10-03] Demande utilisateur : « si je dis à l'IA de m'ajouter un produit,
// ou même un vrai produit disponible sur Printify, elle doit utiliser Printify
// et afficher un vrai produit Printify, pas créer n'importe quoi ».
//
// Avant, ce message partait soit en édition de code (isAppEditRequest : l'IA
// écrivait un produit inventé en dur dans une page), soit dans le chat libre
// (pop-up product_preview : photo IA + nom/prix inventés). Ce module DÉTECTE
// la demande ; le flux réel (création Printify, aperçu, validation) vit dans
// chat-product-flow.ts.
//
// Pur : aucune I/O, testé dans product-intent.test.ts.

import { normalizePodProductType } from "../pod-guard";

export interface ProductAddIntent {
  /** Type Printify canonique cité dans le message ('t-shirt', 'mug'…), sinon null. */
  podType: string | null;
  /** Printify nommé explicitement. */
  printifyMentioned: boolean;
  /** Ce qu'il faut imprimer, si l'utilisateur l'a dit (« avec un loup »). */
  concept: string;
}

const fold = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

// Verbes d'ajout, fautes de frappe courantes comprises (« ajotue », « rajoute »,
// « cre », « met »).
const VERB = /^(r?aj[a-z]*|ajt[a-z]*|cr[ea]{1,2}[rsz]?|crees?|creer|creez|mets?|mettre|mettez|add|adds|create|fabrique[rsz]?|vend[sre]?|vendre)$/;
const PRODUCT = /^(produits?|products?|prodiuts?|produis?|prodtuis?|porduits?)$/;
// Mots qui font de la phrase une édition de la PAGE produit, pas un nouvel
// article : « ajoute une photo au produit », « crée la page produit »…
const PAGE_EDIT = new Set([
  "photo", "photos", "image", "images", "bouton", "boutons", "prix", "description", "texte",
  "section", "sections", "page", "pages", "avis", "lien", "liens", "filtre", "filtres", "categorie",
  "categories", "badge", "onglet", "menu", "fiche", "grille", "carrousel", "carousel", "video",
  "titre", "zoom", "animation", "slider", "banniere", "button", "review", "reviews", "filter",
]);
const NEGATIVE = /\b(supprim\w*|enlev\w*|retir\w*|efface\w*|delete|remove|cach\w*|masqu\w*|desactiv\w*)\b/;
const QUESTION = /\b(pourquoi|combien|c ?est quoi|qu ?est ce|comment (ca|tu|on) (marche|fonctionne))\b/;
// Contexte « article à vendre » quand le message nomme un type sans dire « produit ».
const SALE_CONTEXT = /\b(printify|catalogue|boutique|shop|vente|vendre|a vendre|sur (le|mon) site|au site)\b/;

/** Demande d'ajout d'un produit à vendre, ou null. */
export function detectProductAddRequest(message: string): ProductAddIntent | null {
  const raw = String(message || "").trim();
  if (!raw || raw.startsWith("[")) return null; // réponses de pop-up ([APERÇU VALIDÉ]…)
  const m = fold(raw);
  if (NEGATIVE.test(m) || QUESTION.test(m)) return null;
  const tokens = m.replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
  const printifyMentioned = /\bprintify\b/.test(m);
  let podType = normalizePodProductType(raw);

  let matched = false;
  for (let i = 0; i < tokens.length && !matched; i++) {
    if (!VERB.test(tokens[i])) continue;
    const windowEnd = Math.min(tokens.length, i + 7);
    for (let j = i + 1; j < windowEnd; j++) {
      if (PAGE_EDIT.has(tokens[j])) break;
      if (PRODUCT.test(tokens[j])) {
        // « ajoute un produit » OK ; « ajoute un bouton produit » déjà coupé
        // par PAGE_EDIT ; « produit » suivi de « page/fiche » → édition.
        if (PAGE_EDIT.has(tokens[j + 1] || "")) break;
        matched = true;
        break;
      }
    }
  }
  // « ajoute un t-shirt printify » / « mets un mug dans la boutique » : le type
  // tient lieu du mot « produit », à condition d'un contexte de vente.
  if (!matched && podType && SALE_CONTEXT.test(m) && tokens.some((t) => VERB.test(t))
      && !tokens.some((t) => PAGE_EDIT.has(t))) {
    matched = true;
  }
  // « ajoute un mug avec un loup », « rajoute 2 t-shirts noirs » : le type est
  // le COMPLÉMENT DIRECT du verbe (seuls déterminants/quantités entre les deux).
  // Ces messages partaient en édition de code et l'IA inventait le produit.
  if (!matched && podType && !tokens.some((t) => PAGE_EDIT.has(t))) {
    const direct = directObjectType(tokens);
    if (direct) { matched = true; podType = direct; }
  }
  if (!matched) return null;
  return { podType, printifyMentioned, concept: extractConcept(raw) };
}

// Entre le verbe et le type : déterminants, quantités, pronoms (« ajoute-moi »).
const FILLER = new Set([
  "un", "une", "des", "le", "la", "les", "l", "du", "de", "d", "moi", "nous", "m", "me", "encore", "aussi",
  "nouveau", "nouvelle", "nouveaux", "nouvelles", "autre", "vrai", "vraie", "a", "an", "the", "new",
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "deux", "trois", "quatre", "cinq", "two", "three",
]);
// Synonymes trop courants hors produit (« ajoute un top 10 », « ajoute un case
// study », « ajoute un journal des commandes ») : jamais lus seuls comme type.
const AMBIGUOUS_TYPE_WORDS = new Set(["top", "print", "case", "journal", "canvas", "cup", "bag"]);
// Premiers mots des types en plusieurs mots (« t shirt », « tote bag », « tapis
// de souris »…). Seuls eux autorisent à lire 2-4 mots : sinon « ajoute un logo
// top » serait lu comme un t-shirt à cause de « top ».
const MULTIWORD_STARTERS = new Set([
  "t", "tee", "tank", "sweat", "hooded", "coffee", "enamel", "travel", "art", "wall", "toile", "tote", "sac",
  "shopping", "phone", "coque", "iphone", "samsung", "coussin", "coussins", "floor", "tufted", "housse", "bean",
  "throw", "couverture", "fleece", "sherpa", "tapis", "mouse", "gaming", "area", "round", "rideau", "rideaux",
  "shower", "jigsaw", "serviette", "drap", "beach", "water", "bouteille", "insulated", "baseball", "dad",
  "trucker", "bloc", "bougie", "scented", "dessous", "sous", "sneaker", "high", "low",
]);

/** Type Printify placé juste après un verbe d'ajout (« ajoute un mug »), sinon null. */
function directObjectType(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    if (!VERB.test(tokens[i])) continue;
    let j = i + 1;
    while (j < tokens.length && j - i <= 4 && FILLER.has(tokens[j])) j++;
    const head = tokens[j];
    if (!head) continue;
    const sizes = MULTIWORD_STARTERS.has(head) ? [4, 3, 2, 1] : [1];
    for (const n of sizes) {
      if (n === 1 && AMBIGUOUS_TYPE_WORDS.has(head.replace(/s$/, ""))) continue;
      const t = normalizePodProductType(tokens.slice(j, j + n).join(" "));
      if (t) return t;
    }
  }
  return null;
}

/** « … avec un loup qui hurle » → « un loup qui hurle ». Vide si rien de dit. */
export function extractConcept(message: string): string {
  const m = String(message || "");
  const re = /\b(?:avec|motif|design|dessin|imprim[ée]e?s?|th[èe]me|repr[ée]sentant|qui repr[ée]sente|illustr[ée]e?|with|featuring)\b\s*(?:de |d'|du |des |un |une |le |la |les |a |an |the )?(.+)$/i;
  const hit = m.match(re);
  if (!hit) return "";
  return hit[1].replace(/\b(sur|dans|chez)\s+(le|mon|ma|la)\s+(site|boutique|printify)\b.*$/i, "").replace(/[.!?\s]+$/, "").trim().slice(0, 200);
}

/** Réponse d'un pop-up d'aperçu (« [APERÇU VALIDÉ] » / « [APERÇU À MODIFIER] … »). */
export function previewReplyKind(message: string): "approve" | "modify" | null {
  if (/^\s*\[APER[ÇC]U\s+VALID[ÉE]\]/i.test(message || "")) return "approve";
  if (/^\s*\[APER[ÇC]U\s+[ÀA]\s+MODIFIER\]/i.test(message || "")) return "modify";
  return null;
}

/** Texte de retour d'un « [APERÇU À MODIFIER] … ». */
export function previewFeedback(message: string): string {
  return String(message || "").replace(/^\s*\[APER[ÇC]U\s+[ÀA]\s+MODIFIER\]\s*/i, "").trim();
}

/**
 * Un « [APERÇU VALIDÉ] » répond-il à NOTRE aperçu produit ? Le même préfixe sert
 * au logo et à tout pop-up « preview » de l'IA : on ne le prend pour le produit
 * que si le DERNIER message de l'assistant est bien l'aperçu de ce candidat.
 */
export function previewBelongsToProduct(candidate: { imageUrl: string } | null, lastAssistantContent: string | null | undefined): boolean {
  if (!candidate?.imageUrl || !lastAssistantContent) return false;
  return lastAssistantContent.includes(candidate.imageUrl);
}

// Mots du retour « Modifier » qui parlent du PRODUIT (type, modèle, taille),
// pas du dessin : « un mug classique 11oz » ne doit pas faire dessiner un mug.
const PRODUCT_SPEC = /^(\d+\s*(oz|ml|cl)|\d+(oz|ml|cl)|classique|classic|standard|normal|taille|size|modele|model|format)$/;
// Couleur / taille : du produit seulement à côté d'un type (« mug blanc »),
// sinon du dessin (« le loup en noir », « le loup plus grand »).
const PRODUCT_ADJ = /^(blanc|blanche|white|noir|noire|black|grand|grande|petit|petite|large|small)$/;
const ART_STOP = new Set(["un", "une", "le", "la", "les", "des", "du", "de", "d", "l", "a", "an", "the", "pas", "plutot", "sur", "en"]);

/**
 * Sépare un retour d'aperçu en ce qui concerne le DESSIN (`art`) et ce qui
 * concerne le PRODUIT (`spec` : type, modèle, contenance…).
 * « un mug classique 11oz, le loup plus simple » → art « le loup plus simple »,
 * spec « mug classique 11oz ».
 */
export function splitPreviewFeedback(feedback: string): { art: string; spec: string } {
  const art: string[] = [];
  const spec: string[] = [];
  for (const clause of String(feedback || "").split(/[,;.\n]+|\s+(?:et|and|mais|but)\s+/i)) {
    const words = clause.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const meaningful = words.filter((w) => !ART_STOP.has(fold(w).replace(/[^a-z0-9]/g, "")));
    const hasType = meaningful.some((w) => !!normalizePodProductType(w));
    const productish = meaningful.filter((w) => {
      const f = fold(w).replace(/[^a-z0-9]/g, "");
      return PRODUCT_SPEC.test(f) || !!normalizePodProductType(w) || (hasType && PRODUCT_ADJ.test(f));
    });
    if (meaningful.length && productish.length === meaningful.length) spec.push(meaningful.join(" "));
    else art.push(clause.trim());
  }
  return { art: art.join(", "), spec: spec.join(" ") };
}
