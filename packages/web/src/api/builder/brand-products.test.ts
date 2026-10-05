import { describe, expect, test } from "bun:test";
import {
  assignProductRefs,
  brandProductsFromCatalogSource,
  fallbackProductIndex,
  fixInventedProductIds,
  makeFallbackProductRef,
  productRefPrompt,
  productsArtDirectorBlock,
  type BrandProduct,
} from "./brand-products";
import { generateImageManifest, type ImageSlot } from "./images";
import { generateMissingImages } from "./engine";
import { isPlaceholderImage } from "./images-manifest";

const SHOES: BrandProduct[] = [
  { id: "p1", name: "Stride One", description: "Basket blanche à semelle épaisse", imageUrl: "https://images-api.printify.com/mockup/a.jpg" },
  { id: "p2", name: "Pulse Runner", description: "Running noire et orange", imageUrl: "https://images-api.printify.com/mockup/b.jpg" },
];
const IDEA = "Crée-moi une marque de chaussures streetwear";

const slot = (key: string, prompt: string, extra: Partial<ImageSlot> = {}): ImageSlot => ({
  key, prompt, alt: key, role: "hero", aspect: "wide", page: "src/pages/Home.tsx", ...extra,
} as ImageSlot);

describe("assignProductRefs", () => {
  test("visuels qui montrent une chaussure → un produit réel, à tour de rôle", () => {
    const m = assignProductRefs(
      [
        slot("produit_hero", "A sneaker on a concrete pedestal, dramatic light"),
        slot("showroom_hero", "Une paire de baskets portée dans la rue"),
        slot("about_team", "Portrait of the founding team in a studio"),
      ],
      SHOES,
      IDEA,
    );
    expect(m.get("produit_hero")).toBe(0);
    expect(m.get("showroom_hero")).toBe(1);
    expect(m.has("about_team")).toBe(false);
  });

  test("le produit nommé dans le texte l'emporte", () => {
    const m = assignProductRefs([slot("hero", "Close-up of the Pulse Runner sole")], SHOES, IDEA);
    expect(m.get("hero")).toBe(1);
  });

  test("le choix du directeur artistique (slot.product) l'emporte", () => {
    const m = assignProductRefs([{ ...slot("hero", "Stride One on rocks"), product: 1 }], SHOES, IDEA);
    expect(m.get("hero")).toBe(1);
  });

  test("aucun produit avec photo → rien d'attribué", () => {
    const m = assignProductRefs([slot("hero", "A sneaker")], SHOES.map((p) => ({ ...p, imageUrl: null })), IDEA);
    expect(m.size).toBe(0);
  });
});

describe("fallbackProductIndex", () => {
  test("marque d'objet : chaque clé de secours est ancrée sur un produit", () => {
    expect(fallbackProductIndex("collection_banner", 0, SHOES, IDEA)).toBe(0);
    expect(fallbackProductIndex("lifestyle_2", 1, SHOES, IDEA)).toBe(1);
    expect(fallbackProductIndex("pulse_runner_detail", 0, SHOES, IDEA)).toBe(1);
  });
  test("service sans objet vendu → pas de produit", () => {
    const svc: BrandProduct[] = [{ id: "s", name: "Coaching", description: "Séance en visio", imageUrl: "https://x/y.jpg" }];
    expect(fallbackProductIndex("about_team", 0, svc, "Cabinet de coaching")).toBe(-1);
  });
});

describe("prompts", () => {
  test("productRefPrompt exige le produit exact et garde la scène", () => {
    const p = productRefPrompt("on a wet street at night", SHOES[0]);
    expect(p).toContain('"Stride One"');
    expect(p).toContain("EXACTLY this product");
    expect(p).toContain("on a wet street at night");
  });
  test("bloc directeur artistique liste les produits avec index", () => {
    const b = productsArtDirectorBlock(SHOES);
    expect(b).toContain('0. "Stride One"');
    expect(b).toContain('1. "Pulse Runner"');
    expect(b).toContain('"product"');
    expect(productsArtDirectorBlock([])).toBe("");
  });
});

describe("brandProductsFromCatalogSource", () => {
  test("relit le catalog.ts généré", () => {
    const catalog = SHOES.map((p) => ({ ...p, priceCents: 8900, currency: "eur", supplier: "printify", variants: [] }));
    const src = `export interface CatalogProduct { id: string; }
export const CATALOG: CatalogProduct[] = ${JSON.stringify(catalog, null, 2)};
export function findProduct(id: string): CatalogProduct | undefined {
  return CATALOG.find((p) => p.id === id);
}
`;
    const out = brandProductsFromCatalogSource(src);
    expect(out.map((p) => p.name)).toEqual(["Stride One", "Pulse Runner"]);
    expect(out[1].imageUrl).toBe(SHOES[1].imageUrl);
  });
  test("source absente / invalide → []", () => {
    expect(brandProductsFromCatalogSource(undefined)).toEqual([]);
    expect(brandProductsFromCatalogSource("export const X = 1;")).toEqual([]);
  });
});

