// ─── Demande de création, même mal orthographiée ────────────────────────────
//
// [2026-10-04] MESURÉ : « cret moi une mark de chaussure » (crée-moi une marque
// de chaussures) partait en QUESTION, et l'orchestrateur INVENTAIT une marque
// en texte (« Voici PASO… ») au lieu de créer l'entreprise. Deux causes :
//   1. les regex déterministes de l'orchestrateur exigent l'orthographe exacte
//      de l'objet (« marque », « boutique »…) : « mark » ne matchait pas, et un
//      produit (« chaussure ») n'était pas un objet constructible ;
//   2. le classifieur IA tourne en mode Velbaz sur gpt-6-luna, un modèle qui
//      raisonne TOUJOURS (1,8 à 16 s mesurés pour répondre un seul mot, effort
//      de raisonnement ignoré) : son plafond de 3,5 s sautait, et l'heuristique
//      de repli (qui ne connaît que l'orthographe exacte) disait QUESTION.
// Ce module reconnaît la demande sans appel réseau, en tolérant les fautes
// courantes (une lettre en trop, en moins, inversée ou remplacée).

const CREATE_VERB_RES: RegExp[] = [
  /^cr+e{1,3}[rzst]?$/, // cre, cree, creer, cret, crer, creez, crees, creee
  /^crea(t|te|tion|r)?$/,
  /^creation$/,
  /^f(ai[rst]?|aire|aites|e)$/, // fais, fait, fai, fair, faire, faites, fé
  /^cons?tr?ui[a-z]*$/, // construis, construire, constuire
  /^mont(e|er|es|ez)$/,
  /^lanc(e|er|es|ez)$/,
  /^gener(e|er|es|ez)?$/, // genere, generer
  /^d[e]?v[e]?l[o]?p+[a-z]*$/, // developpe, developper, devlope
  /^imagin(e|er|es|ez)$/,
  /^invent(e|er|es|ez)$/,
  /^ouvr(e|ir|es|ez)$/,
  /^fond(e|er|es|ez)$/,
  /^(veux|veut|voudrais?|voudrai|aimerais?|aimerai|souhaite|souhaiterais?)$/,
  /^(build|create|creat|make|start|launch|design|want|need)$/,
];

// Objets « entreprise » : la chose que Velbaz construit.
const COMPANY_OBJECTS = [
  'marque', 'marques', 'entreprise', 'entreprises', 'societe', 'boutique', 'boutiques',
  'business', 'startup', 'application', 'plateforme', 'platform', 'website', 'siteweb',
  'company', 'agence', 'restaurant', 'projet', 'logiciel', 'software', 'landing',
  'dashboard', 'portfolio', 'magasin', 'enseigne', 'collection', 'ecommerce', 'boite',
];
// Mots courts : pas de tolérance (une lettre de différence change de mot).
const COMPANY_OBJECTS_EXACT = new Set([
  'app', 'apps', 'site', 'sites', 'shop', 'store', 'saas', 'blog', 'brand', 'brands',
  'label', 'griffe', 'mark', 'marks', 'marq', 'marc', 'mrk', 'mrq',
]);
// Produits : avec un verbe de création, « crée-moi des chaussures » est une
// marque à construire (hors projet, rien d'autre n'aurait de sens ici).
const PRODUCT_OBJECTS = [
  'chaussure', 'chaussures', 'basket', 'baskets', 'sneaker', 'sneakers', 'vetement',
  'vetements', 'habit', 'habits', 'tshirt', 'tshirts', 'shirt', 'shirts', 'sweat',
  'sweats', 'hoodie', 'hoodies', 'casquette', 'casquettes', 'bijou', 'bijoux', 'parfum', 'parfums', 'cosmetique', 'cosmetiques', 'chaussette', 'chaussettes',
  'maillot', 'maillots', 'streetwear', 'lunette', 'lunettes', 'shoes', 'clothing',
  'clothes', 'jewelry', 'fashion', 'jeans',
];

const NEGATIONS = new Set(['pas', 'jamais', 'not', 'dont', 'never', 'aucune', 'aucun']);
const LEADING_QUESTION = new Set([
  'comment', 'pourquoi', 'combien', 'quand', 'quel', 'quelle', 'quels', 'quelles',
  'quoi', 'how', 'why', 'what', 'which', 'when', 'where', 'should',
]);
// Mots qui trahissent une demande d'INFO, où qu'ils soient : le classifieur IA
// tranche (« je veux savoir combien coûte une marque »).
const INFO_WORDS = new Set([
  ...LEADING_QUESTION, 'savoir', 'explique', 'expliquer', 'expliques', 'conseil',
  'conseille', 'conseils', 'difference', 'definition',
]);
// Article indéfini seulement : « ma marque de… » parle d'une marque EXISTANTE.
const DETERMINERS = new Set(['un', 'une', 'a', 'an']);
const LINKERS = new Set(['de', 'd', 'des', 'du', 'pour', 'of', 'for']);

/** Distance d'édition (Damerau restreinte) plafonnée : true si ≤ 1. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const n = a.length;
  const m = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[m] <= 1;
}

function fuzzyIn(token: string, list: readonly string[]): boolean {
  if (token.length < 4) return list.includes(token);
  return list.some(w => w.length >= 5 ? withinOneEdit(token, w) : token === w);
}

export function normalizeTokens(message: string): string[] {
  return (message || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/t[- ]?shirts?/g, m => m.replace(/[- ]/g, ''))
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const isVerb = (t: string) => CREATE_VERB_RES.some(re => re.test(t));
const isCompanyObject = (t: string) => COMPANY_OBJECTS_EXACT.has(t) || fuzzyIn(t, COMPANY_OBJECTS);
const isProductObject = (t: string) => fuzzyIn(t, PRODUCT_OBJECTS);

/**
 * Vrai quand le message DEMANDE de créer une entreprise/marque/app/site, même
 * avec des fautes : « cret moi une mark de chaussure », « crée moi une marque
 * de basket », « fais moi une boutique de bijoux », « une mark de sneakers ».
 * Faux pour une question (« ? » final ou mot interrogatif en tête), une
 * négation, ou un message sans objet à construire.
 */
export function isCreationRequest(message: string): boolean {
  const raw = (message || '').trim();
  if (!raw || raw.length > 400) return false;
  if (/[?？]\s*$/.test(raw)) return false;
  const tokens = normalizeTokens(raw);
  if (tokens.length === 0) return false;
  if (tokens.some(t => INFO_WORDS.has(t))) return false;

  for (let i = 0; i < tokens.length; i++) {
    // Verbe de création suivi (≤ 6 mots) d'une entreprise ou d'un produit.
    if (isVerb(tokens[i])) {
      for (let j = i + 1; j < Math.min(tokens.length, i + 7); j++) {
        if (NEGATIONS.has(tokens[j])) break;
        if (isCompanyObject(tokens[j]) || isProductObject(tokens[j])) {
          if (tokens.slice(0, i).some(t => NEGATIONS.has(t))) return false;
          return true;
        }
      }
    }
    // Sans verbe, en tête de message : « une mark de chaussures », « moi une
    // boutique de bijoux ». Plus loin (« j'ai une marque de… »), c'est souvent
    // une marque qui existe déjà : le classifieur IA tranche.
    if (i <= 1 && DETERMINERS.has(tokens[i])) {
      const obj = tokens[i + 1];
      const link = tokens[i + 2];
      if (obj && link && isCompanyObject(obj) && LINKERS.has(link) && tokens[i + 3]) {
        if (tokens.some(t => NEGATIONS.has(t))) return false;
        return true;
      }
    }
  }
  return false;
}
