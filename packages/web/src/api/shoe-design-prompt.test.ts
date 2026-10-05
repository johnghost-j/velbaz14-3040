import { describe, expect, test } from "bun:test";
import { FOOTWEAR_DESIGN_ASPECT, footwearDesignPlan, footwearDesignPrompt, isFootwearPodType } from "./shoe-design-prompt";
import { defaultStyleForPosition, placementFor } from "./printify-artwork";
import { footwearArtworkMode, resolvePlacementPositions } from "./printify-auto";

// Zones réelles du blueprint 291 « Men's sneakers » (provider 14), 1537×545.
const SNEAKER_HOLDERS = ["body_outside_left", "body_outside_right", "body_inside_left", "body_inside_right"]
  .map((position) => ({ position, width: 1537, height: 545 }));

describe("design de chaussure : motif complet, jamais un petit logo", () => {
  test("le prompt demande un all-over bord à bord, sans logo ni texte par défaut", () => {
    const p = footwearDesignPrompt({ concept: "vagues néon et éclats de vitesse", productName: "Urban Glide" });
    expect(p).toContain("vagues néon");
    expect(p).toContain("Urban Glide");
    expect(p).toMatch(/FILLS THE ENTIRE CANVAS/);
    expect(p).toMatch(/NO TEXT, NO LOGO/);
    expect(p).not.toMatch(/pure uniform white/i);
  });

  test("un texte explicitement demandé est le seul autorisé", () => {
    const p = footwearDesignPrompt({ concept: "flammes", text: "RUN FREE" });
    expect(p).toContain('exactly "RUN FREE"');
    expect(p).not.toMatch(/NO TEXT, NO LOGO/);
  });

  test("le plan impose format large, all-over et fond conservé", () => {
    const plan = footwearDesignPlan({ concept: "camo urbain", palette: "#111111, #e11d48" });
    expect(plan.aspectRatio).toBe(FOOTWEAR_DESIGN_ASPECT);
    expect(plan.placementStyle).toBe("all_over");
    expect(plan.keepBackground).toBe(true);
    expect(plan.prompt).toContain("#e11d48");
  });

  test("seul le type canonique 'shoe' est une chaussure", () => {
    expect(isFootwearPodType("shoe")).toBe(true);
    expect(isFootwearPodType("t-shirt")).toBe(false);
    expect(isFootwearPodType(null)).toBe(false);
  });
});

describe("placement all-over d'une chaussure", () => {
  test("le style par défaut d'une chaussure n'est plus 'logo'", () => {
    expect(defaultStyleForPosition("body_outside_left", "footwear")).toBe("all_over");
  });

  test("l'artwork RECOUVRE toute la zone (largeur ET hauteur)", () => {
    const r = 1537 / 545;
    for (const a of [21 / 9, 1, 3.5]) {
      const g = placementFor("all_over", a, r);
      expect(g.x).toBe(0.5);
      expect(g.y).toBe(0.5);
      expect(g.scale).toBeGreaterThanOrEqual(1);
      expect((g.scale * r) / a).toBeGreaterThanOrEqual(0.999); // hauteur couverte
    }
  });

  test("all-over → les 4 zones (extérieur + intérieur) ; sinon extérieur seul", () => {
    expect(resolvePlacementPositions(SNEAKER_HOLDERS, undefined, { includeInside: true })).toHaveLength(4);
    expect(resolvePlacementPositions(SNEAKER_HOLDERS, undefined)).toEqual(["body_outside_left", "body_outside_right"]);
  });

  test("design stocké sans consigne : large ou plein cadre → all-over ; motif sur fond blanc → centré en grand", () => {
    expect(footwearArtworkMode(21 / 9, true)).toEqual({ style: "all_over", keepBackground: true });
    expect(footwearArtworkMode(1, false)).toEqual({ style: "all_over", keepBackground: true });
    expect(footwearArtworkMode(1, true)).toEqual({ style: "centered", keepBackground: false });
  });
});
