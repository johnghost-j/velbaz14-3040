// ─── Garde-fou print-on-demand (Printify) ────────────────────────────────────
// Problème corrigé ici : quand l'utilisateur demandait « crée une marque de
// voiture », l'aperçu de marque fabriquait quand même un hoodie + un t-shirt
// (Printify n'imprime que du merch). L'idée était donc transformée en goodies
// à l'effigie de la marque au lieu d'être respectée.
//
// Deux règles, déterministes (aucune dépendance au LLM) :
//  1. On ne fabrique du merch print-on-demand QUE si l'activité est réellement
//     imprimable (textile/accessoires/déco) OU si l'utilisateur a explicitement
//     demandé du merch. Une activité « non imprimable » (voiture, immobilier,
//     restaurant, mobilier, électronique, bijou, cosmétique…) → aucun produit.
//  2. Le type de produit renvoyé par l'IA doit correspondre à un vrai produit
//     Printify connu. Sinon on le JETTE, au lieu de retomber en silence sur un
//     t-shirt (c'est ce fallback qui « habillait » toutes les marques).
//
// Toute recherche de mot se fait sur des MOTS ENTIERS : c'est ce qui évite le
// faux positif historique où « mode » matchait à l'intérieur de « moderne »
// (« voiture électrique moderne » était classée mode/textile).

/** Échappe un terme pour l'insérer dans une regex. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Vrai si `text` contient l'un de ces termes en tant que MOT ENTIER
 * (accents gérés, casse ignorée, expressions multi-mots acceptées).
 * « moderne » ne matche donc PAS « mode ».
 */
