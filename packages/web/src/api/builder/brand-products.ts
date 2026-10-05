// ─── Produits RÉELS de la marque → visuels du site ───────────────────────────
// [2026-10-01] Bug signalé : « crée-moi une marque de chaussures » → la marque
// et ses produits sont créés (vrais mockups Printify), mais le site affiche des
// chaussures GÉNÉRIQUES, pas celles de la marque. Deux causes, mesurées sur un
// projet réel (SoulStride) :
//   1. le flux de genèse n'injectait JAMAIS le catalogue (`products`) dans le
//      moteur : pas de `src/lib/catalog.ts`, pas de consigne boutique ;
//   2. le directeur artistique (`planImageSlots`) ne connaissait pas les
//      produits et chaque visuel était généré à partir d'un texte seul :
//      « a sneaker on a pedestal » → une basket inventée par le modèle.
// Ce module décide, de façon déterministe, quels visuels montrent un produit de
// la marque et lequel ; le visuel est alors généré AVEC la vraie photo du
// produit en image de référence (et retombe sur cette photo si la génération
// échoue) — plus jamais un produit inventé.
import type { ImageSlot } from "./images";

export interface BrandProduct {
  id: string;
  name: string;
  description?: string | null;
  /** Photo du produit réellement vendu (mockup Printify, photo CDN…). */
  imageUrl: string | null;
}

/** Ce que le moteur reçoit de l'appelant : le catalogue réel de la marque. */
export interface BrandCatalogBundle {
  products: BrandProduct[];
  /** Consigne boutique pour le prompt des pages (ctx.products). */
  prompt: string;
  /** Fichiers à injecter dans le site (src/lib/catalog.ts, src/lib/legal.ts). */
  files: Array<{ path: string; content: string }>;
}

// Familles d'objets physiques. Une famille est « active » quand l'idée ou les
// produits la nomment ; un visuel qui en parle montre alors le produit.
const OBJECT_GROUPS: string[][] = [
  ["shoe", "sneaker", "footwear", "trainer", "boot", "sandal", "slipper", "loafer", "chaussure", "basket",
    "botte", "bottine", "sandale", "mocassin", "espadrille", "semelle", "sole", "outsole", "midsole", "lacet", "lace", "paire", "pair"],
  ["t-shirt", "tshirt", "tee", "hoodie", "sweatshirt", "sweat", "shirt", "garment", "apparel", "clothing",
    "vetement", "textile", "jacket", "veste", "pull", "sweater"],
  ["cap", "casquette", "hat", "chapeau", "beanie", "bonnet"],
  ["mug", "cup", "tasse"],
  ["bag", "tote", "sac", "backpack", "sacoche"],
  ["poster", "affiche", "canvas", "toile"],
  ["phone case", "coque"],
  ["jewelry", "jewellery", "bijou", "ring", "bague", "necklace", "collier", "bracelet", "earring", "pendant"],
  ["watch", "montre"],
  ["bottle", "bouteille", "gourde", "flask"],
  ["candle", "bougie"],
  ["sticker", "autocollant"],
  ["sunglasses", "lunettes", "glasses"],
];

// Mots qui désignent un produit quel que soit le secteur.
const GENERIC_PRODUCT_TERMS = [
  "product", "produit", "packshot", "article", "colorway", "coloris", "collection", "catalog", "catalogue",
  "best seller", "bestseller", "nouveaute", "new arrival", "drop",
];

