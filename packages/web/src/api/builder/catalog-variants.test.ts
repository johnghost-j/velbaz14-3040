import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { catalogFileContent } from "./catalog-file";

const mk = (labels: string[]) => ({
  id: "p1", name: "Shoe", description: null, priceCents: 2500, currency: "eur", imageUrl: null, supplier: "cj",
  variants: labels.map((label, i) => ({ vid: String(i), label, priceCents: 2500 })),
});

test("variantOptions : tailles et couleurs classées par contenu, quel que soit l'ordre", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const f = join(dir, "catalog.ts");
  writeFileSync(f, catalogFileContent([mk(["Black / EU 38", "White / EU 38", "Black / EU 39"]) as any]));
  const mod = await import(f);
  const a = mod.variantOptions(mod.CATALOG[0]);
  expect(a.colors).toEqual(["Black", "White"]);
  expect(a.sizes).toEqual(["EU 38", "EU 39"]);
  expect(a.find("White", "EU 38")?.vid).toBe("1");
  expect(a.find("White", "EU 39")).toBeNull();
  expect(a.find(null, "EU 38")).toBeNull();

  const b = mod.variantOptions({ ...mod.CATALOG[0], variants: [{ vid: "x", label: "M / Rouge", priceCents: 1 }, { vid: "y", label: "XL / Bleu nuit", priceCents: 1 }] });
  expect(b.sizes).toEqual(["M", "XL"]);
  expect(b.colors).toEqual(["Rouge", "Bleu nuit"]);
  const c = mod.variantOptions({ ...mod.CATALOG[0], variants: [{ vid: "s", label: "S", priceCents: 1 }, { vid: "l", label: "L", priceCents: 1 }] });
  expect(c.colors).toEqual([]);
  expect(c.find(null, "L")?.vid).toBe("l");
});

test("catalogue : la galerie `images` de chaque produit est exposée au site", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const f = join(dir, "catalog.ts");
  const p = { ...mk(["M"]), imageUrl: "https://cdn/a.png", images: ["https://cdn/a.png", "https://cdn/b.png"] };
  const src = catalogFileContent([p as any]);
  expect(src).toContain("images: string[];");
  writeFileSync(f, src);
  const mod = await import(f);
  expect(mod.CATALOG[0].images).toEqual(["https://cdn/a.png", "https://cdn/b.png"]);
  expect(mod.CATALOG[0].images[0]).toBe(mod.CATALOG[0].imageUrl);
});