export function containsWord(text: string, words: string[]): boolean {
  const t = ` ${String(text || '').toLowerCase().replace(/[\s\-_/]+/g, ' ')} `;
  return words.some((w) => {
    const term = String(w || '').toLowerCase().trim();
    if (!term) return false;
    // (?![\p{L}\p{N}]) : pas de lettre/chiffre collée → mot entier.
    // Pluriel simple toléré (« t-shirts », « voitures ») sans jamais accepter
    // une sous-chaîne (« moderne » ne matche pas « mode »).
    const plural = /s$/.test(term) ? '' : '(?:s|es)?';
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}${plural}(?![\\p{L}\\p{N}])`, 'iu');
    return re.test(t);
  });
}

/**
 * Premier terme de `words` présent en tant que mot entier dans `text`, sinon
 * null. Sert à EXPLIQUER une décision à l'utilisateur (« déclenché par
 * "t-shirt" ») au lieu de la subir en silence.
 */
export function firstMatch(text: string, words: string[]): string | null {
  for (const w of words) if (containsWord(text, [w])) return w;
  return null;
}

// ─── Types de produits réellement fabricables (mappés aux blueprints) ────────
// Clé = type canonique (utilisé ensuite par printifyAuto.guessBlueprint),
// valeur = synonymes FR/EN acceptés depuis la sortie IA.
// [2026-09-19] Élargie au catalogue RÉEL. Avant, seuls 7 types existaient
// (t-shirt, hoodie, mug, poster, tote, sticker, coque) : une marque de
// coussins, de plaids ou de paillassons — que Printify fabrique vraiment —
// était donc refusée comme « non imprimable ». Chaque type ajouté ici a été
// vérifié sur le catalogue Printify (blueprint existant, au moins un print
// provider, des variantes, et une zone d'impression « front »).
// L'ORDRE COMPTE : le premier type qui matche gagne, donc les libellés
// spécifiques passent avant les génériques (« coussin de sol » avant
// « coussin », « tapis de souris » avant « tapis »).
const POD_TYPE_SYNONYMS: Record<string, string[]> = {
  't-shirt': ['t shirt', 't-shirt', 'tshirt', 'tee', 'tee shirt', 'teeshirt', 'shirt', 'top', 'tank top', 'debardeur', 'débardeur', 'maillot'],
  hoodie: ['hoodie', 'hooded sweatshirt', 'sweat a capuche', 'sweat à capuche', 'sweatshirt', 'sweat', 'crewneck', 'pull', 'pullover'],
  mug: ['mug', 'tasse', 'cup', 'coffee mug', 'enamel mug'],
  poster: ['poster', 'affiche', 'art print', 'print', 'wall art', 'canvas', 'toile imprimee', 'toile imprimée'],
  'tote bag': ['tote bag', 'tote', 'sac', 'sac en toile', 'cabas', 'shopping bag', 'bag'],
  sticker: ['sticker', 'stickers', 'autocollant', 'autocollants', 'decal'],
  'phone case': ['phone case', 'case', 'coque', 'coque de telephone', 'coque de téléphone', 'iphone case', 'samsung case'],
  // ── Maison & déco (tous vérifiés au catalogue) ──
  'floor pillow': ['coussin de sol', 'coussins de sol', 'floor pillow', 'tufted floor pillow'],
  'bean bag': ['pouf', 'poufs', 'housse de pouf', 'bean bag', 'beanbag', 'bean bag chair', 'bean bag chair cover'],
  cushion: ['coussin', 'coussins', 'housse de coussin', 'pillow', 'throw pillow', 'cushion', 'pillowcase'],
  blanket: ['plaid', 'plaids', 'couverture polaire', 'blanket', 'fleece blanket', 'sherpa blanket'],
  doormat: ['paillasson', 'paillassons', 'doormat', 'tapis de porte'],
  'mouse pad': ['tapis de souris', 'mouse pad', 'mousepad', 'gaming mouse pad'],
  rug: ['tapis', 'rug', 'area rug', 'round rug'],
  'shower curtain': ['rideau de douche', 'rideaux de douche', 'shower curtain'],
  apron: ['tablier', 'tabliers', 'apron'],
  puzzle: ['puzzle', 'puzzles', 'jigsaw', 'jigsaw puzzle'],
  'beach towel': ['serviette', 'serviettes', 'serviette de plage', 'drap de plage', 'beach towel', 'towel'],
  'water bottle': ['gourde', 'gourdes', 'water bottle', 'bouteille isotherme', 'insulated bottle'],
  tumbler: ['tumbler', 'gobelet', 'travel mug'],
  cap: ['casquette', 'casquettes', 'cap', 'baseball cap', 'dad cap', 'trucker cap', 'snapback'],
  notebook: ['carnet', 'carnets', 'cahier', 'notebook', 'journal', 'bloc notes'],
  candle: ['bougie', 'bougies', 'candle', 'scented candle', 'bougie parfumee', 'bougie parfumée'],
  coaster: ['dessous de verre', 'sous verre', 'coaster', 'coasters'],
  // [2026-09-22] La chaussure EST le produit vendu et Printify fabrique de
  // vraies chaussures (baskets/sneakers) — ce n'est plus un « produit
  // physique réel non substituable », voir REAL_PRODUCT_BLUEPRINTS plus bas.
  shoe: ['chaussure', 'chaussures', 'basket', 'baskets', 'sneaker', 'sneakers', 'sneaker shoes', 'footwear', 'shoe', 'shoes', 'high top', 'high tops', 'low top', 'low tops'],
  // [2026-10-03] Bug signalé : « crée une marque de pantalons » ne créait
  // AUCUN produit Printify. L'IA de sélection renvoyait bien « pants », mais
  // ce type n'existait pas ici → normalisé en null → produit jeté en silence.
  // Printify fabrique pourtant ces vêtements : chaque type ci-dessous a été
  // vérifié en direct sur le catalogue (blueprint, print provider, variantes,
  // zones d'impression) — voir DEFAULT_BLUEPRINTS dans printify-auto.ts.
  // NB : Printify ne fabrique pas de vrai jean (denim) ; « jean » est rangé
  // sous 'pants' (pantalon), l'objet vendu le plus proche — c'est annoncé à
  // l'utilisateur via POD_TYPE_LABELS_FR.
  pants: ['pantalon', 'pantalons', 'pants', 'trousers', 'trouser', 'chino', 'chinos', 'pantalon cargo', 'cargo pants', 'jean', 'jeans', 'denim pants', 'slacks'],
  joggers: ['jogging', 'joggings', 'pantalon de jogging', 'bas de jogging', 'jogger', 'joggers', 'sweatpants', 'sweat pants', 'track pants', 'pantalon de survetement', 'pantalon de survêtement'],
  shorts: ['short', 'shorts', 'bermuda', 'bermudas', 'short de sport', 'short de bain', 'sweat shorts', 'jogger shorts', 'board shorts', 'swim shorts', 'swim trunks'],
  leggings: ['legging', 'leggings', 'yoga pants', 'pantalon de yoga', 'collant de sport'],
  dress: ['robe', 'robes', 'dress', 'dresses', 'robe t shirt', 't shirt dress', 'skater dress'],
  skirt: ['jupe', 'jupes', 'skirt', 'skirts', 'pencil skirt', 'skater skirt'],
  socks: ['chaussette', 'chaussettes', 'sock', 'socks', 'crew socks'],
  jacket: ['veste', 'vestes', 'blouson', 'blousons', 'jacket', 'jackets', 'bomber', 'bomber jacket', 'veste en jean', 'denim jacket', 'coupe vent', 'windbreaker', 'veste de survetement', 'veste de survêtement'],
  polo: ['polo', 'polos', 'polo shirt', 'pique polo', 'piqué polo'],
  beanie: ['bonnet', 'bonnets', 'beanie', 'beanies', 'cuff beanie'],
  backpack: ['sac a dos', 'sac à dos', 'sacs a dos', 'sacs à dos', 'backpack', 'backpacks'],
  swimsuit: ['maillot de bain', 'maillots de bain', 'swimsuit', 'swimsuits', 'bikini', 'one piece swimsuit'],
};

/** Libellés lisibles des types fabricables — sert à l'expliquer à l'utilisateur. */
export const POD_TYPE_LABELS_FR: Record<string, string> = {
  't-shirt': 't-shirt', hoodie: 'sweat à capuche', mug: 'mug', poster: 'poster/affiche',
  'tote bag': 'tote bag', sticker: 'sticker', 'phone case': 'coque de téléphone',
  'floor pillow': 'coussin de sol', 'bean bag': 'housse de pouf (bean bag)', cushion: 'coussin',
  blanket: 'plaid', doormat: 'paillasson', 'mouse pad': 'tapis de souris', rug: 'tapis',
  'shower curtain': 'rideau de douche', apron: 'tablier', puzzle: 'puzzle',
  'beach towel': 'serviette de plage', 'water bottle': 'gourde', tumbler: 'gobelet isotherme',
  cap: 'casquette', notebook: 'carnet', candle: 'bougie', coaster: 'dessous de verre',
  shoe: 'chaussures / sneakers',
  pants: 'pantalon (pas de vrai jean denim)', joggers: 'jogging / pantalon de survêtement',
  shorts: 'short', leggings: 'legging', dress: 'robe', skirt: 'jupe', socks: 'chaussettes',
  jacket: 'veste', polo: 'polo', beanie: 'bonnet', backpack: 'sac à dos', swimsuit: 'maillot de bain',
};

/** Tous les types réellement fabricables, pour les lister à l'utilisateur. */
export function podCatalogTypes(): string[] {
  return Object.keys(POD_TYPE_SYNONYMS);
}

/**
 * Ramène un « productType » libre renvoyé par l'IA à un type Printify connu.
 * Renvoie null si ce n'est pas un produit print-on-demand (ex. « car »,
 * « sedan », « sofa », « smartphone ») → le produit est alors abandonné au
 * lieu d'être imprimé sur un t-shirt par défaut.
 */
export function normalizePodProductType(raw: string): string | null {
  return bestPodSynonym(raw)?.canonical ?? null;
}

/**
 * Synonyme le PLUS SPÉCIFIQUE de POD_TYPE_SYNONYMS trouvé dans `raw` (plus de
 * mots, puis plus long ; à égalité l'ordre de la table tranche), avec son type
 * canonique. Partagé par normalizePodProductType et podMerchDecision pour que
 * « une marque de vestes en jean » donne 'jacket' (« veste en jean ») partout,
 * et jamais 'pants' (« jean ») à un endroit et 'jacket' à un autre.
 */
export function bestPodSynonym(
  raw: string,
  opts: { exclude?: ReadonlySet<string> } = {},
): { canonical: string; term: string } | null {
  const text = String(raw || '').toLowerCase().trim();
  if (!text) return null;
  // [2026-09-25] Avant, le PREMIER type de la table qui matchait gagnait. Comme
  // 't-shirt' est en tête et compte « top »/« shirt » parmi ses synonymes,
  // une basket nommée « Summit High Top » (ou « Urban Pulse Low Top ») était
  // normalisée en T-SHIRT et fabriquée en t-shirt, alors que 'shoe' liste
  // pourtant « high top »/« low top ». On retient donc le synonyme le plus
  // SPÉCIFIQUE trouvé dans le texte (le plus de mots, puis le plus long) —
  // « high top » (2 mots) bat « top » (1 mot), « coussin de sol » bat
  // « coussin », « tapis de souris » bat « tapis ». À spécificité égale,
  // l'ordre de la table tranche comme avant.
  let best: { canonical: string; term: string; words: number; len: number } | null = null;
  for (const [canonical, syns] of Object.entries(POD_TYPE_SYNONYMS)) {
    for (const syn of syns) {
      const term = String(syn || '').trim();
      if (!term || opts.exclude?.has(term.toLowerCase()) || !containsWord(text, [term])) continue;
      const words = term.split(/[\s\-_/]+/).filter(Boolean).length;
      if (!best || words > best.words || (words === best.words && term.length > best.len)) {
        best = { canonical, term, words, len: term.length };
      }
    }
  }
  return best ? { canonical: best.canonical, term: best.term } : null;
}

// [2026-09-19] PLUS AUCUNE LISTE NOIRE.
// Il existait ici une table `NON_POD_CATEGORIES` (automobile, immobilier,
// restauration, mobilier…) servant à REFUSER le merch. Elle est supprimée :
//  • une liste noire ne peut jamais être exhaustive — il y a une infinité
//    d'activités, donc elle laissait forcément passer des cas (c'est ce qui
//    produisait le « pull à logo de voiture ») ;
//  • elle jugeait l'activité de l'utilisateur à partir de mots-clés, ce qui
//    donnait des refus arbitraires et invisibles.
// La règle est désormais purement positive (opt-in) : on n'imprime QUE sur
// signal explicite de l'utilisateur, ou quand l'objet imprimé EST le produit
// vendu. Tout le reste ne déclenche rien — sans avoir besoin de savoir de
// quelle activité il s'agit. Et dans tous les cas, l'utilisateur est prévenu
// AVANT toute création (voir podAnnouncement ci-dessous).

// Demande EXPLICITE de merch imprimé : c'est le SEUL cas où on imprime pour
// une activité qui ne vend pas d'objets imprimés (ex. « des t-shirts pour ma
// marque de voiture », « une boutique de merch pour mon restaurant »).
const EXPLICIT_POD_REQUEST = [
  't shirt', 't-shirt', 'tshirt', 'tshirts', 'tee', 'tees', 'hoodie', 'hoodies', 'sweat', 'sweats',
  'sweatshirt', 'mug', 'mugs', 'tasse', 'tasses', 'poster', 'posters', 'affiche', 'affiches',
  'sticker', 'stickers', 'autocollant', 'autocollants', 'tote bag', 'tote', 'coque', 'phone case',
  'casquette', 'casquettes', 'cap', 'merch', 'merchandising', 'goodies', 'print on demand',
  'print-on-demand', 'printify', 'impression a la demande', 'impression à la demande',
];

// Activités NATIVEMENT print-on-demand (textile, accessoires imprimés, déco).
// Mots entiers uniquement : « mode » ne matche pas « moderne ».
const POD_NATIVE = [
  'vetement', 'vêtement', 'vetements', 'vêtements', 'clothing', 'clothes', 'apparel', 'fashion',
  'mode', 'pret a porter', 'prêt à porter', 'streetwear', 'textile', 'textiles', 'sportswear',
  'athleisure', 'lingerie', 'maillot de bain', 'marque de mode', 'couture', 'tricot',
  'papeterie', 'stationery', 'decoration murale', 'décoration murale', 'wall art', 'art print',
];
// Note : les termes trop génériques (« accessoires », « illustration », « design »)
// sont volontairement absents — « marque de voiture avec accessoires » ne doit
// pas être requalifiée en boutique de merch.

// ─── Produits physiques RÉELS, non substituables par du merch imprimé ───────
// [2026-09-20] Bug récurrent signalé : « crée-moi une marque de chaussures »
// produisait un t-shirt/hoodie avec un LOGO de chaussure dessus, jamais de
// vraies chaussures. Cause : le classifieur d'industrie range souvent ces
// activités sous un libellé générique « Fashion » / « Mode », qui matchait
// `POD_NATIVE` (« fashion », « mode ») même quand l'IDÉE elle-même ne vend pas
// de textile mais un objet précis (chaussure, bijou, sac, meuble…). Le
// vêtement/l'affiche devenait alors le produit par défaut au lieu du vrai
// produit demandé.
//
// Règle : si l'IDÉE nomme un de ces objets, c'est LUI le produit vendu — on ne
// le remplace jamais par un t-shirt/hoodie/mug à son effigie, même si le champ
// « industrie » dit « Fashion ». Seule une demande EXPLICITE de merch imprimé
// (EXPLICIT_POD_REQUEST) peut encore déclencher du Printify pour ces marques.
//
// [2026-09-22] Bug signalé plusieurs fois par l'utilisateur : « crée une marque
// de chaussures avec Printify connecté » créait quand même un t-shirt/hoodie à
// LOGO de chaussure au lieu de vraies chaussures. La règle du [2026-09-20]
// bloquait bien l'habillage textile de secours (c'était son but), mais elle ne
// proposait AUCUNE alternative : la chaussure était simplement abandonnée. Or
// Printify fabrique de VRAIES chaussures (baskets/sneakers, blueprints
// vérifiés au catalogue). Les chaussures sortent donc de cette liste de refus
// pur et rejoignent `POD_TYPE_SYNONYMS`/`REAL_PRODUCT_MATCH_TERMS` : elles sont
// désormais AUTORISÉES et mappées sur le vrai blueprint sneaker, jamais sur du
// merch textile. Les autres catégories (bijoux, sacs, montres, meubles…)
// restent bloquées tant que leurs blueprints Printify réels n'ont pas été
// vérifiés et ajoutés de la même façon.
const REAL_PHYSICAL_PRODUCT = [
  'botte', 'bottes', 'sandale', 'sandales', 'escarpin', 'escarpins', 'mocassin', 'mocassins',
  'sac a main', 'sac à main', 'sacs a main', 'sacs à main', 'handbag', 'handbags', 'purse', 'maroquinerie',
  'bijou', 'bijoux', 'jewelry', 'jewellery', 'bague', 'collier', 'bracelet',
  'montre', 'montres', 'watch', 'watches',
  'lunettes', 'lunette de soleil', 'eyewear', 'sunglasses',
  'meuble', 'meubles', 'furniture', 'mobilier',
  'bijouterie',
];

// Objets physiques réels dont Printify fabrique un VRAI blueprint (vérifié) :
// on n'abandonne plus le produit, on le fabrique pour de vrai (jamais en merch
// textile à logo). [2026-09-23] Élargi à TOUT le catalogue vérifié
// (POD_TYPE_SYNONYMS) — avant, seules les chaussures déclenchaient cette
// protection : une marque de « mugs » ou de « tapis » nommée explicitement
// dans l'idée pouvait donc encore se voir substituer un t-shirt/hoodie par
// l'IA de sélection produit. Aucune liste de produits n'est figée pour
// autant : tout type que Printify fabrique reste utilisable normalement
// (POD_NATIVE, EXPLICIT_POD_REQUEST) — ceci ne fait que dire « quand l'idée
// nomme PRÉCISÉMENT un type précis de ce catalogue, ce type gagne et n'est
// jamais remplacé par un autre ».
//
// [2026-10-03] Certains synonymes servent à lire la SORTIE de l'IA (« jean »,
// « polo ») mais sont ambigus dans une phrase libre : « Jean » est un prénom
// (« la boulangerie de Jean »), « Polo » une voiture ou un sport. Dans l'idée
// de l'utilisateur, ils ne suffisent donc pas à imposer un type — les formes
// non ambiguës (« jeans », « polos », « pantalon en jean ») restent reconnues.
// Idem « jogging » (le sport : « une appli de jogging ») et « short » seul
// (« un short film »). Les formes non ambiguës restent reconnues
// (« pantalon de jogging », « shorts », « bas de jogging »).
const IDEA_AMBIGUOUS_TERMS: ReadonlySet<string> = new Set(['jean', 'polo', 'jogging', 'joggings', 'short']);
const REAL_PRODUCT_MATCH_TERMS = Object.values(POD_TYPE_SYNONYMS)
  .flat()
  .filter((t) => !IDEA_AMBIGUOUS_TERMS.has(t.toLowerCase()));

// La description du projet est rédigée par l'IA (regenerateCompanyMeta) : elle
// corrige les fautes de l'idée (« mark de pentalon » → « Marque de pantalons »)
// mais contient aussi des mots courants qui ne désignent PAS un produit
// (« le top du confort », « en cas de… », « print »). Seuls les termes non
// ambigus y sont lus, sinon une marque de voitures « au design top » se
// verrait imposer des t-shirts.
const DESCRIPTION_AMBIGUOUS_TERMS: ReadonlySet<string> = new Set([
  ...IDEA_AMBIGUOUS_TERMS,
  'top', 'case', 'print', 'bag', 'cup', 'sac', 'journal', 'tee', 'cap', 'shirt', 'sweat', 'pull',
  'towel', 'serviette', 'serviettes', 'canvas', 'tapis', 'robe', 'robes', 'veste', 'vestes',
  'carnet', 'bougie', 'bougies', 'maillot', 'decal', 'pillow', 'tumbler', 'gobelet',
]);

/**
 * Vrai si l'idée nomme un produit physique RÉEL et précis (chaussure, bijou,
 * sac, montre, meuble…) qui n'est PAS un produit d'impression à la demande.
 * Sert à empêcher le classement « Fashion »/« Mode » (générique) de faire
 * passer ce produit pour du merch textile imprimable.
 * Note : les chaussures ne sont PAS dans cette liste depuis le [2026-09-22] —
 * Printify en fabrique de vraies, voir `isRealPrintableProduct`.
 */
export function isRealPhysicalProduct(idea?: string): boolean {
  return containsWord(String(idea || ''), REAL_PHYSICAL_PRODUCT) || isRealPrintableProduct(idea);
}

/**
 * Vrai si l'idée nomme un objet physique réel dont Printify fabrique un vrai
 * blueprint (pour l'instant : chaussures/sneakers). Dans ce cas, on ne bloque
 * pas et on ne substitue pas par du merch textile : on fabrique le vrai
 * produit. Reste `false` pour les autres « produits physiques réels »
 * (bijoux, sacs, montres…) tant qu'aucun blueprint n'a été vérifié pour eux.
 */
export function isRealPrintableProduct(idea?: string): boolean {
  return containsWord(String(idea || ''), REAL_PRODUCT_MATCH_TERMS);
}

export interface PodDecision {
  /** Faut-il fabriquer des produits print-on-demand pour cette idée ? */
  allowed: boolean;
  /**
   * Pourquoi. Deux seuls motifs d'autorisation (l'utilisateur l'a demandé, ou
   * l'objet imprimé est le produit vendu) et un seul motif de refus : ça n'a
   * pas été demandé. Aucun refus « par catégorie d'activité ».
   */
  reason: 'explicit_request' | 'pod_native' | 'real_product_match' | 'not_requested';
  /** Terme qui a déclenché la décision — pour l'expliquer à l'utilisateur. */
  match?: string;
}

/**
 * Décide si l'aperçu de marque doit fabriquer du merch Printify.
 *
 * [2026-09-19] Printify est OPT-IN, et SANS liste noire.
 * Avant : liste noire d'activités + `allowed: true` par défaut. Résultat, toute
 * activité absente de la liste recevait du merch imprimé — d'où la « marque de
 * pull à logo de voiture » alors que l'utilisateur demandait une marque de
 * voiture. Une liste noire ne pouvant pas être exhaustive, elle est supprimée
 * et la règle inversée. On n'imprime QUE si :
 *   ① l'utilisateur a explicitement nommé un objet imprimé (t-shirt, mug,
 *      merch, goodies…) → il l'a demandé, on le fait ;
 *   ② ou l'activité vend elle-même l'objet imprimé (marque de vêtements,
 *      textile, papeterie, déco murale) → l'objet imprimé EST le produit.
 * Sinon : rien. Pas besoin de deviner le secteur, ni de le juger.
 */
export function podMerchDecision(input: { idea?: string; industry?: string; description?: string }): PodDecision {
  const idea = String(input.idea || '');
  const industry = String(input.industry || '');
  const description = String(input.description || '');
  const haystack = `${idea} ${industry}`;

  const asked = firstMatch(idea, EXPLICIT_POD_REQUEST);
  if (asked) return { allowed: true, reason: 'explicit_request', match: asked };
  // [2026-09-20] Une marque de bijoux/sacs à main/montres/meubles… classée
  // sous un libellé d'industrie générique « Fashion »/« Mode » ne doit PAS
  // être prise pour du merch textile : aucun produit n'est créé plutôt que de
  // la remplacer par du merch. VÉRIFIÉ EN PREMIER : [2026-09-23] certains de
  // ces objets partagent un mot avec un type Printify réel mais différent
  // (« sac » = un « sac à main », pas le « tote bag » que fabrique Printify),
  // donc ce blocage précis doit gagner avant le match générique du catalogue
  // ci-dessous, sinon « une marque de sacs à main » matchait « sac » et se
  // faisait à tort classer comme un vrai produit imprimable.
  if (containsWord(idea, REAL_PHYSICAL_PRODUCT)) return { allowed: false, reason: 'not_requested' };
  // [2026-09-22, généralisé 2026-09-23] L'objet nommé dans l'idée EST le
  // produit vendu et Printify en fabrique un VRAI (chaussure, mug, tapis,
  // coussin…, tout le catalogue vérifié) → autorisé, et jamais substitué par
  // un t-shirt/hoodie de secours. Aucune liste de produits n'est figée : tout
  // type que Printify fabrique reste utilisable, ceci force juste CE type
  // précis quand il est explicitement nommé.
  // [2026-10-03] Synonyme le plus SPÉCIFIQUE (pas le premier de la table) :
  // « marque de vestes en jean » → « veste en jean » ('jacket'), pas « jean ».
  const catalogMatch = bestPodSynonym(idea, { exclude: IDEA_AMBIGUOUS_TERMS });
  if (catalogMatch) return { allowed: true, reason: 'real_product_match', match: catalogMatch.term };
  // [2026-10-03] Bug signalé « des fois ça n'utilise pas Printify » : l'idée
  // est souvent tapée avec des fautes (« cret une mark de pentalon ») et ne
  // nomme alors aucun produit reconnu ; la décision retombait sur le libellé
  // d'INDUSTRIE, que l'IA classe différemment d'une fois à l'autre
  // (« Fashion » → autorisé, « Retail »/« Other » → refusé). La description
  // du projet, réécrite proprement (« Marque de pantalons… »), est lue en
  // second recours, avec les mêmes verrous que l'idée.
  // Même ordre que pour l'idée : un objet réel non fabricable nommé par la
  // description (« Marque de bijoux… ») bloque, avant le match catalogue.
  if (description) {
    if (containsWord(description, REAL_PHYSICAL_PRODUCT)) return { allowed: false, reason: 'not_requested' };
    const descMatch = bestPodSynonym(description, { exclude: DESCRIPTION_AMBIGUOUS_TERMS });
    if (descMatch) return { allowed: true, reason: 'real_product_match', match: descMatch.term };
  }
  const native = firstMatch(haystack, POD_NATIVE) || (description ? firstMatch(description, POD_NATIVE) : null);
  if (native) return { allowed: true, reason: 'pod_native', match: native };
  return { allowed: false, reason: 'not_requested' };
}

export interface PodProductDecision {
  /** Faut-il créer ce produit sur Printify ? */
  create: boolean;
  /** Type Printify canonique retenu ('t-shirt', 'mug'…), sinon null. */
  podType: string | null;
  reason:
    | 'ok'
    | 'not_requested'          // l'utilisateur n'a pas demandé d'objet imprimé
    | 'product_not_printable'  // le produit lui-même n'existe pas chez Printify
    | 'wrong_type';            // l'objet vendu est connu (ex. chaussure) mais l'IA a proposé un AUTRE type (ex. t-shirt) : rejeté, jamais fabriqué en substitution
  /** Terme qui a déclenché la décision, pour l'expliquer. */
  match?: string;
}

/**
 * Quand l'activité vend elle-même un objet imprimable précis (ex. « chaussure »
 * → reason 'real_product_match'), un SEUL type de produit est acceptable :
 * celui-là. Renvoie ce type canonique ('shoe'…), ou null s'il n'y a pas de
 * contrainte de type (demande explicite de merch générique, ou activité
 * textile générique — plusieurs types de vêtements restent valides).
 *
 * [2026-09-23] Corrige le bug où l'IA de sélection produit (gpt-5.4-mini)
 * ignorait « RÈGLE ABSOLUE #1 » du prompt et proposait « Logo Tee »/« Core
 * Hoodie » pour une marque de CHAUSSURES : la règle n'était écrite QUE dans
 * le prompt (donc violable par le modèle), jamais vérifiée par du code. Ici,
 * on la fait respecter DE FORCE : un produit dont le type ne correspond pas
 * à l'objet réellement vendu est rejeté, jamais substitué.
 */
export function requiredPodType(decision: PodDecision): string | null {
  if (decision.reason !== 'real_product_match' || !decision.match) return null;
  return normalizePodProductType(decision.match);
}

/**
 * Décision FINALE pour UN produit donné, à appeler avant tout appel Printify.
 * Trois verrous indépendants :
 *   1. l'activité doit autoriser le print-on-demand (podMerchDecision) ;
 *   2. le produit doit correspondre à un vrai produit Printify existant ;
 *   3. si l'objet vendu est un objet précis (ex. chaussure), le produit DOIT
 *      être cet objet — jamais un t-shirt/hoodie de substitution, même si
 *      l'IA de sélection produit en a proposé un.
 * Si l'un des trois échoue, le produit n'est PAS fabriqué — il n'est jamais
 * remplacé par un t-shirt/pull « par défaut ».
 */
export function podProductDecision(input: {
  idea?: string;
  industry?: string;
  description?: string;
  productType?: string;
  productName?: string;
  category?: string;
}): PodProductDecision {
  const business = podMerchDecision({ idea: input.idea, industry: input.industry, description: input.description });
  if (!business.allowed) return { create: false, podType: null, reason: 'not_requested' };
  // Le type explicite prime ; sinon on tente de le lire dans le nom/catégorie.
  const podType =
    normalizePodProductType(input.productType || '') ||
    normalizePodProductType(`${input.productName || ''} ${input.category || ''}`);
  if (!podType) return { create: false, podType: null, reason: 'product_not_printable' };
  const required = requiredPodType(business);
  if (required && podType !== required) {
    return { create: false, podType, reason: 'wrong_type', match: required };
  }
  return { create: true, podType, reason: 'ok' };
}

/**
 * Message à AFFICHER À L'UTILISATEUR avant de toucher à Printify — demandé
 * explicitement : « dis-le moi avant de faire un truc ». Aucune impression ne
 * doit plus arriver en silence, ni aucun refus.
 *
 * `products` = les produits qui SERONT créés (déjà validés par
 * podProductDecision), `skipped` = ceux qui ne le seront pas et pourquoi.
 */
export function podAnnouncement(input: {
  decision: PodDecision;
  products?: Array<{ name: string; podType: string }>;
  skipped?: Array<{ name: string; reason: PodProductDecision['reason'] }>;
}): string {
  const { decision } = input;
  const products = input.products || [];
  const skipped = input.skipped || [];

  if (!decision.allowed) {
    return (
      `🖨️ Création : aucun produit imprimé ne sera créé. ` +
      `Tu n'as pas demandé d'objet imprimé (t-shirt, mug, poster, sticker, tote bag, coque, « merch »), ` +
      `et l'activité ne vend pas l'objet imprimé lui-même. ` +
      `Si tu en veux, dis-le-moi (ex. « ajoute des t-shirts et des casquettes ») et je les fabrique.`
    );
  }

  const why =
    decision.reason === 'explicit_request'
      ? `tu as demandé « ${decision.match} »`
      : `l'objet imprimé est le produit vendu${decision.match ? ` (« ${decision.match} »)` : ''}`;

  const lines: string[] = [];
  if (products.length) {
    lines.push(
      `🖨️ Création — je vais créer ${products.length} produit(s) imprimé(s) parce que ${why} : ` +
        products.map((p) => `« ${p.name} » (${p.podType})`).join(', ') + '.',
    );
  } else {
    lines.push(`🖨️ Rien à imprimer pour l'instant (${why}), aucun produit créé.`);
  }
  if (skipped.length) {
    lines.push(
      `Non imprimés (aucun remplacement, aucun t-shirt par défaut) : ` +
        skipped
          .map(
            (s) =>
              `« ${s.name} » — ${
                s.reason === 'product_not_printable'
                  ? "ce produit ne peut pas être fabriqué"
                  : 'objet imprimé non demandé'
              }`,
          )
          .join(' ; ') + '.',
    );
  }
  return lines.join(' ');
}

/**
 * Secteur/idée réellement « mode » — remplace les tests
 * `['clothing','fashion','mode','textile'].some(k => ind.includes(k))` qui
 * classaient « voiture électrique moderne » en mode (« mode » ⊂ « moderne »).
 */
/**
 * Types du catalogue qui SE PORTENT comme un vêtement (fiche 3 vues, photo
 * « portée » légitimes). Les autres objets du catalogue (mug, chaussure,
 * coussin…) sont des objets précis : jamais traités comme du textile.
 */
const GARMENT_POD_TYPES: ReadonlySet<string> = new Set([
  't-shirt', 'hoodie', 'pants', 'joggers', 'shorts', 'leggings', 'dress', 'skirt',
  'socks', 'jacket', 'polo', 'swimsuit',
]);

export function isGarmentPodType(type: string | null | undefined): boolean {
  return !!type && GARMENT_POD_TYPES.has(String(type));
}

export function isFashionBusiness(industry?: string, idea?: string): boolean {
  // [2026-10-03] Un vêtement du catalogue nommé dans l'idée (« marque de
  // pantalons », « marque de robes ») EST de la mode. Avant, tout terme du
  // catalogue passait par isRealPhysicalProduct() et renvoyait false, ce qui
  // aurait privé une marque de pantalons de sa fiche 3 vues textile.
  if (!containsWord(String(idea || ''), REAL_PHYSICAL_PRODUCT)) {
    const named = bestPodSynonym(String(idea || ''), { exclude: IDEA_AMBIGUOUS_TERMS });
    if (named && GARMENT_POD_TYPES.has(named.canonical)) return true;
  }
  // [2026-09-20] Une marque de chaussures/bijoux/sacs/meubles… reçoit souvent
  // le libellé d'industrie générique « Fashion »/« Mode » du classifieur, ce
  // qui la faisait passer pour du textile (fiche 3 vues + photo « portée par
  // un mannequin » + design imprimé) alors que l'objet réel vendu n'est ni un
  // vêtement ni imprimable. L'idée prime toujours sur le libellé d'industrie.
  if (isRealPhysicalProduct(idea)) return false;
  return containsWord(`${industry || ''} ${idea || ''}`, [
    'clothing', 'clothes', 'fashion', 'apparel', 'streetwear', 'sportswear', 'athleisure',
    'vetement', 'vêtement', 'vetements', 'vêtements', 'mode', 'pret a porter', 'prêt à porter',
    'textile', 'textiles', 'couture', 'lingerie', 't-shirt', 'tshirt', 'hoodie', 'sweatshirt',
  ]);
}
