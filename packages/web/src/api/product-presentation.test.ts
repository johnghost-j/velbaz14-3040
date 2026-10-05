// Présentation pro des produits : vues réelles → galerie + photos rendues.
// Base SQLite en mémoire (schéma drizzle réel), aucune donnée de prod touchée.

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { productImages, products } from "./database/schema";

const client = createClient({ url: ":memory:" });
const memDb = drizzle(client);
mock.module("./database/index", () => ({ db: memDb }));

const pp = await import("./product-presentation");
const { pickShopGallery, pickShopPhoto } = await import("./product-photo");

async function createTable(t: SQLiteTable) {
  const cfg = getTableConfig(t);
  const cols = cfg.columns.map((c) => `"${c.name}" ${c.getSQLType()}`).join(", ");
  await client.execute(`CREATE TABLE "${cfg.name}" (${cols})`);
}

const CO = "co-1";
const PF = (n: number, label: string, vid = 11, def = false) => ({
  src: `https://images-api.printify.com/mockup/x/${vid}/${n}/s.jpg?camera_label=${label}`,
  variant_ids: [vid, vid + 1], position: label, is_default: def,
});
const IMG = { data: "aGVsbG8=", mimeType: "image/png" };

function fakeDeps(o: { images?: any[]; tokens?: number; fail?: string[] } = {}) {
  const calls = { generate: [] as { prompt: string; refs: number; aspectRatio: string }[], download: [] as string[], charge: 0 };
  let tokens = o.tokens ?? 99;
  const deps = {
    printifyImages: async () => o.images ?? [],
    download: async (src: string) => { calls.download.push(src); return IMG; },
    generate: async (prompt: string, refs: any[], opts: { aspectRatio: string }) => {
      calls.generate.push({ prompt, refs: refs.length, aspectRatio: opts.aspectRatio });
      return (o.fail || []).some((k) => prompt.toLowerCase().includes(k)) ? null : { ...IMG, data: `${IMG.data}${calls.generate.length}` };
    },
    charge: async () => { calls.charge++; return { ok: tokens-- > 0 }; },
  };
  return { deps, calls };
}

async function rows(productId: string) {
  return (await memDb.select().from(productImages)).filter((r) => r.productId === productId);
}

beforeAll(async () => {
  await createTable(products);
  await createTable(productImages);
});

beforeEach(async () => {
  await client.execute(`DELETE FROM product_images`);
  await client.execute(`DELETE FROM products`);
  await memDb.insert(products).values([
    { id: "p1", companyId: CO, name: "Volt Runner", description: "Sneaker all-over", retailPrice: 60, status: "active", printifyProductId: "pf-1", tags: "[]" },
    { id: "p2", companyId: CO, name: "Concept", retailPrice: 20, status: "active", tags: "[]" },
  ] as any);
});

describe("pickPrintifyViews", () => {
  test("coloris par défaut, une vue par angle, défaut en tête", () => {
    const imgs = [PF(1, "front"), PF(2, "left", 11, true), PF(3, "front", 11), PF(4, "back", 30), PF(5, "right")];
    const v = pp.pickPrintifyViews(imgs);
    expect(v[0]).toContain("/2/");
    expect(v.length).toBe(3); // left, front, right (back = autre coloris)
    expect(v.some((s) => s.includes("/30/"))).toBe(false);
  });
  test("ignore ce qui n'est pas une URL http", () => {
    expect(pp.pickPrintifyViews([{ src: "data:image/png;base64,AA" }, null, {}])).toEqual([]);
    expect(pp.pickPrintifyViews(null as any)).toEqual([]);
  });
});

describe("prompts et clés", () => {
  test("le prompt exige le MÊME produit, sans logo ajouté ni texte", () => {
    for (const shot of ["hero", "lifestyle"] as const) {
      const p = pp.presentationPrompt(shot, { name: "Volt Runner", description: "x" });
      expect(p).toContain("Reproduce EXACTLY this product");
      expect(p).toContain("do NOT add or remove any logo");
      expect(p).toContain("No text overlay");
    }
    expect(pp.presentationPrompt("lifestyle", { name: "A" })).toContain("lifestyle");
  });
  test("isCurrentPresentation dépend de la source ET du plan", () => {
    const src = pp.presentationSourceKey({ id: "p1", printifyProductId: "pf-1" });
    expect(src).toBe("printify:pf-1");
    expect(pp.isCurrentPresentation(`[presentation ${src} hero] …`, src, "hero")).toBe(true);
    expect(pp.isCurrentPresentation(`[presentation ${src} hero] …`, src, "lifestyle")).toBe(false);
    expect(pp.isCurrentPresentation(`[presentation printify:old hero] …`, src, "hero")).toBe(false);
    expect(pp.presentationSourceKey({ id: "p9", printifyProductId: null })).toBe("local:p9");
  });
});

