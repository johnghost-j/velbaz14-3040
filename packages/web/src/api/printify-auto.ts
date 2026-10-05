// ─── Création automatique d'un produit Printify à partir d'un design IA ───────
// Utilisé au build (pour transformer chaque design produit en vrai produit
// print-on-demand vendable) et à la demande. Choisit un blueprint (t-shirt par
// défaut), le premier print provider disponible, active toutes les variantes
// (tailles/couleurs), place le design sur la face avant, crée + publie le produit.
// Retourne le mapping à stocker en DB (printifyProductId + variantes avec vid Printify).

import * as printify from "./printify";
import * as printifyDesign from "./printify-design";
import * as artwork from "./printify-artwork";
import { pickGarmentColors, sortSizes } from "./printify-colors";
import { normalizePodProductType } from "./pod-guard";
import { priceVariantsFromCost, type CostedVariant } from "./pricing";

// Blueprints Printify courants (fallback si l'IA n'en fournit pas).
export const DEFAULT_BLUEPRINTS: Record<string, number> = {
  tshirt: 6, // Unisex Jersey Short Sleeve Tee (Bella+Canvas 3001)
  hoodie: 77, // Unisex Heavy Blend Hooded Sweatshirt
  mug: 68, // 11oz Mug
  poster: 5, // Poster
  totebag: 397, // Tote Bag
  sticker: 400, // Kiss-Cut Stickers
  phonecase: 268, // iPhone case
  // ── Maison, déco & accessoires ──
  // [2026-09-19] Chaque ID ci-dessous a été vérifié sur le catalogue Printify
  // en direct : blueprint présent, au moins un print provider, des variantes,
  // et une zone d'impression « front ». Sans ce mapping, pod-guard reconnaît
  // bien le type (« coussin », « plaid »…) mais resolveBlueprint renvoie null
  // et le produit est abandonné en silence.
  floorpillow: 844, // Tufted Floor Pillow, Square
  beanbag: 853, // Bean Bag Chair Cover
  cushion: 809, // Square Pillow
  blanket: 238, // Sherpa Fleece Blanket
  doormat: 1346, // Doormat
  mousepad: 608, // Mouse Pad (Rectangle)
  rug: 1746, // Rug
  showercurtain: 235, // Shower Curtains
  apron: 713, // Cotton Apron
  puzzle: 596, // Puzzle (96, 252, 500, 1000-Piece)
  beachtowel: 352, // Beach Towel
  waterbottle: 482, // 20oz Insulated Bottle
  tumbler: 353, // Tumbler 20oz
  cap: 1447, // Classic Dad Cap
  notebook: 1194, // Softcover Notebook, A5
  candle: 762, // Scented Candle, 9oz
  coaster: 480, // Cork Back Coaster
  // [2026-09-22] Bug récurrent : « marque de chaussures » ressortait en
  // t-shirt/hoodie à logo de basket au lieu de vraies chaussures. Printify a
  // de vrais blueprints sneakers (confirmés sur le catalogue public) — celui
  // ci-dessous doit être re-vérifié via getBlueprint/getBlueprintProviders/
  // getBlueprintVariants dès qu'un token Printify est disponible, comme les
  // autres entrées de cette table.
  shoe: 291, // Men's sneakers (générique, unisexe par défaut)
  // [2026-10-03] Vêtements & accessoires ajoutés après le bug « marque de
  // pantalons → aucun produit ». Tous vérifiés EN DIRECT le 2026-10-03
  // (getBlueprint + getBlueprintProviders + getBlueprintVariants) : provider
  // actif, variantes, zones d'impression listées en commentaire. Les bas
  // (pantalon/jogging/short) n'ont PAS de zone « front » : ils s'impriment
  // sur une jambe (voir legPlacementPositions).
  pants: 5526, // Men's Trousers — Fulfill Engine, 26 var., front_left/right_leg_dtf
  joggers: 1398, // Unisex Sweatpants — SwiftPOD, 36 var., left/right_leg_front/back
  shorts: 1574, // Unisex Garment-Dyed Lightweight Fleece Sweat Shorts — 30 var., left/right_leg_front
  leggings: 947, // Women's Casual Leggings (AOP) — Miami Sublimation, right_leg/left_leg
  dress: 431, // T-Shirt Dress (AOP) — MWW On Demand, front/back
  skirt: 286, // Women's Skater Skirt (AOP) — MWW On Demand, front/back
  socks: 365, // Crew Socks — ArtsAdd, front/back left/right leg
  jacket: 433, // Men's Bomber Jacket (AOP) — ArtsAdd, front/back
  polo: 1402, // Men's Piqué Polo — SwiftPOD, 36 var., front/left_chest/back
  beanie: 1689, // Cuff Beanie — Fulfill Engine, 13 var., front
  backpack: 413, // Backpack — MWW On Demand, front
  swimsuit: 350, // Women's One-piece Swimsuit (AOP) — ArtsAdd, 70 var., front/back
};

// Table type canonique (pod-guard) → blueprint Printify.
// Tout type listé dans POD_TYPE_SYNONYMS doit avoir son entrée ici, sinon il
// est reconnu puis abandonné (voir le test de cohérence dans pod-guard.test.ts).
const BLUEPRINT_BY_POD_TYPE: Record<string, number> = {
  't-shirt': DEFAULT_BLUEPRINTS.tshirt,
  hoodie: DEFAULT_BLUEPRINTS.hoodie,
  mug: DEFAULT_BLUEPRINTS.mug,
  poster: DEFAULT_BLUEPRINTS.poster,
  'tote bag': DEFAULT_BLUEPRINTS.totebag,
  sticker: DEFAULT_BLUEPRINTS.sticker,
  'phone case': DEFAULT_BLUEPRINTS.phonecase,
  'floor pillow': DEFAULT_BLUEPRINTS.floorpillow,
  'bean bag': DEFAULT_BLUEPRINTS.beanbag,
  cushion: DEFAULT_BLUEPRINTS.cushion,
  blanket: DEFAULT_BLUEPRINTS.blanket,
  doormat: DEFAULT_BLUEPRINTS.doormat,
  'mouse pad': DEFAULT_BLUEPRINTS.mousepad,
  rug: DEFAULT_BLUEPRINTS.rug,
  'shower curtain': DEFAULT_BLUEPRINTS.showercurtain,
  apron: DEFAULT_BLUEPRINTS.apron,
  puzzle: DEFAULT_BLUEPRINTS.puzzle,
  'beach towel': DEFAULT_BLUEPRINTS.beachtowel,
  'water bottle': DEFAULT_BLUEPRINTS.waterbottle,
  tumbler: DEFAULT_BLUEPRINTS.tumbler,
  cap: DEFAULT_BLUEPRINTS.cap,
  notebook: DEFAULT_BLUEPRINTS.notebook,
  candle: DEFAULT_BLUEPRINTS.candle,
  coaster: DEFAULT_BLUEPRINTS.coaster,
  shoe: DEFAULT_BLUEPRINTS.shoe,
  pants: DEFAULT_BLUEPRINTS.pants,
  joggers: DEFAULT_BLUEPRINTS.joggers,
  shorts: DEFAULT_BLUEPRINTS.shorts,
  leggings: DEFAULT_BLUEPRINTS.leggings,
  dress: DEFAULT_BLUEPRINTS.dress,
  skirt: DEFAULT_BLUEPRINTS.skirt,
  socks: DEFAULT_BLUEPRINTS.socks,
  jacket: DEFAULT_BLUEPRINTS.jacket,
  polo: DEFAULT_BLUEPRINTS.polo,
  beanie: DEFAULT_BLUEPRINTS.beanie,
  backpack: DEFAULT_BLUEPRINTS.backpack,
  swimsuit: DEFAULT_BLUEPRINTS.swimsuit,
};

