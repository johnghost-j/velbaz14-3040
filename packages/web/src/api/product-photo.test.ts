import { describe, expect, test } from "bun:test";
import { pickShopGallery, pickShopPhoto, NON_PHOTO_IMAGE_TYPES, PRESENTATION_IMAGE_TYPES, REAL_PRODUCT_IMAGE_TYPES } from "./product-photo";

type Row = {
  id: string;
  type: string;
  imageData: string | null;
  sortOrder: number | null;
  createdAt?: Date | null;
};

const row = (o: Partial<Row> & { id: string; type: string }): Row => ({
  imageData: `data:image/webp;base64,${o.id}`,
  sortOrder: null,
  createdAt: null,
  ...o,
});

describe("pickShopPhoto", () => {
  test("ne renvoie rien quand le produit n'a aucune image", () => {
    expect(pickShopPhoto([])).toBeNull();
  });

  test("écarte la planche technique 3 vues, même insérée en premier avec sortOrder 0", () => {
    // Le bug d'origine : `reference_sheet` inséré sans sortOrder (donc 0), donc
    // à égalité avec le mockup réel mais AVANT lui → il gagnait le tri.
    const picked = pickShopPhoto([
      row({ id: "sheet", type: "reference_sheet", sortOrder: 0 }),
      row({ id: "real", type: "printify", sortOrder: 0 }),
    ]);
    expect(picked?.id).toBe("real");
  });

  test("écarte le motif d'impression présenté à plat", () => {
    const picked = pickShopPhoto([
      row({ id: "swatch", type: "print_design", sortOrder: 0 }),
      row({ id: "ai", type: "ai_mockup", sortOrder: 10 }),
    ]);
    expect(picked?.id).toBe("ai");
  });

  test("préfère aucune image à un document de production", () => {
    // Mieux vaut le repli propre de l'appelant qu'un dessin technique affiché
    // comme la photo du produit.
    const picked = pickShopPhoto([
      row({ id: "sheet", type: "reference_sheet", sortOrder: 0 }),
      row({ id: "swatch", type: "print_design", sortOrder: 20 }),
      row({ id: "printready", type: "print", sortOrder: 99 }),
    ]);
    expect(picked).toBeNull();
  });

  test("le produit réellement fabriqué passe devant un visuel IA mieux classé", () => {
    const picked = pickShopPhoto([
      row({ id: "ai", type: "ai_mockup", sortOrder: 0 }),
      row({ id: "real", type: "printify", sortOrder: 50 }),
    ]);
    expect(picked?.id).toBe("real");
  });

  test("à type équivalent, le sortOrder le plus faible gagne", () => {
    const picked = pickShopPhoto([
      row({ id: "angle", type: "angle", sortOrder: 3 }),
      row({ id: "hero", type: "hero", sortOrder: 1 }),
    ]);
    expect(picked?.id).toBe("hero");
  });

  test("à sortOrder égal, la plus récente gagne (une régénération remplace l'ancienne)", () => {
    const picked = pickShopPhoto([
      row({ id: "vieux", type: "ai_mockup", sortOrder: 10, createdAt: new Date("2026-01-01") }),
      row({ id: "neuf", type: "ai_mockup", sortOrder: 10, createdAt: new Date("2026-09-01") }),
    ]);
    expect(picked?.id).toBe("neuf");
  });

  test("ignore une ligne sans image", () => {
    const picked = pickShopPhoto([
      row({ id: "vide", type: "printify", imageData: null, sortOrder: 0 }),
      row({ id: "ai", type: "ai_mockup", sortOrder: 10 }),
    ]);
    expect(picked?.id).toBe("ai");
  });

  test("un sortOrder absent (null) ne fait pas gagner un type non-photo", () => {
    const picked = pickShopPhoto([
      row({ id: "sheet", type: "reference_sheet", sortOrder: null }),
      row({ id: "studio", type: "studio", sortOrder: null }),
    ]);
    expect(picked?.id).toBe("studio");
  });

  test("les photos IA du pipeline restent éligibles", () => {
    for (const t of ["ai_mockup", "hero", "model", "studio", "lifestyle", "flat", "photo"]) {
      expect(NON_PHOTO_IMAGE_TYPES.has(t)).toBe(false);
      expect(pickShopPhoto([row({ id: "x", type: t, sortOrder: 0 })])?.id).toBe("x");
    }
  });

  test("les deux ensembles de types ne se chevauchent pas", () => {
    for (const t of REAL_PRODUCT_IMAGE_TYPES) expect(NON_PHOTO_IMAGE_TYPES.has(t)).toBe(false);
  });

  test("ne modifie pas le tableau reçu", () => {
    const imgs = [
      row({ id: "ai", type: "ai_mockup", sortOrder: 0 }),
      row({ id: "real", type: "printify", sortOrder: 50 }),
    ];
    pickShopPhoto(imgs);
    expect(imgs.map((i) => i.id)).toEqual(["ai", "real"]);
  });
});

describe("présentation pro et galerie (2026-10-04)", () => {
  test("la photo de présentation (issue des vues réelles) passe devant le mockup brut", () => {
    const picked = pickShopPhoto([
      row({ id: "real", type: "printify", sortOrder: 0 }),
      row({ id: "pro", type: "presentation", sortOrder: -20 }),
    ]);
    expect(picked?.id).toBe("pro");
  });

  test("galerie : ordre de vitrine, sans doublon ni document de production, bornée", () => {
    const same = "https://images-api.printify.com/mockup/a.jpg";
    const g = pickShopGallery([
      row({ id: "v1", type: "printify", sortOrder: 0, imageData: same }),
      row({ id: "v1bis", type: "printify", sortOrder: 1, imageData: same }),
      row({ id: "life", type: "presentation", sortOrder: -10 }),
      row({ id: "hero", type: "presentation", sortOrder: -20 }),
      row({ id: "sheet", type: "reference_sheet", sortOrder: -99 }),
      row({ id: "ai", type: "ai_mockup", sortOrder: 10 }),
    ]);
    expect(g.map((i) => i.id)).toEqual(["hero", "life", "v1", "ai"]);
    expect(g[0].id).toBe(pickShopPhoto(g)!.id);
    const many = Array.from({ length: 9 }, (_, i) => row({ id: `m${i}`, type: "printify", sortOrder: i }));
    expect(pickShopGallery(many, 6).length).toBe(6);
  });

  test("le type présentation n'est ni un document de prod ni un « produit réel brut »", () => {
    for (const t of PRESENTATION_IMAGE_TYPES) {
      expect(NON_PHOTO_IMAGE_TYPES.has(t)).toBe(false);
      expect(REAL_PRODUCT_IMAGE_TYPES.has(t)).toBe(false);
    }
  });
});
