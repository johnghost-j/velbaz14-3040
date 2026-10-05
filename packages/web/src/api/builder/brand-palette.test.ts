import { describe, expect, it } from "bun:test";
import {
  alignDesignToBrand,
  brandPaletteInstruction,
  buildBrandPalette,
  deriveAccent,
  hexesFromGuidelines,
  hueGap,
  isChromatic,
  type BrandPalette,
} from "./brand-palette";
import { contrastRatio, hexToHsl } from "./theme-tokens";

const RED = "#D62828";
const RED_DARK = "#B3201F"; // même famille que RED
const BLUE = "#1D4ED8";

describe("hexesFromGuidelines", () => {
  it("lit la palette verrouillée par l'utilisateur, primary en tête", () => {
    const g = hexesFromGuidelines(JSON.stringify({
      colors: { primary: RED, secondary: "#F7B32B", accent: "#2A2A2A", neutral: "#F4F1EC" },
      palette: [RED, "#F7B32B", "#2A2A2A", "#F4F1EC"],
      typography: { heading: "Inter", body: "Inter" },
      lockedByUser: true,
    }));
    expect(g.lockedByUser).toBe(true);
    expect(g.colors[0]).toBe(RED);
    expect(g.colors).toContain("#F7B32B");
  });

  it("extrait les hex noyés dans du texte IA (« deep navy #172A58 »)", () => {
    const g = hexesFromGuidelines(JSON.stringify({
      colors: { primary: "deep navy #172A58", secondary: "warm sand #E8DCC8" },
    }));
    expect(g.colors).toEqual(["#172A58", "#E8DCC8"]);
    expect(g.lockedByUser).toBe(false);
  });

  it("supporte une palette en tableau et du JSON invalide", () => {
    expect(hexesFromGuidelines(JSON.stringify({ colors: [RED, BLUE] })).colors).toEqual([RED, BLUE]);
    // Pas du JSON : on ratisse le texte brut plutôt que d'abandonner.
    expect(hexesFromGuidelines("```json\n{ colors: primary #D62828 }\n```").colors).toEqual([RED]);
    expect(hexesFromGuidelines("").colors).toEqual([]);
    expect(hexesFromGuidelines("aucune couleur ici").colors).toEqual([]);
  });

  it("dédoublonne et normalise la casse", () => {
    const g = hexesFromGuidelines(JSON.stringify({ palette: ["#d62828", "#D62828", "#d62828ff"] }));
    expect(g.colors.filter((c) => c === RED).length).toBe(1);
  });
});

describe("buildBrandPalette — le logo est la vérité terrain", () => {
  it("suit le LOGO quand la palette verrouillée le contredit (logo rouge / site bleu)", () => {
    const p = buildBrandPalette({
      logoColors: [RED, "#1B1B1B"],
      guidelines: { colors: [BLUE, "#60A5FA"], lockedByUser: true },
    })!;
    expect(p.primary).toBe(RED);
    expect(p.source).toBe("logo");
    // Le bleu sans parenté avec le logo est écarté, pas relégué.
    expect(p.colors).not.toContain(BLUE);
  });

  it("garde la palette utilisateur quand elle est d'accord avec le logo", () => {
    const p = buildBrandPalette({
      logoColors: [RED_DARK],
      guidelines: { colors: [RED, "#F7B32B"], lockedByUser: true },
    })!;
    expect(p.source).toBe("user");
    expect(p.primary).toBe(RED); // hex choisi par l'utilisateur, mieux calibré
    expect(hueGap(p.primary, RED_DARK)).toBeLessThanOrEqual(30);
  });

  it("n'accorde pas ce privilège à une palette IA non verrouillée", () => {
    const p = buildBrandPalette({
      logoColors: [RED_DARK],
      guidelines: { colors: [RED], lockedByUser: false },
    })!;
    expect(p.source).toBe("logo");
    expect(p.primary).toBe(RED_DARK);
  });

  it("se rabat sur les guidelines quand le logo n'est pas encore généré", () => {
    const ai = buildBrandPalette({ logoColors: [], guidelines: { colors: [BLUE], lockedByUser: false } })!;
    expect(ai.source).toBe("guidelines");
    expect(ai.primary).toBe(BLUE);
    const user = buildBrandPalette({ logoColors: null, guidelines: { colors: [BLUE], lockedByUser: true } })!;
    expect(user.source).toBe("user");
  });

  it("renvoie null quand rien n'est fiable (le design reste libre)", () => {
    expect(buildBrandPalette({})).toBeNull();
    expect(buildBrandPalette({ logoColors: [], guidelines: { colors: [], lockedByUser: true } })).toBeNull();
  });

  it("préfère une couleur chromatique au noir dominant", () => {
    const p = buildBrandPalette({ logoColors: ["#111111", RED] })!;
    expect(p.primary).toBe(RED);
  });

  it("garantit un accent perceptiblement différent du primary", () => {
    const same = buildBrandPalette({ logoColors: [RED, RED_DARK] })!;
    expect(same.accent).not.toBe(same.primary);
    const distinct = buildBrandPalette({ logoColors: [RED, "#F7B32B"] })!;
    expect(distinct.accent).toBe("#F7B32B");
    for (const p of [same, distinct]) {
      expect(hueGap(p.primary, p.accent) >= 20 || Math.abs(hexToHsl(p.primary).l - hexToHsl(p.accent).l) >= 15).toBe(true);
    }
  });

  it("est déterministe (deux builds de la même marque = même palette)", () => {
    const input = { logoColors: [RED, "#1B1B1B"], guidelines: { colors: [RED], lockedByUser: true } };
    expect(buildBrandPalette(input)).toEqual(buildBrandPalette(input));
  });
});