/** Types canoniques ayant un blueprint mappé — sert au test de cohérence. */
export function mappedPodTypes(): string[] {
  return Object.keys(BLUEPRINT_BY_POD_TYPE);
}

/**
 * Blueprint du produit décrit par `text`, ou null si ce produit n'existe PAS
 * chez Printify (« voiture », « canapé », « smartphone »…).
 *
 * [2026-09-19] C'est la version STRICTE, à préférer partout. `guessBlueprint`
 * retombait silencieusement sur le t-shirt : une « berline électrique » sortait
 * donc en t-shirt à logo de voiture. Ici, pas de produit disponible = null, et
 * l'appelant abandonne le produit au lieu de le substituer.
 */
export function resolveBlueprint(text: string): number | null {
  const podType = normalizePodProductType(text || "");
  if (!podType) return null;
  return BLUEPRINT_BY_POD_TYPE[podType] ?? null;
}

/**
 * @deprecated Utilise `resolveBlueprint` : celle-ci retombe sur le t-shirt pour
 * tout texte non reconnu, ce qui « habille » les marques non textiles.
 * Conservée uniquement pour un blueprint explicitement choisi en amont.
 */
export function guessBlueprint(text: string): number {
  return resolveBlueprint(text) ?? DEFAULT_BLUEPRINTS.tshirt;
}

// ─── Résolution DYNAMIQUE via le catalogue Printify réel ──────────────────────
// [2026-09-23] `BLUEPRINT_BY_POD_TYPE` ci-dessus doit être étendue à la main
// chaque fois qu'un nouveau type de produit apparaît (t-shirt → hoodie →
// chaussure...), sinon le produit est reconnu par pod-guard puis abandonné en
// silence par resolveBlueprint(). Johne demande l'inverse : pour N'IMPORTE
// QUEL produit demandé, se connecter au catalogue Printify EN DIRECT
// (catalog/blueprints.json) et vérifier si ce produit existe réellement chez
// eux, plutôt que de dépendre d'une liste figée. `resolveBlueprintDynamic`
// fait ça : recherche en direct dans le catalogue, blueprint vérifié
// fabricable (isBlueprintAvailable) avant d'être utilisé. La table statique
// ci-dessus ne sert plus que de secours si l'API catalogue est temporairement
// inaccessible (token invalide, panne réseau) — jamais comme source de vérité.

interface CatalogEntry { id: number; title: string }

// Cache du catalogue complet (liste de ~900 blueprints, change rarement) —
// évite de re-télécharger catalog/blueprints.json à chaque produit créé.
let catalogCache: { data: CatalogEntry[]; ts: number } | null = null;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Vide le cache catalogue — utilisé par les tests. */
export function __resetCatalogCacheForTests(): void {
  catalogCache = null;
}

async function getLiveCatalog(cfg: printify.PrintifyConfig): Promise<CatalogEntry[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.ts < CATALOG_TTL_MS) return catalogCache.data;
  try {
    const res = await printify.listBlueprints(cfg);
    if (res.ok && Array.isArray(res.data)) {
      const list: CatalogEntry[] = (res.data as any[])
        .map((b) => ({ id: Number(b?.id), title: String(b?.title || '') }))
        .filter((b) => Number.isFinite(b.id) && b.title);
      catalogCache = { data: list, ts: now };
      return list;
    }
  } catch {
    // catalogue inaccessible : on garde l'ancien cache s'il existe.
  }
  return catalogCache?.data || [];
}

// Vocabulaire de RECHERCHE uniquement (pas des IDs Printify) : le type
// canonique franco-anglais que pod-guard normalise (« chaussure » → « shoe »)
// ne correspond pas toujours au mot utilisé dans les titres du catalogue
// (« Men's sneakers »). Ceci élargit juste les mots-clés cherchés — contrairement
// à BLUEPRINT_BY_POD_TYPE, ça ne référence aucun ID et ne devient donc jamais
// périmé si Printify change son catalogue.
const CATALOG_SEARCH_SYNONYMS: Record<string, string[]> = {
  // [2026-09-25] `shoe` n'est PLUS listé ici : voir FOOTWEAR_STYLES ci-dessous.
  // Toutes les chaussures partageaient un seul sac de synonymes
  // ('sneaker' + 'slipper' + 'sandal' + 'boot'…), donc « Women's Slippers » et
  // « Men's Sneakers » obtenaient le MÊME score pour un produit sneaker, et le
  // tirage au sort des ex-aequo sortait des chaussons à la place des baskets
  // (bug « Urban Pulse Low » affiché en mules blanches).
  hoodie: ['hoodie', 'hooded sweatshirt', 'hooded', 'sweatshirt'],
  't-shirt': ['t-shirt', 'tee', 'tshirt', 'jersey'],
  'tote bag': ['tote', 'bag'],
  'phone case': ['phone case', 'case'],
  cap: ['cap', 'hat', 'beanie'],
  // [2026-09-23] Johne : « coussin » se normalise en « cushion » côté
  // pod-guard, mais AUCUN blueprint Printify ne s'appelle « cushion » dans le
  // catalogue live — ils s'appellent « Pillow ». Sans ce synonyme, la
  // recherche catalogue ne trouvait ZÉRO résultat pour "cushion" et retombait
  // sur des mots pris dans le NOM du produit («Tide», «Shell» — inventés par
  // l'IA) qui matchaient par hasard des chaussettes/vestes sans aucun rapport.
  cushion: ['pillow', 'throw pillow', 'cushion', 'pillow cover', 'cushion cover'],
  'floor pillow': ['floor pillow', 'floor cushion', 'tufted pillow'],
  'bean bag': ['bean bag', 'beanbag'],
  'mouse pad': ['mouse pad', 'mousepad', 'mouse mat'],
  'water bottle': ['water bottle', 'bottle', 'insulated bottle'],
  'beach towel': ['beach towel', 'towel'],
  'shower curtain': ['shower curtain', 'curtain'],
  // [2026-10-03] Titres réels du catalogue : « Men's Trousers », « Unisex
  // Sweatpants », « Athletic Joggers », « Crew Socks »…
  pants: ['trousers', 'pants'],
  joggers: ['jogger', 'joggers', 'sweatpants', 'track pants'],
  leggings: ['legging', 'leggings'],
  dress: ['dress'],
  skirt: ['skirt'],
  socks: ['socks', 'sock'],
  jacket: ['jacket', 'bomber', 'windbreaker'],
  polo: ['polo'],
  beanie: ['beanie'],
  backpack: ['backpack'],
  swimsuit: ['swimsuit', 'bikini'],
};

