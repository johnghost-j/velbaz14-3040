import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectConflicts } from "./catalog-sync";

describe("branchement du catalogue — concurrence avec le QA / l'édition", () => {
  const before = [
    { path: "src/pages/Shop.tsx", content: "v1" },
    { path: "src/App.tsx", content: "app" },
  ];

  test("aucun conflit quand la base n'a pas bougé", () => {
    const now = new Map([["src/pages/Shop.tsx", "v1"], ["src/App.tsx", "app"]]);
    expect(detectConflicts(before, now, ["src/pages/Shop.tsx", "src/App.tsx"])).toEqual([]);
  });

  test("un fichier réécrit pendant la réécriture IA (QA à 15:10:08) est signalé, pas écrasé", () => {
    const now = new Map([["src/pages/Shop.tsx", "v2-corrige-par-qa"], ["src/App.tsx", "app"]]);
    expect(detectConflicts(before, now, ["src/pages/Shop.tsx", "src/App.tsx"])).toEqual(["src/pages/Shop.tsx"]);
  });

  test("fichier créé ou supprimé entre-temps = conflit ; fichiers non visés ignorés", () => {
    const now = new Map([["src/App.tsx", "app"], ["src/lib/catalog.ts", "nouveau"]]);
    expect(detectConflicts(before, now, ["src/pages/Shop.tsx", "src/lib/catalog.ts"])).toEqual(["src/pages/Shop.tsx", "src/lib/catalog.ts"]);
    expect(detectConflicts(before, now, ["src/App.tsx"])).toEqual([]);
  });

  test("les approbations de produit rebranchent le site", () => {
    const idx = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    for (const tag of ["[product-visualize/approve]", "[brand-preview/approve]", "[printify/create-product]", "[chat-product]"]) {
      expect(idx).toContain(`syncCatalogAfterBuilds(`);
      expect(idx).toContain(`'${tag}'`);
    }
  });
});