export function normalizeText(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTerm(text: string, term: string): boolean {
  const t = normalizeText(term);
  if (!t) return false;
  // Mot entier, pluriel en -s / -x toléré (« sneakers », « bijoux »).
  const re = new RegExp(`(?:^| )${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|x|es)?(?: |$)`);
  return re.test(text);
}

/**
 * Termes qui, présents dans la description d'un visuel, signifient « ce visuel
 * montre un produit de la marque ».
 */
export function productTerms(products: BrandProduct[], idea = ""): string[] {
  const corpus = normalizeText(
    [idea, ...products.map((p) => `${p.name} ${p.description || ""}`)].join(" "),
  );
  const terms = new Set<string>(GENERIC_PRODUCT_TERMS);
  for (const group of OBJECT_GROUPS) {
    if (group.some((t) => hasTerm(corpus, t))) group.forEach((t) => terms.add(t));
  }
  for (const p of products) {
    const n = normalizeText(p.name);
    if (n.length >= 3) terms.add(n);
  }
  return [...terms];
}

/** Vrai quand le texte (clé, rôle, prompt, alt) décrit un produit. */
export function textShowsProduct(text: string, terms: string[]): boolean {
  const t = normalizeText(text);
  return terms.some((term) => hasTerm(t, term));
}

/** Index du produit nommé explicitement dans le texte (nom complet), sinon -1. */
function namedProductIndex(text: string, products: BrandProduct[]): number {
  const t = normalizeText(text);
  return products.findIndex((p) => {
    const n = normalizeText(p.name);
    return n.length >= 3 && hasTerm(t, n);
  });
}

/**
 * Décide quels visuels montrent quel produit RÉEL. Renvoie clé → index dans
 * `products`. Seuls les produits AVEC photo sont attribuables (sans photo il
 * n'y a rien à reproduire fidèlement).
 *
 * Priorité : (1) le produit désigné par le directeur artistique (`slot.product`),
 * (2) un produit nommé dans le texte du visuel, (3) tout visuel qui parle d'un
 * produit / de l'objet vendu reçoit un produit à tour de rôle.
 */
export function assignProductRefs(
  slots: Array<Pick<ImageSlot, "key" | "prompt" | "alt" | "role"> & { product?: number }>,
  products: BrandProduct[],
  idea = "",
): Map<string, number> {
  const out = new Map<string, number>();
  const withPhoto = products.map((p, i) => ({ p, i })).filter((x) => !!x.p.imageUrl);
  if (!withPhoto.length) return out;
  const photoIdx = new Set(withPhoto.map((x) => x.i));
  const terms = productTerms(products, idea);
  let rr = 0;
  for (const s of slots) {
    const text = `${s.key} ${s.role || ""} ${s.prompt || ""} ${s.alt || ""}`;
    if (typeof s.product === "number" && photoIdx.has(s.product)) {
      out.set(s.key, s.product);
      continue;
    }
    const named = namedProductIndex(text, products);
    if (named >= 0 && photoIdx.has(named)) {
      out.set(s.key, named);
      continue;
    }
    if (textShowsProduct(text, terms)) {
      out.set(s.key, withPhoto[rr % withPhoto.length].i);
      rr++;
    }
  }
  return out;
}

/**
 * Visuel de SECOURS (clé réclamée par une page sans visuel prévu) : on n'a que
 * la clé, et le prompt de secours est construit à partir de l'idée — donc pour
 * une marque d'objet physique il montrera l'objet. Dès qu'une photo produit
 * existe et que l'activité vend un objet, chaque visuel de secours est ancré
 * sur un produit réel (celui nommé dans la clé, sinon à tour de rôle).
 */
export function fallbackProductIndex(
  key: string,
  i: number,
  products: BrandProduct[],
  idea = "",
): number {
  const withPhoto = products.map((p, idx) => ({ p, idx })).filter((x) => !!x.p.imageUrl);
  if (!withPhoto.length) return -1;
  const named = namedProductIndex(key, products);
  if (named >= 0 && products[named]?.imageUrl) return named;
  const corpus = normalizeText([idea, ...products.map((p) => `${p.name} ${p.description || ""}`)].join(" "));
  const sellsObject = OBJECT_GROUPS.some((g) => g.some((t) => hasTerm(corpus, t)));
  const keyIsProduct = textShowsProduct(key, productTerms(products, idea));
  if (!sellsObject && !keyIsProduct) return -1;
  return withPhoto[i % withPhoto.length].idx;
}

/**
 * Prompt d'un visuel qui montre un produit réel : la photo de référence est le
 * produit, la description n'est que la mise en scène.
 */
export function productRefPrompt(scene: string, product: BrandProduct): string {
  const desc = (product.description || "").replace(/\s+/g, " ").slice(0, 220);
  return (
    `The attached reference photo shows the brand's REAL product "${product.name}"${desc ? ` (${desc})` : ""}. ` +
    `Every product visible in the new image MUST be EXACTLY this product: identical silhouette, shape, proportions, ` +
    `colours, materials, print/pattern and details as in the reference. Do NOT redesign it, do NOT replace it with ` +
    `another model or a generic product, do NOT add any other brand's logo. ` +
    `Create this scene with that exact product: ${scene}`
  );
}

/** Ligne ajoutée au catalogue de pages pour qu'il sache quoi montrer. */
export function productsArtDirectorBlock(products: BrandProduct[]): string {
  if (!products.length) return "";
  const lines = products
    .slice(0, 12)
    .map((p, i) => `${i}. "${p.name}"${p.description ? ` — ${p.description.replace(/\s+/g, " ").slice(0, 160)}` : ""}${p.imageUrl ? " (photo réelle disponible)" : " (pas de photo)"}`)
    .join("\n");
  return `
PRODUITS RÉELS DE LA MARQUE (déjà fabriqués, avec leur vraie photo) :
${lines}
RÈGLES PRODUITS — OBLIGATOIRES :
- Tout visuel où un produit de la marque apparaît DOIT porter "product": <numéro du produit ci-dessus>. Il sera généré À PARTIR DE LA VRAIE PHOTO du produit : décris la MISE EN SCÈNE (angle, décor, lumière, porté, détail en gros plan…), PAS le design du produit.
- N'invente JAMAIS un autre modèle, une autre couleur ou un produit générique : le site doit montrer CES produits-là.
- Les vignettes de catalogue / fiches produit / récapitulatif panier n'ont PAS besoin de visuel généré : la page affiche directement la photo réelle (CATALOG[i].imageUrl). Ne crée pas de visuel pour elles.
`;
}

// ── Image de référence ──────────────────────────────────────────────────────
// La photo produit (mockup Printify en https, ou data URI) est téléchargée une
// fois et réduite (≤ 1024 px, JPEG) avant d'être passée au modèle d'image :
// plus léger, et indépendant de la capacité du fournisseur à lire une URL.
const refCache = new Map<string, Promise<string>>();

export function loadProductRefImage(
  url: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const hit = refCache.get(url);
  if (hit) return hit;
  const p = (async () => {
    try {
      let buf: Buffer;
      if (url.startsWith("data:image")) {
        buf = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      } else if (/^https?:\/\//.test(url)) {
        const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 15000) });
        if (!res.ok) return url;
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        return url;
      }
      const { getSharp } = await import("../lib/optional-import");
      const sharp = await getSharp();
      const out = await sharp(buf)
        .flatten({ background: "#ffffff" })
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();
      return `data:image/jpeg;base64,${out.toString("base64")}`;
    } catch {
      return url; // le modèle sait aussi lire une URL publique
    }
  })();
  refCache.set(url, p);
  return p;
}