// ─── Familles de chaussures ───────────────────────────────────────────────────
// [2026-09-25] Bug signalé : une basket (« Urban Pulse Low ») sortait en
// CHAUSSONS/mules blanches. pod-guard normalise toute la chaussure en UN seul
// type canonique 'shoe', et la recherche catalogue cherchait d'un coup
// sneaker + boot + sandal + slipper. Dans les titres Printify,
// « Women's Slippers » et « Men's Sneakers » marquent alors exactement le même
// score → le tirage au sort des ex-aequo (voulu, pour varier les modèles)
// choisissait un chausson une fois sur deux.
//
// Printify fabrique bien ces cinq familles, mais ce sont des PRODUITS
// DIFFÉRENTS, pas des variantes interchangeables : baskets (canvas/mesh/knit,
// high & low top), bottes, chaussons, claquettes/tongs, sandales. On détecte
// donc le style demandé dans le texte du produit, on ne cherche QUE dans cette
// famille, et on EXCLUT explicitement les titres des autres familles. La
// variété reste entière à l'intérieur de la bonne famille (plusieurs modèles
// de sneakers chez Printify), elle ne traverse plus les styles.
interface FootwearStyle {
  style: string;
  /** Mots (FR/EN) qui, dans le texte du produit, désignent ce style. */
  cues: string[];
  /** Mots cherchés dans les titres du catalogue Printify pour ce style. */
  terms: string[];
}

const FOOTWEAR_STYLES: FootwearStyle[] = [
  {
    style: 'slipper',
    cues: ['chausson', 'chaussons', 'pantoufle', 'pantoufles', 'charentaise', 'charentaises', 'slipper', 'slippers', 'mule', 'mules'],
    terms: ['slipper', 'slippers'],
  },
  {
    // Tongs, claquettes et sandales forment UNE famille : chez Printify les
    // titres les mélangent (« Slide Sandals », « Removable-Strap Sandals »),
    // donc les séparer ferait s'exclure mutuellement le bon produit.
    style: 'open',
    cues: [
      'tong', 'tongs', 'claquette', 'claquettes', 'flip flop', 'flip-flop', 'flipflop', 'flip flops', 'flip-flops',
      'slide', 'slides', 'slider', 'sliders', 'sandale', 'sandales', 'sandal', 'sandals',
      'nu-pieds', 'nu pieds', 'spartiate', 'spartiates',
    ],
    terms: ['flip flop', 'flip flops', 'flip-flop', 'flip-flops', 'slide', 'slides', 'sandal', 'sandals'],
  },
  {
    style: 'boot',
    cues: ['botte', 'bottes', 'bottine', 'bottines', 'boot', 'boots', 'botillon', 'botillons', 'rangers'],
    terms: ['boot', 'boots'],
  },
  {
    // Style par DÉFAUT : « une marque de chaussures » sans autre précision veut
    // dire des baskets, pas des chaussons.
    style: 'sneaker',
    cues: ['sneaker', 'sneakers', 'basket', 'baskets', 'basquette', 'basquettes', 'trainer', 'trainers', 'shoe', 'shoes', 'chaussure', 'chaussures', 'footwear', 'high top', 'high tops', 'low top', 'low tops', 'canvas'],
    terms: ['sneaker', 'sneakers', 'shoe', 'shoes', 'trainer', 'trainers', 'high top', 'high-top', 'low top', 'low-top'],
  },
];

const SNEAKER_STYLE = FOOTWEAR_STYLES[FOOTWEAR_STYLES.length - 1];

/** Style de chaussure explicitement nommé dans le texte, sinon la basket. */
function detectFootwearStyle(rawText: string): FootwearStyle {
  const t = ` ${String(rawText || '').toLowerCase()} `;
  const hasCue = (cue: string) =>
    new RegExp(`(^|[^a-zà-ÿ0-9])${escapeRe(cue)}(s?)([^a-zà-ÿ0-9]|$)`, 'i').test(t);
  // Ordre de FOOTWEAR_STYLES : les styles « spéciaux » d'abord, la basket en
  // dernier — un texte qui ne nomme aucun style précis retombe donc dessus.
  for (const s of FOOTWEAR_STYLES) {
    if (s === SNEAKER_STYLE) continue;
    if (s.cues.some(hasCue)) return s;
  }
  return SNEAKER_STYLE;
}

/**
 * Termes de recherche catalogue pour une chaussure : uniquement ceux du style
 * détecté (`required`), plus l'interdiction explicite des titres des AUTRES
 * familles (`exclude`) pour qu'une basket ne puisse jamais tomber sur un
 * chausson. `bonus` ajoute la coupe (low/high/mid top) quand le nom du produit
 * la mentionne — « Urban Pulse Low » privilégie alors un low-top.
 */
function footwearSearchTerms(rawText: string): { required: string[]; exclude: string[]; bonus: string[] } {
  const style = detectFootwearStyle(rawText);
  const own = new Set(style.terms);
  const exclude = new Set<string>();
  for (const other of FOOTWEAR_STYLES) {
    if (other.style === style.style) continue;
    for (const term of other.terms) if (!own.has(term)) exclude.add(term);
  }
  const bonus = new Set<string>();
  if (style === SNEAKER_STYLE) {
    const t = ` ${String(rawText || '').toLowerCase()} `;
    if (/(^|[^a-zà-ÿ0-9])(low|basse|basses|low-?top)([^a-zà-ÿ0-9]|$)/i.test(t)) {
      for (const b of ['low top', 'low-top']) bonus.add(b);
    }
    if (/(^|[^a-zà-ÿ0-9])(high|mid|montante|montantes|high-?top)([^a-zà-ÿ0-9]|$)/i.test(t)) {
      for (const b of ['high top', 'high-top']) bonus.add(b);
    }
  }
  return { required: Array.from(own), exclude: Array.from(exclude), bonus: Array.from(bonus) };
}

const CATALOG_STOPWORDS = new Set([
  'avec', 'pour', 'sans', 'dans', 'notre', 'marque', 'produit', 'produits',
  'vente', 'ligne', 'business', 'idea', 'brand', 'with', 'from', 'that',
  'this', 'sont', 'être', 'nous', 'leur', 'leurs',
]);