describe("deriveAccent", () => {
  it("décale la teinte d'une marque colorée en restant lisible", () => {
    const a = deriveAccent(RED);
    expect(hueGap(a, RED)).toBeGreaterThanOrEqual(20);
    expect(isChromatic(a)).toBe(true);
    expect(hexToHsl(a).l).toBeGreaterThanOrEqual(38);
    expect(hexToHsl(a).l).toBeLessThanOrEqual(62);
  });

  it("ne colore pas une marque neutre (logo noir & blanc reste neutre)", () => {
    const a = deriveAccent("#141414");
    expect(hexToHsl(a).s).toBeLessThan(18);
    expect(contrastRatio(a, "#141414")).toBeGreaterThan(3);
  });
});

describe("alignDesignToBrand", () => {
  const brand: BrandPalette = { primary: RED, accent: "#F7B32B", colors: [RED, "#F7B32B"], source: "logo" };

  it("impose primary et accent de la marque", () => {
    const { colors, changed } = alignDesignToBrand({ primary: BLUE, accent: "#60A5FA" }, brand);
    expect(colors.primary).toBe(RED);
    expect(colors.accent).toBe("#F7B32B");
    expect(changed).toEqual(["primary", "accent"]);
  });

  it("fait pivoter les neutres teintés d'une autre famille vers la marque", () => {
    const { colors } = alignDesignToBrand(
      { primary: BLUE, accent: BLUE, background: "#0B1220", surface: "#14203A", border: "#1F3358" },
      brand,
    );
    for (const key of ["background", "surface", "border"] as const) {
      expect(hueGap(colors[key] as string, RED)).toBeLessThanOrEqual(40);
    }
  });

  it("conserve la luminosité des neutres (les contrastes validés le restent)", () => {
    const before = { primary: BLUE, background: "#0B1220", text: "#E6EDF7" };
    const { colors } = alignDesignToBrand(before, brand);
    expect(hexToHsl(colors.background as string).l).toBe(hexToHsl(before.background).l);
    expect(hexToHsl(colors.text as string).l).toBe(hexToHsl(before.text).l);
    expect(contrastRatio(colors.text as string, colors.background as string)).toBeGreaterThan(7);
  });

  it("ne touche pas aux neutres assumés (site noir et blanc, logo rouge)", () => {
    const { colors, changed } = alignDesignToBrand(
      { primary: RED, accent: "#F7B32B", background: "#FAFAF9", surface: "#FFFFFF", text: "#17171A" },
      brand,
    );
    expect(changed).toEqual([]);
    expect(colors.background).toBe("#FAFAF9");
    expect(colors.text).toBe("#17171A");
  });

  it("ne modifie rien sans palette de marque et n'altère pas l'objet source", () => {
    const src = { primary: BLUE, background: "#0B1220" };
    const { colors, changed } = alignDesignToBrand(src, null);
    expect(changed).toEqual([]);
    expect(colors).toEqual(src);
    alignDesignToBrand(src, brand);
    expect(src.primary).toBe(BLUE); // pas de mutation en place
  });

  it("supporte un design vide ou nul", () => {
    expect(alignDesignToBrand(null, brand).colors.primary).toBe(RED);
    expect(alignDesignToBrand({}, brand).colors.accent).toBe("#F7B32B");
  });
});

describe("brandPaletteInstruction", () => {
  it("nomme les hex exacts imposés au design system", () => {
    const txt = brandPaletteInstruction({ primary: RED, accent: "#F7B32B", colors: [RED, "#F7B32B", "#1B1B1B"], source: "logo" });
    expect(txt).toContain(RED);
    expect(txt).toContain("#F7B32B");
    expect(txt).toContain("#1B1B1B");
    expect(txt).toContain("INTERDIT");
  });

  it("est vide sans marque (aucune consigne parasite dans le prompt)", () => {
    expect(brandPaletteInstruction(null)).toBe("");
  });
});