/**
 * Relit les produits depuis le `src/lib/catalog.ts` d'un projet déjà généré
 * (édition : le moteur n'a que les fichiers, pas l'id d'entreprise).
 */
export function brandProductsFromCatalogSource(src: string | undefined | null): BrandProduct[] {
  if (!src) return [];
  const m = src.match(/export const CATALOG\s*:\s*[^=]*=\s*(\[[\s\S]*?\]);\s*\n\s*export function/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p: any) => p && typeof p.name === "string")
      .map((p: any) => ({
        id: String(p.id || ""),
        name: String(p.name),
        description: p.description ? String(p.description) : null,
        imageUrl: typeof p.imageUrl === "string" && p.imageUrl ? p.imageUrl : null,
      }));
  } catch {
    return [];
  }
}

/** Fabrique le résolveur clé → produit réel utilisé par les visuels de secours. */
export function makeFallbackProductRef(
  products: BrandProduct[],
  idea: string,
  assigned: Map<string, number> = new Map(),
  loadRef: (url: string) => Promise<string> = loadProductRefImage,
): ((key: string, i: number) => Promise<{ name: string; description?: string | null; refImage: string; photoUrl: string | null } | null>) | undefined {
  if (!products.some((p) => !!p.imageUrl)) return undefined;
  return async (key, i) => {
    const idx = assigned.get(key) ?? fallbackProductIndex(key, i, products, idea);
    const p = idx >= 0 ? products[idx] : undefined;
    if (!p?.imageUrl) return null;
    return { name: p.name, description: p.description, refImage: await loadRef(p.imageUrl), photoUrl: p.imageUrl };
  };
}

// ── Faux ids de produit ─────────────────────────────────────────────────────
// Mesuré sur un vrai build (SoulStride) : l'IA indexait ses visuels par un id
// INVENTÉ (`{ "stride-one": IMAGES.x }`) alors que CATALOG porte des UUID →
// recherche vide, carte produit sans image. On remplace, de façon
// déterministe, chaque littéral « slug du nom » par le VRAI id du produit.
function slugVariants(name: string): string[] {
  const words = normalizeText(name).split(" ").filter(Boolean);
  if (!words.length) return [];
  return [...new Set([words.join("-"), words.join("_"), words.join("")])].filter((s) => s.length >= 3);
}

export function fixInventedProductIds(
  code: string,
  products: Array<Pick<BrandProduct, "id" | "name">>,
): { code: string; replaced: number } {
  let out = code;
  let replaced = 0;
  for (const p of products) {
    if (!p.id) continue;
    for (const slug of slugVariants(p.name)) {
      if (slug === p.id) continue;
      const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Littéral exact : "stride-one" / 'stride-one' / `stride-one`.
      const lit = new RegExp(`(["'\`])${esc}\\1`, "gi");
      out = out.replace(lit, (_m, q: string) => { replaced++; return `${q}${p.id}${q}`; });
      // Lien en dur vers la fiche : /product/stride-one, /produit/stride-one…
      const link = new RegExp(`(/(?:products?|produits?|shop|boutique|item)/)${esc}(?![\\w-])`, "gi");
      out = out.replace(link, (_m, pre: string) => { replaced++; return `${pre}${p.id}`; });
    }
  }
  return { code: out, replaced };
}