describe("generateImageManifest avec produits réels", () => {
  test("passe la vraie photo en référence, mais ne la publie JAMAIS telle quelle", async () => {
    const calls: Array<{ prompt: string; refs?: string[] }> = [];
    const generate = (async (prompt: string, _a?: any, _w?: any, opts?: { refImages?: string[] }) => {
      calls.push({ prompt, refs: opts?.refImages });
      if (prompt.includes("FAIL") && opts?.refImages) return null; // échec avec réf → réessai sans
      if (prompt.includes("NEVER")) return null;
      return "data:image/webp;base64,AAA";
    }) as any;
    const slots = [slot("produit_hero", "sneaker on pedestal"), slot("showroom_hero", "sneaker FAIL"), slot("about_team", "team portrait"), slot("dead_slot", "sneaker NEVER")];
    const assigned = assignProductRefs(slots, SHOES, IDEA);
    const manifest = await generateImageManifest(slots, undefined, 1, {
      generate,
      productRefFor: async (s) => {
        const i = assigned.get(s.key);
        if (i === undefined) return null;
        const p = SHOES[i];
        return { name: p.name, description: p.description, refImage: `REF:${p.id}`, photoUrl: p.imageUrl };
      },
    });
    const hero = calls.find((c) => c.prompt.includes("pedestal"))!;
    expect(hero.refs).toEqual(["REF:p1"]);
    expect(hero.prompt).toContain('"Stride One"');
    expect(calls.find((c) => c.prompt.includes("team portrait"))!.refs).toBeUndefined();
    expect(manifest.urls.produit_hero).toBe("data:image/webp;base64,AAA");
    // Échec avec la référence → régénéré SANS référence, pas la photo réelle.
    expect(manifest.urls.showroom_hero).toBe("data:image/webp;base64,AAA");
    expect(calls.filter((c) => c.prompt.includes("sneaker FAIL")).map((c) => !!c.refs)).toEqual([true, false]);
    expect(manifest.meta.showroom_hero.product).toBeUndefined();
    // Échec total → ignoré (le filet de l'engine le régénère), jamais une photo existante.
    expect(manifest.urls.dead_slot).toBeUndefined();
    expect(Object.values(manifest.urls)).not.toContain(SHOES[1].imageUrl!);
    expect(manifest.meta.produit_hero.product).toBe("Stride One");
    expect(manifest.meta.about_team.product).toBeUndefined();
  });
});

describe("generateMissingImages avec produits réels", () => {
  test("visuels de secours ancrés sur la vraie photo, jamais la photo recopiée", async () => {
    const seen: Array<string[] | undefined> = [];
    const generate = (async (_p: string, _a?: any, _w?: any, opts?: { refImages?: string[] }) => {
      seen.push(opts?.refImages);
      return null; // tout échoue → dégradé marqué, PAS la photo réelle
    }) as any;
    const ref = makeFallbackProductRef(SHOES, IDEA, new Map(), async (url) => `REF:${url}`);
    expect(ref).toBeDefined();
    const out = await generateMissingImages(["collection_banner", "lifestyle_2"], { idea: IDEA }, undefined, 1, ref, generate);
    // avec référence, puis réessai sans référence, pour chaque clé
    expect(seen).toEqual([[`REF:${SHOES[0].imageUrl}`], undefined, [`REF:${SHOES[1].imageUrl}`], undefined]);
    expect(out.collection_banner).not.toBe(SHOES[0].imageUrl!);
    expect(isPlaceholderImage(out.collection_banner)).toBe(true);
    expect(isPlaceholderImage(out.lifestyle_2)).toBe(true);
  });
  test("échec avec la référence → réessai sans référence, image générée publiée", async () => {
    const generate = (async (_p: string, _a?: any, _w?: any, opts?: { refImages?: string[] }) =>
      opts?.refImages ? null : "data:image/webp;base64,GEN") as any;
    const ref = makeFallbackProductRef(SHOES, IDEA, new Map(), async (url) => `REF:${url}`);
    const out = await generateMissingImages(["collection_banner"], { idea: IDEA }, undefined, 1, ref, generate);
    expect(out.collection_banner).toBe("data:image/webp;base64,GEN");
  });
  test("sans photo produit → pas de résolveur", () => {
    expect(makeFallbackProductRef(SHOES.map((p) => ({ ...p, imageUrl: null })), IDEA)).toBeUndefined();
  });
});

describe("fixInventedProductIds", () => {
  const cat = [{ id: "fd857dee-410d", name: "Stride One" }, { id: "d51f065d-c31d", name: "Pulse Runner" }];
  test("remplace les slugs inventés par les vrais ids", () => {
    const src = `const amb = { "stride-one": IMAGES.a, 'pulse_runner': IMAGES.b };
const tags = { Street: ["pulse-runner"] };
<Link to={\`/product/\${CATALOG[0]?.id ?? "stride-one"}\`} /> <a href="/product/stride-one">x</a>`;
    const r = fixInventedProductIds(src, cat);
    expect(r.code).toContain(`"fd857dee-410d": IMAGES.a`);
    expect(r.code).toContain(`'d51f065d-c31d': IMAGES.b`);
    expect(r.code).toContain(`["d51f065d-c31d"]`);
    expect(r.code).toContain(`href="/product/fd857dee-410d"`);
    expect(r.code).not.toContain("stride-one");
    expect(r.replaced).toBe(5);
  });
  test("ne touche pas au texte ni aux classes", () => {
    const src = `<h3 className="stride-one-title">Stride One</h3>`;
    expect(fixInventedProductIds(src, cat)).toEqual({ code: src, replaced: 0 });
  });
});