describe("presentProduct", () => {
  const P1 = { id: "p1", name: "Volt Runner", description: "Sneaker all-over", printifyProductId: "pf-1" };

  test("enregistre les vues Printify, rend les 2 plans avec les vues en référence", async () => {
    const { deps, calls } = fakeDeps({ images: [PF(1, "left", 11, true), PF(2, "right"), PF(3, "front")] });
    const r = await pp.presentProduct(deps, CO, P1);
    expect(r).toEqual({ productId: "p1", generated: 2, views: 3 });
    expect(calls.generate.map((g) => g.aspectRatio).sort()).toEqual(["1:1", "4:5"]);
    expect(calls.generate.every((g) => g.refs === 3)).toBe(true);
    const all = await rows("p1");
    expect(all.filter((i) => i.type === "printify").length).toBe(3);
    expect(all.filter((i) => i.type === "presentation").length).toBe(2);
    // Vitrine : la photo pro passe devant le mockup brut ; la galerie garde les vues.
    expect(pickShopPhoto(all as any)!.type).toBe("presentation");
    const g = pickShopGallery(all as any);
    expect(g.map((i) => i.type)).toEqual(["presentation", "presentation", "printify", "printify", "printify"]);
  });

  test("idempotent : un 2e passage ne régénère rien et ne duplique aucune vue", async () => {
    const images = [PF(1, "left", 11, true), PF(2, "right")];
    await pp.presentProduct(fakeDeps({ images }).deps, CO, P1);
    const { deps, calls } = fakeDeps({ images });
    const r = await pp.presentProduct(deps, CO, P1);
    expect(r.skipped).toBe("up_to_date");
    expect(calls.generate.length).toBe(0);
    expect((await rows("p1")).length).toBe(4);
  });

  test("produit reconstruit (nouveau Printify) : anciennes photos et vues remplacées", async () => {
    await pp.presentProduct(fakeDeps({ images: [PF(1, "left", 11, true)] }).deps, CO, P1);
    const P1b = { ...P1, printifyProductId: "pf-2" };
    const { deps } = fakeDeps({ images: [PF(7, "left", 50, true)] });
    const r = await pp.presentProduct(deps, CO, P1b);
    expect(r.generated).toBe(2);
    const all = await rows("p1");
    expect(all.filter((i) => i.type === "printify").map((i) => i.imageData)).toEqual([PF(7, "left", 50).src]);
    expect(all.filter((i) => i.type === "presentation").every((i) => i.prompt!.startsWith("[presentation printify:pf-2"))).toBe(true);
  });

  test("vues stockées (mockup) utilisées quand il n'y a pas de Printify ; documents de prod exclus", async () => {
    await memDb.insert(productImages).values([
      { id: "i1", productId: "p2", companyId: CO, type: "mockup", imageData: "data:image/png;base64,AAA", status: "active", sortOrder: 0 },
      { id: "i2", productId: "p2", companyId: CO, type: "print_design", imageData: "data:image/png;base64,BBB", status: "active", sortOrder: 0 },
    ] as any);
    const { deps, calls } = fakeDeps();
    const r = await pp.presentProduct(deps, CO, { id: "p2", name: "Concept", description: null, printifyProductId: null });
    expect(r.generated).toBe(2);
    expect(calls.download).toEqual(["data:image/png;base64,AAA"]);
  });

  test("aucune vue : rien n'est généré", async () => {
    const { deps, calls } = fakeDeps();
    const r = await pp.presentProduct(deps, CO, { id: "p2", name: "Concept", description: null, printifyProductId: null });
    expect(r.skipped).toBe("no_views");
    expect(calls.generate.length).toBe(0);
  });

  test("solde insuffisant : arrêt avant génération, dit dans le résultat", async () => {
    const { deps, calls } = fakeDeps({ images: [PF(1, "left", 11, true)], tokens: 1 });
    const r = await pp.presentProduct(deps, CO, P1);
    expect(r.generated).toBe(1);
    expect(r.skipped).toBe("no_tokens");
    expect(calls.generate.length).toBe(1);
  });

  test("échec d'un rendu : compté, l'autre est gardé, et il sera retenté au prochain passage", async () => {
    const images = [PF(1, "left", 11, true)];
    const r = await pp.presentProduct(fakeDeps({ images, fail: ["lifestyle"] }).deps, CO, P1);
    expect(r).toMatchObject({ generated: 1, failed: 1 });
    const again = fakeDeps({ images });
    const r2 = await pp.presentProduct(again.deps, CO, P1);
    expect(r2.generated).toBe(1);
    expect(again.calls.generate[0].aspectRatio).toBe("4:5");
  });
});

describe("presentCompanyProducts / résumé", () => {
  test("ne traite que les produits vendables (Printify ou dropshipping, prix > 0)", async () => {
    const { deps, calls } = fakeDeps({ images: [PF(1, "left", 11, true)] });
    const res = await pp.presentCompanyProducts(deps, CO);
    expect(res.map((r) => r.productId)).toEqual(["p1"]);
    expect(calls.generate.length).toBe(2);
    expect(pp.presentationSummary(res)).toContain("2 photo(s) de présentation");
  });
  test("résumé null quand rien n'a été fait", () => {
    expect(pp.presentationSummary([{ productId: "x", generated: 0, views: 2, skipped: "up_to_date" }])).toBeNull();
  });
});