/**
 * [2026-09-23] Johne : « required » = le type canonique + ses synonymes de
 * catalogue (ex. "cushion" → "pillow") — un candidat DOIT matcher au moins un
 * de ces mots pour être retenu. « bonus » = mots pris dans le nom du produit
 * (inventé par l'IA, ex. "Mar de Coussin Tide") — ils ne servent qu'à
 * départager des candidats déjà valides sur le type, jamais à qualifier un
 * candidat seuls. Avant cette séparation, un nom de produit contenant un mot
 * comme "Tide" ou "Shell" pouvait faire matcher des chaussettes ou une veste
 * sans aucun rapport quand le type canonique ne trouvait aucune correspondance
 * dans le catalogue (ex. "cushion" ne matchait aucun titre avant l'ajout du
 * synonyme "pillow").
 */
/**
 * [2026-09-23] Johne : « required » = le type canonique + ses synonymes de
 * catalogue (ex. "cushion" → "pillow") — un candidat DOIT matcher au moins un
 * de ces mots pour être retenu. « bonus » = mots pris dans le nom du produit
 * (inventé par l'IA, ex. "Mar de Coussin Tide") — ils ne servent qu'à
 * départager des candidats déjà valides sur le type, jamais à qualifier un
 * candidat seuls. Avant cette séparation, un nom de produit contenant un mot
 * comme "Tide" ou "Shell" pouvait faire matcher des chaussettes ou une veste
 * sans aucun rapport quand le type canonique ne trouvait aucune correspondance
 * dans le catalogue (ex. "cushion" ne matchait aucun titre avant l'ajout du
 * synonyme "pillow").
 */
// Titres catalogue portant le mot du type mais désignant un AUTRE objet.
const OTHER_OBJECT_VARIANTS: Record<string, string[]> = {
  mug: ['stein', 'beer', 'shot glass', 'chope'],
  // [2026-10-03] « pants » matche aussi pyjamas, blouses médicales, yoga et
  // joggings — d'autres produits que le pantalon d'une marque de pantalons.
  pants: ['pajama', 'scrub', 'yoga', 'lounge', 'sweatpants', 'jogger', 'track', 'kids', 'youth', 'baby'],
  joggers: ['shorts', 'kids', 'youth', 'baby'],
  // « Dimension Knit Dress Shirt », « Dress Uniform Shirt » : des chemises.
  dress: ['shirt', 'uniform', 'kids', 'girls', 'baby'],
  skirt: ['christmas', 'tree', 'kids', 'girls'],
  jacket: ['ansi', 'safety', 'kids', 'youth', 'baby'],
  polo: ['youth', 'kids'],
  socks: ['kids', 'baby'],
  // Bonnet « Baby Beanie » tiré au sort pour « bonnet d'hiver » (mesuré en
  // direct) ; la broderie demande un fichier spécifique, pas un visuel imprimé.
  beanie: ['baby', 'kids', 'youth', 'embroidery'],
  shorts: ['kids', 'youth', 'baby'],
  leggings: ['kids', 'youth', 'baby'],
  swimsuit: ['kids', 'girls', 'baby'],
  backpack: ['kids', 'mini'],
};

function catalogSearchTerms(
  canonicalType: string,
  rawText: string,
): { required: string[]; bonus: string[]; exclude: string[] } {
  const required = new Set<string>();
  const exclude = new Set<string>();
  const bonus = new Set<string>();
  const t = (canonicalType || '').toLowerCase().trim();
  if (t === 'shoe') {
    // [2026-09-25] La chaussure passe par les familles de styles : chercher
    // « sneaker » ET « slipper » en même temps mettait les deux à égalité de
    // score et le tirage au sort sortait des chaussons pour une basket.
    const fw = footwearSearchTerms(rawText);
    for (const term of fw.required) required.add(term);
    for (const term of fw.exclude) exclude.add(term);
    for (const term of fw.bonus) bonus.add(term);
  } else if (t) {
    required.add(t);
    for (const syn of CATALOG_SEARCH_SYNONYMS[t] || []) required.add(syn);
    // [2026-10-03] « ajoute un mug » sortait une CHOPE À BIÈRE (« Stein Mug »,
    // ex-aequo tiré au sort) : variantes qui sont un autre objet, écartées
    // sauf si l'utilisateur les nomme.
    const raw = String(rawText || '').toLowerCase();
    for (const term of OTHER_OBJECT_VARIANTS[t] || []) {
      if (!new RegExp(`\\b${escapeRe(term)}`, 'i').test(raw)) exclude.add(term);
    }
  }
  for (const w of String(rawText || '').toLowerCase().split(/[^a-zà-ÿ0-9-]+/i)) {
    if (w.length >= 4 && !CATALOG_STOPWORDS.has(w) && !required.has(w)) bonus.add(w);
  }
  return {
    required: Array.from(required).filter(Boolean),
    bonus: Array.from(bonus).filter(Boolean),
    exclude: Array.from(exclude).filter(Boolean),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Classe le catalogue par pertinence : un candidat DOIT matcher au moins un
 * terme « required » (type canonique/synonyme catalogue) pour être retenu —
 * les mots « bonus » (pris dans le nom du produit) ne font que départager les
 * candidats déjà qualifiés, ils ne qualifient jamais seuls. Score conservé
 * pour regrouper les meilleurs matches ex-aequo. */
function scoreCatalogWithScore(
  catalog: CatalogEntry[],
  terms: { required: string[]; bonus: string[]; exclude?: string[] },
): Array<{ entry: CatalogEntry; score: number }> {
  const scoreFor = (title: string, term: string): number => {
    if (!term) return 0;
    const wordRe = new RegExp(`\\b${escapeRe(term)}\\b`, 'i');
    if (wordRe.test(title)) return 3;
    return title.includes(term) ? 1 : 0;
  };
  const exclude = terms.exclude || [];
  return catalog
    .map((entry) => {
      const title = entry.title.toLowerCase();
      // [2026-09-25] Un titre appartenant à une AUTRE famille que celle
      // demandée est écarté quel que soit son score : c'est ce qui empêche une
      // basket de sortir en chaussons (les deux matchaient « required » avant).
      if (exclude.some((term) => scoreFor(title, term) > 0)) return { entry, score: 0 };
      const requiredScore = terms.required.reduce((sum, term) => sum + scoreFor(title, term), 0);
      if (terms.required.length && requiredScore === 0) return { entry, score: 0 };
      const bonusScore = terms.bonus.reduce((sum, term) => sum + scoreFor(title, term), 0);
      return { entry, score: requiredScore + bonusScore };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.length - b.entry.title.length);
}

/**
 * Résout le blueprint d'un produit en cherchant EN DIRECT dans le catalogue
 * Printify (catalog/blueprints.json), au lieu de dépendre d'une table figée.
 * Pour N'IMPORTE QUEL produit demandé (pas seulement ceux déjà mappés dans
 * BLUEPRINT_BY_POD_TYPE) : on cherche les blueprints dont le titre correspond
 * au produit, on vérifie que le meilleur candidat est réellement fabricable
 * (provider + variantes actifs via isBlueprintAvailable), et on ne l'utilise
 * que dans ce cas. Si le catalogue live ne donne AUCUNE correspondance et
 * qu'aucun secours statique n'est disponible non plus → null, et l'appelant
 * abandonne le produit (jamais de t-shirt de substitution).
 */
export async function resolveBlueprintDynamic(
  cfg: printify.PrintifyConfig,
  text: string,
  /**
   * [2026-09-25] Type de produit AUTORITAIRE (décidé en amont par pod-guard :
   * `decision.podType`, `p.productType`…). Les appelants le concaténaient au
   * nom du produit dans `text`, donc un nom inventé par l'IA pouvait voler le
   * type : « Canvas Kicks » → poster (synonyme « canvas »), « Summit High
   * Top » → t-shirt. Passé ici, il décide du type ; le nom ne sert plus qu'à
   * départager les modèles.
   */
  typeHint?: string,
): Promise<number | null> {
  const podType =
    normalizePodProductType(typeHint || '') || normalizePodProductType(text || '');
  const terms = catalogSearchTerms(podType || '', text);
  const catalog = await getLiveCatalog(cfg);

  if (catalog.length && (terms.required.length || terms.bonus.length)) {
    const scored = scoreCatalogWithScore(catalog, terms).slice(0, 8);
    // [2026-09-23] Johne : ne pas toujours retourner LE MÊME modèle pour un
    // même type de produit (ex. « chaussure » → toujours le même blueprint
    // sneakers). Printify propose plusieurs blueprints pertinents pour un
    // même type (plusieurs modèles de chaussures, plusieurs coupes de
    // t-shirt…) — on garde le classement par pertinence (score décroissant),
    // mais on tire au hasard parmi les ex-aequo de chaque palier plutôt que
    // de toujours prendre le premier trouvé dans l'ordre du catalogue.
    const byScore = new Map<number, CatalogEntry[]>();
    for (const s of scored) {
      if (!byScore.has(s.score)) byScore.set(s.score, []);
      byScore.get(s.score)!.push(s.entry);
    }
    const tiers = Array.from(byScore.keys()).sort((a, b) => b - a);
    for (const score of tiers) {
      const pool = [...byScore.get(score)!];
      while (pool.length) {
        const idx = Math.floor(Math.random() * pool.length);
        const candidate = pool.splice(idx, 1)[0];
        if (await isBlueprintAvailable(cfg, candidate.id)) return candidate.id;
      }
    }
  }

  // Secours : catalogue live inaccessible (token/réseau) ou aucune
  // correspondance trouvée malgré un type canonique connu — on tente l'ID
  // historiquement vérifié plutôt que d'abandonner le produit à cause d'une
  // panne temporaire de l'API, mais uniquement après avoir cherché en direct.
  // [2026-09-25] Exception chaussure : l'ID de secours est un modèle de
  // baskets. L'utiliser pour des chaussons/sandales/bottes fabriquerait le
  // MAUVAIS produit — même principe que « jamais de t-shirt de substitution ».
  // On préfère abandonner : la recherche live reste la seule voie pour ces
  // styles.
  const staticEligible =
    podType !== 'shoe' || detectFootwearStyle(text || '') === SNEAKER_STYLE;
  const staticId = podType && staticEligible ? BLUEPRINT_BY_POD_TYPE[podType] : undefined;
  if (staticId && (await isBlueprintAvailable(cfg, staticId))) return staticId;

  return null;
}

// Cache des blueprints VÉRIFIÉS disponibles côté Printify (providers +
// variantes réellement proposés). Évite de re-interroger le catalogue à chaque
// produit d'un même build.
const availabilityCache = new Map<number, boolean>();

/**
 * Vérifie auprès du catalogue Printify que ce blueprint est réellement
 * fabricable AUJOURD'HUI (au moins un print provider avec des variantes).
 * Un blueprint retiré du catalogue ou sans provider renvoie false → le produit
 * est abandonné plutôt que créé sur un produit de repli.
 */
export async function isBlueprintAvailable(
  cfg: printify.PrintifyConfig,
  blueprintId: number,
): Promise<boolean> {
  const cached = availabilityCache.get(blueprintId);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const provRes = await printify.getBlueprintProviders(cfg, blueprintId);
    const providers: any[] = provRes.ok && Array.isArray(provRes.data) ? provRes.data : [];
    if (providers.length) {
      const varRes = await printify.getBlueprintVariants(cfg, blueprintId, Number(providers[0].id));
      ok = !!varRes.ok && !!((varRes.data as any)?.variants || []).length;
    }
  } catch {
    ok = false;
  }
  availabilityCache.set(blueprintId, ok);
  return ok;
}

// Décode un data URL (data:image/png;base64,...) ou du base64 brut en Buffer.
function dataUrlToBuffer(dataUrl: string): Buffer {
  const s = String(dataUrl || "").trim();
  if (!s) throw new Error("design vide");
  const m = /^data:([^;,]+)?(;[^,]*)?,(.*)$/s.exec(s);
  if (m) {
    const meta = m[2] || "";
    const payload = m[3] || "";
    if (/base64/i.test(meta)) return Buffer.from(payload, "base64");
    return Buffer.from(decodeURIComponent(payload), "binary");
  }
  // Pas de préfixe : on suppose du base64 nu.
  return Buffer.from(s.replace(/\s+/g, ""), "base64");
}

// Ratio largeur/hauteur RÉEL de la zone d'impression du produit, lu depuis les
// placeholders renvoyés par le catalogue Printify (ex. front 4200x4800 → 0.875).
function placeholderRatio(variant: any, position: string): number {
  const holders: any[] = Array.isArray(variant?.placeholders) ? variant.placeholders : [];
  const wanted = String(position || "front").toLowerCase();
  const hit =
    holders.find((h) => String(h?.position || "").toLowerCase() === wanted) || holders[0];
  const w = Number(hit?.width);
  const h = Number(hit?.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h;
  return 0.875; // fallback t-shirt standard
}

// Choisit les positions de print-area RÉELLEMENT valables pour ce blueprint,
// à partir des placeholders renvoyés par Printify — jamais une liste figée.
// Certains produits (chaussures : uniquement des zones latérales, pas de
// "front") rejettent l'API avec 422 "Placeholder: X is invalid" si on
// s'obstine sur la position demandée. On retombe alors dynamiquement sur les
// zones extérieures/visibles réellement disponibles pour CE produit.
export function resolvePlacementPositions(placeholders: any[] | undefined, requested?: string, opts: { includeInside?: boolean } = {}): string[] {
  const holders = Array.isArray(placeholders) ? placeholders : [];
  const available = Array.from(new Set(holders.map((h) => String(h?.position || "")).filter(Boolean)));
  const want = String(requested || "front").toLowerCase();
  if (!available.length) return [requested || "front"];
  const exact = available.find((p) => p.toLowerCase() === want);
  if (exact) return [exact];
  // [2026-10-04] Design all-over de chaussure : TOUTES les zones du corps
  // (extérieur ET intérieur de chaque pied) — une basket imprimée dont seul
  // le flanc extérieur porte le motif a l'air inachevée.
  if (opts.includeInside) return available;
  // Pas de zone demandée pour ce produit : on privilégie les zones visibles
  // "extérieures" (ex. body_outside_left/right d'une chaussure) plutôt que les
  // zones "internes" (doublure), et on imprime le même design sur chacune.
  const outside = available.filter((p) => !/inside/i.test(p));
  return outside.length ? outside : available;
}

/**
 * [2026-10-04] Comment imprimer l'artwork d'une CHAUSSURE quand l'appelant
 * n'a rien précisé (routes qui réutilisent un design déjà stocké) :
 *  - artwork large (≥ 1.8:1, format généré pour l'empeigne) ou sans fond
 *    uniforme à détourer → c'est un motif complet : all-over, fond conservé ;
 *  - motif isolé sur fond blanc (ancien design « t-shirt ») → détouré et
 *    centré en grand sur le flanc.
 * Pur → testable.
 */
export function footwearArtworkMode(sourceAspect: number, uniformBackground: boolean): { style: artwork.PlacementStyle; keepBackground: boolean } {
  if (Number.isFinite(sourceAspect) && sourceAspect >= 1.8) return { style: "all_over", keepBackground: true };
  if (!uniformBackground) return { style: "all_over", keepBackground: true };
  return { style: "centered", keepBackground: false };
}

// [2026-10-03] Bas (pantalon, jogging, short) : Printify n'a PAS de zone
// « front » sur ces blueprints, seulement des zones par jambe
// (front_left_leg_dtf, left_leg_front, left_leg_back…). resolvePlacementPositions
// retombait alors sur TOUTES les zones extérieures, et le même grand visuel
// « poitrine » s'imprimait sur chaque jambe, devant ET derrière. Un vrai
// pantalon de marque porte un repère discret sur le devant d'une jambe : on
// garde donc une seule zone avant (jambe gauche de préférence) en style logo.
// Les chaussettes et leggings, qui se vendent imprimés sur les deux jambes,
// ne sont pas concernés.
const BOTTOMS_TITLE = /\b(trousers?|pants|sweatpants|joggers?|shorts)\b/i;
const NOT_BOTTOMS_TITLE = /\b(leggings?|socks?|pajama|swim)\b/i;

export function isBottomsGarment(catalogTitle: string, productTitle = ''): boolean {
  const t = `${catalogTitle || ''} ${catalogTitle ? '' : productTitle || ''}`;
  return BOTTOMS_TITLE.test(t) && !NOT_BOTTOMS_TITLE.test(t);
}

/** Zone d'impression unique pour un bas : devant de la jambe gauche si possible. */
export function legPlacementPositions(positions: string[]): string[] {
  const legs = positions.filter((p) => /leg/i.test(p));
  if (!legs.length) return positions;
  const front = legs.filter((p) => /front/i.test(p) && !/back/i.test(p));
  const pool = front.length ? front : legs.filter((p) => !/back/i.test(p));
  if (!pool.length) return positions;
  return [pool.find((p) => /left/i.test(p)) || pool[0]];
}

export interface AutoProductInput {
  title: string;
  description: string;
  designDataUrl: string; // data:image/...;base64,... (design/artwork à imprimer)
  priceCents: number; // prix de vente unitaire en centimes
  blueprintId?: number; // sinon deviné depuis le title
  maxVariants?: number; // limite le nombre de variantes activées (défaut 100)
  /** Position d'impression (défaut "front"). */
  position?: string;
  /** Style de placement — sinon déduit du type de produit. */
  placementStyle?: artwork.PlacementStyle;
  /** Nombre de coloris de vêtement à activer (défaut 4). */
  maxColors?: number;
  /** Désactive le détourage du fond (motif all-over voulu plein cadre). */
  keepBackground?: boolean;
}

export interface AutoProductResult {
  ok: boolean;
  error?: string;
  printifyProductId?: string;
  blueprintId?: number;
  providerId?: number;
  imageId?: string;
  variants?: Array<{ vid: number; label: string; price: number }>;
  /** Prix de vente « à partir de » (unité monétaire), calculé sur le coût réel. */
  retailPrice?: number;
  /** Coût de production réel Printify (variante la plus chère), null si inconnu. */
  costPrice?: number | null;
  /** Marge en % du prix de vente. */
  margin?: number | null;
  /** Prix calculé bien repoussé sur la boutique Printify. */
  pricePushed?: boolean;
  /** Comment le design a été préparé et placé (diagnostic + affichage). */
  design?: {
    backgroundRemoved: boolean;
    width: number;
    height: number;
    placement: artwork.PlacementGeometry;
    style: artwork.PlacementStyle;
    colors: string[];
  };
  /** Publication vers un canal de vente EXTERNE confirmée (Etsy/Shopify/…). */
  published?: boolean;
  /** Comment le produit se vend : voir PublishOutcome.mode. */
  publishMode?: PublishOutcome['mode'];
  /** Détail de publication (ex. boutique sans canal externe). */
  publishMessage?: string;
}

// Lit les coûts réels d'une réponse produit Printify et calcule les prix des
// variantes retenues. Pur → testable. null si aucun coût n'est présent.
export function pricingFromProductData(data: any, variantIds: number[], requestedCents: number) {
  const wanted = new Set(variantIds);
  const raw: any[] = Array.isArray(data?.variants) ? data.variants : [];
  const costed: CostedVariant[] = raw
    .map((v) => ({ id: Number(v?.id) || 0, cost: Number(v?.cost) || 0, is_enabled: true }))
    .filter((v) => v.id > 0 && (!wanted.size || wanted.has(v.id)));
  return priceVariantsFromCost(costed, requestedCents);
}

// Crée + publie un produit Printify complet à partir d'un design.
export async function autoCreatePrintifyProduct(
  cfg: printify.PrintifyConfig,
  input: AutoProductInput,
): Promise<AutoProductResult> {
  try {
    const shopId = await printify.resolveShopId(cfg);
    if (!shopId) return { ok: false, error: "Aucun shop Printify trouvé" };
    cfg = { ...cfg, shopId };

    // [2026-09-19] Dernier rempart, commun à TOUS les appelants : sans
    // blueprint explicite, le titre doit décrire un produit Printify réel.
    // Auparavant on retombait sur le t-shirt, ce qui transformait n'importe
    // quel produit (une voiture, un canapé) en vêtement à logo.
    const blueprintId = input.blueprintId ?? resolveBlueprint(input.title);
    if (!blueprintId) {
      return {
        ok: false,
        error: `Produit impossible à fabriquer : "${input.title}" ne correspond à aucun produit que l'on sait imprimer. Aucun produit de remplacement n'est créé.`,
      };
    }

    // Disponibilité RÉELLE du blueprint dans le catalogue (providers + variantes).
    if (!(await isBlueprintAvailable(cfg, blueprintId))) {
      return {
        ok: false,
        error: `Produit indisponible à la fabrication pour l'instant — produit abandonné, pas de substitution.`,
      };
    }

    // 1. Premier print provider disponible pour ce blueprint.
    const provRes = await printify.getBlueprintProviders(cfg, blueprintId);
    if (!provRes.ok) return { ok: false, error: `Providers introuvables (blueprint ${blueprintId}): ${provRes.message || provRes.status}` };
    const providers: any[] = Array.isArray(provRes.data) ? provRes.data : [];
    if (!providers.length) return { ok: false, error: `Aucun print provider pour le blueprint ${blueprintId}` };
    const providerId = Number(providers[0].id);

    // 2. Variantes du blueprint/provider.
    const varRes = await printify.getBlueprintVariants(cfg, blueprintId, providerId);
    if (!varRes.ok) return { ok: false, error: `Variantes introuvables: ${varRes.message || varRes.status}` };
    const rawVariants: any[] = (varRes.data as any)?.variants || [];
    if (!rawVariants.length) return { ok: false, error: "Aucune variante disponible" };
    const cap = input.maxVariants ?? 100;
    const price = Math.max(100, Math.round(input.priceCents || 2500));

    // 3. Préparation du design AVANT tout choix de couleur ou de placement.
    // Détourage du fond blanc de l'image IA, rognage, montée en résolution.
    // Sans cette étape, Printify imprime le fond blanc : le vêtement porte un
    // carré blanc au lieu d'un vrai design.
    // Le type de produit (« kind ») décide du style de placement (motif
    // all-over vs grand visuel) : on le lit sur le titre RÉEL du blueprint
    // chez Printify (catalogue live), pas seulement sur le nom donné par l'IA
    // — un produit nommé « Urban Glide » ne contient pas le mot « chaussure »,
    // mais son blueprint Printify s'appelle « Men's sneakers ».
    const catalogEntry = (await getLiveCatalog(cfg)).find((c) => c.id === blueprintId);
    const kind = artwork.productKindFromBlueprint(blueprintId, input.title, catalogEntry?.title || "");
    const footwear = kind === "footwear";

    let art: artwork.ArtworkInfo;
    let footwearStyle: artwork.PlacementStyle | null = null;
    try {
      const src = dataUrlToBuffer(input.designDataUrl);
      if (footwear && !input.placementStyle && input.keepBackground === undefined) {
        // Chaussure sans consigne de l'appelant : on regarde l'artwork lui-même.
        const kept = await artwork.prepareArtwork(src, { removeBackground: false });
        const cut = kept.aspect >= 1.8 ? null : await artwork.prepareArtwork(src, { removeBackground: true });
        const mode = footwearArtworkMode(kept.aspect, !!cut?.backgroundRemoved);
        footwearStyle = mode.style;
        art = mode.keepBackground ? kept : cut!;
      } else {
        art = await artwork.prepareArtwork(src, {
          removeBackground: !input.keepBackground,
        });
      }
    } catch (e: any) {
      return { ok: false, error: `Échec préparation du design: ${e?.message || e}` };
    }

    // 4. Choix des variantes : on garde les coloris qui font ressortir le
    // design, puis TOUTES les tailles de ces coloris.
    const colorOf = (v: any): string => String(v?.options?.color || "");
    const sizeOf = (v: any): string => String(v?.options?.size || "");
    const availableColors = rawVariants.map(colorOf).filter(Boolean);

    let chosen: any[];
    let chosenColors: string[] = [];
    if (availableColors.length) {
      const picks = pickGarmentColors(availableColors, art.meanLuminance, input.maxColors ?? 4);
      chosenColors = picks.map((p) => p.color);
      const wanted = new Set(chosenColors);
      const bySize = new Map<string, any[]>();
      for (const v of rawVariants) {
        if (!wanted.has(colorOf(v))) continue;
        const s = sizeOf(v) || "unique";
        if (!bySize.has(s)) bySize.set(s, []);
        bySize.get(s)!.push(v);
      }
      // Ordonne taille par taille pour que le sélecteur du site soit lisible.
      chosen = sortSizes([...bySize.keys()]).flatMap((s) => bySize.get(s) || []);
    } else {
      // Produit sans option couleur (mug, poster…) : toutes les variantes.
      chosen = [...rawVariants];
    }
    chosen = chosen.slice(0, cap);
    if (!chosen.length) return { ok: false, error: "Aucune variante retenue après sélection des coloris" };

    const variantInputs: printify.PrintifyVariantInput[] = chosen.map((v) => ({
      id: Number(v.id),
      price,
      is_enabled: true,
    }));
    const variantIds = variantInputs.map((v) => v.id);

    // 5. Placement réaliste : on lit les positions ET dimensions RÉELLES de
    // la/les zone(s) d'impression du produit (jamais une position figée —
    // certains produits comme les chaussures n'ont pas de zone "front", mais
    // uniquement des zones latérales) pour calculer x/y/scale (au lieu d'un
    // scale 0.9 centré qui étirait le design des aisselles à l'ourlet).
    const bottoms = isBottomsGarment(catalogEntry?.title || "", input.title);
    const footwearChoice = footwear ? (input.placementStyle || footwearStyle || artwork.defaultStyleForPosition("", kind)) : null;
    const rawPositions = resolvePlacementPositions(
      chosen[0]?.placeholders || rawVariants[0]?.placeholders,
      input.position,
      { includeInside: footwearChoice === "all_over" },
    );
    const positions = bottoms && !input.position ? legPlacementPositions(rawPositions) : rawPositions;
    const style = footwearChoice || input.placementStyle || (bottoms ? "logo" : artwork.defaultStyleForPosition(positions[0], kind));
    const placement = artwork.placementFor(style, art.aspect, placeholderRatio(chosen[0], positions[0]));

    // 6. Upload de l'artwork PRÉPARÉ (une seule fois), puis print_areas.
    const upload = await printify.uploadImageByBase64(
      cfg,
      `design-${Date.now()}.png`,
      art.buffer.toString("base64"),
    );
    if (!upload.ok) return { ok: false, error: `Upload du design refusé: ${upload.message || upload.status}` };
    const imageId = String((upload.data as any)?.id || "");
    if (!imageId) return { ok: false, error: "Upload du design: id manquant" };

    // Une zone par position réelle disponible : sur une chaussure sans zone
    // "front", on imprime le même design sur chaque zone extérieure trouvée
    // (ex. body_outside_left + body_outside_right) plutôt que d'échouer.
    const areas: printifyDesign.DesignPrintArea[] = positions.map((pos) => ({
      position: pos,
      layers: [{ type: "image", imageId, ...artwork.placementFor(style, art.aspect, placeholderRatio(chosen[0], pos)) }],
    }));
    let printAreas: printify.PrintifyPrintArea[];
    try {
      printAreas = await printifyDesign.buildPrintAreas(cfg, areas, variantIds);
    } catch (e: any) {
      return { ok: false, error: `Échec construction du design: ${e?.message || e}` };
    }

    // 4. Création du produit.
    const productInput: printify.PrintifyProductInput = {
      title: input.title.slice(0, 120),
      description: (input.description || input.title).slice(0, 2000),
      blueprint_id: blueprintId,
      print_provider_id: providerId,
      variants: variantInputs,
      print_areas: printAreas,
    };
    const created = await printify.createProduct(cfg, productInput);
    if (!created.ok) return { ok: false, error: `createProduct refusé: ${created.message || (created.data as any)?.error || created.status}`, blueprintId, providerId, imageId };
    const printifyProductId = String((created.data as any)?.id || "");
    if (!printifyProductId) return { ok: false, error: "createProduct: id manquant", blueprintId, providerId, imageId };

    // 4b. PRIX = COÛT RÉEL PRINTIFY + VRAIE MARGE. Printify ne donne le coût de
    // production qu'une fois le produit créé (champ `cost` des variantes) : on
    // le lit, on calcule le prix de chaque variante (pricing.ts) et on le
    // repousse AVANT publication (un produit publié peut être verrouillé).
    // Avant, le prix envoyé (25 € par défaut) restait tel quel, même quand il
    // couvrait à peine le coût.
    let pricing = pricingFromProductData(created.data, variantIds, price);
    if (!pricing) {
      const fresh = await printify.getProduct(cfg, printifyProductId).catch(() => null);
      if (fresh?.ok) pricing = pricingFromProductData(fresh.data, variantIds, price);
    }
    let pricePushed = false;
    if (pricing) {
      const p = pricing;
      const changed = variantInputs.some((v) => (p.priceCents.get(v.id) ?? v.price) !== v.price);
      if (changed) {
        const upd = await printify.updateProduct(cfg, printifyProductId, {
          variants: variantInputs.map((v) => ({ ...v, price: p.priceCents.get(v.id) ?? v.price })),
        }).catch(() => null);
        pricePushed = !!upd?.ok;
      } else {
        pricePushed = true;
      }
    }

    // 5. Publication. Une boutique sans canal de vente externe n'est PAS une
    // erreur : le produit reste réel et vendable depuis le site Velbaz.
    const outcome = await publishForSale(cfg, printifyProductId);
    const published = outcome.published;

    // Labels des variantes (taille/couleur) pour le sélecteur du site.
    const labelFor = (v: any): string => {
      if (v?.title) return String(v.title);
      const opts = v?.options && typeof v.options === "object" ? Object.values(v.options).join(" / ") : "";
      return opts || `Variante ${v?.id}`;
    };
    // Prix réellement appliqués chez Printify. Si le push a échoué, le site
    // affiche quand même le bon prix (le checkout facture le prix Velbaz, pas
    // celui de Printify) — le coût reste couvert.
    const variants = chosen.map((v) => ({
      vid: Number(v.id),
      label: labelFor(v),
      price: Number((((pricing?.priceCents.get(Number(v.id))) ?? price) / 100).toFixed(2)),
    }));

    return {
      ok: true, printifyProductId, blueprintId, providerId, imageId, variants,
      retailPrice: pricing ? pricing.retailPrice : price / 100,
      costPrice: pricing ? pricing.costPrice : null,
      margin: pricing ? pricing.margin : null,
      pricePushed,
      design: {
        backgroundRemoved: art.backgroundRemoved,
        width: art.width,
        height: art.height,
        placement,
        style,
        colors: chosenColors,
      },
      published, publishMode: outcome.mode, publishMessage: outcome.message,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export interface PublishOutcome {
  /** Produit réellement vendable (existe sur la boutique Printify). */
  sellable: boolean;
  /** Publication vers un canal de vente externe confirmée. */
  published: boolean;
  /**
   * 'published'            : poussé vers le canal externe (Etsy/Shopify/…)
   * 'sold_on_velbaz'       : boutique sans canal externe → le site Velbaz vend
   * 'error'                : refus Printify inattendu
   */
  mode: 'published' | 'sold_on_velbaz' | 'error';
  message?: string;
}

// Publie un produit de la façon la plus utile selon la boutique :
//   - boutique reliée à un canal (Etsy/Shopify/…) : publish.json puis
//     publishing_succeeded.json pour déverrouiller le produit et enregistrer le
//     lien vers la page du site Velbaz.
//   - boutique sans canal externe ("disconnected") : Printify refuse la
//     publication (code 8254), et c'est NORMAL — le produit existe, il est
//     visible, il se vend depuis le site Velbaz et les commandes partent en
//     production par l'API. On ne remonte donc PAS une erreur.
export async function publishForSale(
  cfg: printify.PrintifyConfig,
  productId: string,
  externalUrl?: string,
): Promise<PublishOutcome> {
  try {
    const pub = await printify.publishProduct(cfg, productId);
    if (pub.ok) {
      // Déverrouille le produit côté Printify (sinon il reste bloqué en
      // « publication en cours » et devient non modifiable).
      await printify.publishingSucceeded(cfg, productId, { id: productId, handle: externalUrl || '' });
      return { sellable: true, published: true, mode: 'published' };
    }
    if (printify.isShopNotConnected(pub)) {
      return {
        sellable: true,
        published: false,
        mode: 'sold_on_velbaz',
        message: 'Le produit se vend depuis le site Velbaz.',
      };
    }
    return { sellable: true, published: false, mode: 'error', message: pub.message || `HTTP ${pub.status}` };
  } catch (e: any) {
    return { sellable: true, published: false, mode: 'error', message: e?.message || String(e) };
  }
}

// Récupère l'URL du mockup (photo produit RÉELLE générée par Printify) d'un
// produit. C'est cette image — et jamais une image inventée par l'IA — qu'on
// affiche. Renvoie '' si aucun mockup disponible.
export async function fetchDefaultMockup(cfg: printify.PrintifyConfig, productId: string): Promise<string> {
  try {
    const shopId = await printify.resolveShopId(cfg);
    if (!shopId) return '';
    const res = await printify.getProduct({ ...cfg, shopId }, String(productId));
    if (!res.ok) return '';
    const images: any[] = (res.data as any)?.images || [];
    if (!images.length) return '';
    const def = images.find((i) => i?.is_default) || images.find((i) => i?.is_selected_for_publishing) || images[0];
    return String(def?.src || '');
  } catch { return ''; }
}
