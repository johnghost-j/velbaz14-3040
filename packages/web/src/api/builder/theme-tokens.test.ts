import { describe, expect, it } from "bun:test";
import {
  contrastRatio,
  isDarkHex,
  hexToHsl,
  deriveThemePair,
  buildThemeCss,
  buildTailwindColors,
  analyzeThemeResponse,
  tokenizeTheme,
  THEME_TOKEN_RULES,
  type DesignColors,
} from "./theme-tokens";

// Palette typique de ce que le design génère: UN seul ton, ici sombre.
const DARK_DESIGN: DesignColors = {
  primary: "#E8E3D9",
  accent: "#C6512A",
  background: "#0B0D0E",
  surface: "#14181A",
  text: "#E9EDEF",
  muted: "#93A1A8",
  border: "#242A2E",
};

const LIGHT_DESIGN: DesignColors = {
  primary: "#1B2A4A",
  accent: "#2F6F4F",
  background: "#FAF8F4",
  surface: "#FFFFFF",
  text: "#161A1D",
  muted: "#5F6B72",
  border: "#E3DED4",
};

describe("deriveThemePair", () => {
  it("garde la palette sombre fournie comme ton de design", () => {
    const p = deriveThemePair(DARK_DESIGN);
    expect(p.designed).toBe("dark");
    expect(p.dark.bg).toBe("#0B0D0E");
    expect(p.dark.surface).toBe("#14181A");
    expect(p.dark.line).toBe("#242A2E");
  });

  it("dérive un ton clair réellement clair depuis une palette sombre", () => {
    const p = deriveThemePair(DARK_DESIGN);
    expect(isDarkHex(p.light.bg)).toBe(false);
    expect(isDarkHex(p.light.ink)).toBe(true);
    // Les deux tons doivent être franchement distincts, pas deux gris voisins.
    expect(hexToHsl(p.light.bg).l - hexToHsl(p.dark.bg).l).toBeGreaterThan(60);
  });

  it("dérive un ton sombre depuis une palette claire", () => {
    const p = deriveThemePair(LIGHT_DESIGN);
    expect(p.designed).toBe("light");
    expect(p.light.bg).toBe("#FAF8F4");
    expect(isDarkHex(p.dark.bg)).toBe(true);
    expect(isDarkHex(p.dark.ink)).toBe(false);
  });

  it("conserve la teinte de la marque dans les deux tons (même marque, pas un gris générique)", () => {
    const p = deriveThemePair({ ...DARK_DESIGN, background: "#0E1A14" });
    const hLight = hexToHsl(p.light.bg).h;
    const hDark = hexToHsl(p.dark.bg).h;
    const delta = Math.min(Math.abs(hLight - hDark), 360 - Math.abs(hLight - hDark));
    expect(delta).toBeLessThan(12);
  });

  it("garde l'accent lisible dans les deux tons", () => {
    const p = deriveThemePair(DARK_DESIGN);
    expect(contrastRatio(p.light.accent, p.light.bg)).toBeGreaterThan(2.5);
    expect(contrastRatio(p.dark.accent, p.dark.bg)).toBeGreaterThan(2.5);
    // Le texte posé SUR l'accent doit rester lisible.
    expect(contrastRatio(p.light.accentInk, p.light.accent)).toBeGreaterThan(3);
    expect(contrastRatio(p.dark.accentInk, p.dark.accent)).toBeGreaterThan(3);
  });

  it("garantit le contraste texte/fond dans les deux tons", () => {
    for (const d of [DARK_DESIGN, LIGHT_DESIGN]) {
      const p = deriveThemePair(d);
      for (const t of [p.light, p.dark]) {
        expect(contrastRatio(t.ink, t.bg)).toBeGreaterThanOrEqual(6.5);
        expect(contrastRatio(t.inkMuted, t.bg)).toBeGreaterThanOrEqual(4.4);
      }
    }
  });

  it("retombe sur une paire valide sans palette", () => {
    for (const input of [undefined, null, {} as DesignColors]) {
      const p = deriveThemePair(input);
      expect(isDarkHex(p.light.bg)).toBe(false);
      expect(isDarkHex(p.dark.bg)).toBe(true);
      expect(p.light.accent).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it("utilise l'accent fourni même sans background", () => {
    const p = deriveThemePair({ accent: "#1D6FE0" });
    expect(hexToHsl(p.light.accent).h).toBeCloseTo(hexToHsl("#1D6FE0").h, 0);
  });
});

describe("buildThemeCss", () => {
  const css = buildThemeCss(deriveThemePair(DARK_DESIGN));

  it("déclare les deux tons, dont html.dark", () => {
    expect(css).toContain(":root {");
    expect(css).toContain("html.dark {");
  });

  it("expose chaque token en hex ET en canaux rgb", () => {
    for (const v of ["--bg", "--surface", "--surface-2", "--ink", "--ink-muted", "--line", "--accent", "--accent-ink"]) {
      expect(css).toContain(`${v}: #`);
      expect(css).toMatch(new RegExp(`${v}-rgb: \\d+ \\d+ \\d+;`));
    }
  });

  it("câble le body sur les tokens (sinon le fond de page ne bascule pas)", () => {
    expect(css).toContain("background-color: var(--bg)");
    expect(css).toContain("color: var(--ink)");
    expect(css).toContain("color-scheme: dark");
  });

  it("donne des valeurs différentes aux deux tons", () => {
    const root = css.slice(css.indexOf(":root"), css.indexOf("html.dark"));
    const dark = css.slice(css.indexOf("html.dark"));
    const bgOf = (s: string) => /--bg: (#[0-9A-F]{6})/i.exec(s)?.[1];
    expect(bgOf(root)).not.toBe(bgOf(dark));
  });
});

describe("buildTailwindColors", () => {
  const out = buildTailwindColors({ primaryColor: "#E8E3D9", accentColor: "#C6512A" });

  it("mappe les noms sémantiques sur les variables, avec support de l'opacité", () => {
    expect(out).toContain('bg: "rgb(var(--bg-rgb) / <alpha-value>)"');
    expect(out).toContain('"surface-2": "rgb(var(--surface-2-rgb) / <alpha-value>)"');
    expect(out).toContain('"ink-muted": "rgb(var(--ink-muted-rgb) / <alpha-value>)"');
    expect(out).toContain('accent: "rgb(var(--accent-rgb) / <alpha-value>)"');
  });

  it("garde la couleur de marque brute disponible", () => {
    expect(out).toContain('brand: "#E8E3D9"');
  });
});

describe("analyzeThemeResponse", () => {
  it("signale une page entièrement peinte en couleurs figées", () => {
    const code = `export default function Page() {
      return (
        <section className="bg-[#0B0D0E] text-[#E9EDEF]">
          <div className="bg-[#14181A] border border-[#242A2E]">
            <h2 className="text-[#E9EDEF]">Titre</h2>
            <p className="text-[#93A1A8]">Texte</p>
          </div>
        </section>
      );
    }`;
    const r = analyzeThemeResponse("src/pages/Home.tsx", code);
    expect(r.dead).toBe(true);
    expect(r.score).toBeLessThan(70);
    expect(r.issues.map((i) => i.code)).toContain("HARDCODED_BG");
    expect(r.issues.map((i) => i.code)).toContain("HARDCODED_INK");
    expect(r.issues.map((i) => i.code)).toContain("NO_DARK_VARIANT");
  });

  it("ne signale pas une page écrite en tokens", () => {
    const code = `export default function Page() {
      return (
        <section className="bg-bg text-ink">
          <div className="bg-surface border border-line">
            <p className="text-ink-muted">Texte</p>
            <button className="bg-accent text-accent-ink">Action</button>
          </div>
        </section>
      );
    }`;
    const r = analyzeThemeResponse("src/pages/Home.tsx", code);
    expect(r.dead).toBe(false);
    expect(r.score).toBe(100);
    expect(r.issues).toHaveLength(0);
  });

  it("ne signale pas une couleur figée qui a sa variante dark: dans le même attribut", () => {
    const code = `<div className="bg-white text-gray-900 dark:bg-neutral-900 dark:text-white border-gray-200 dark:border-neutral-800">x</div>`;
    const r = analyzeThemeResponse("src/pages/A.tsx", code);
    expect(r.issues).toHaveLength(0);
    expect(r.dead).toBe(false);
  });

  it("signale les neutres Tailwind figés sans variante dark:", () => {
    const code = `<div className="bg-white text-gray-900"><p className="text-gray-500">x</p></div>`;
    const r = analyzeThemeResponse("src/pages/A.tsx", code);
    expect(r.issues.map((i) => i.code)).toContain("HARDCODED_BG");
    expect(r.issues.map((i) => i.code)).toContain("HARDCODED_INK");
  });

  it("signale les couleurs en style inline (aucune variante dark: possible)", () => {
    const code = `<div style={{ background: "#0B0D0E" }}><span style={{ color: "#E9EDEF" }}>x</span></div>`;
    const r = analyzeThemeResponse("src/pages/A.tsx", code);
    const inline = r.issues.find((i) => i.code === "INLINE_STATIC_COLOR");
    expect(inline?.count).toBe(2);
  });

  it("accepte un style inline déjà câblé sur une variable", () => {
    const code = `<div style={{ background: "var(--surface)" }}>x</div>`;
    const r = analyzeThemeResponse("src/pages/A.tsx", code);
    expect(r.issues.find((i) => i.code === "INLINE_STATIC_COLOR")).toBeUndefined();
  });

  it("ignore le code commenté (il n'affiche rien)", () => {
    const code = `// <div className="bg-[#0B0D0E] text-[#E9EDEF]">old</div>\n<div className="bg-bg text-ink">x</div>`;
    const r = analyzeThemeResponse("src/pages/A.tsx", code);
    expect(r.issues).toHaveLength(0);
  });
});

describe("tokenizeTheme", () => {
  const pair = deriveThemePair(DARK_DESIGN);

  it("convertit les classes arbitraires de la palette en tokens", () => {
    const code = `<section className="bg-[#0B0D0E] text-[#E9EDEF]"><div className="bg-[#14181A] border-[#242A2E]"><p className="text-[#93A1A8]">x</p></div></section>`;
    const { code: out, replaced } = tokenizeTheme(code, pair);
    expect(replaced).toBeGreaterThanOrEqual(5);
    expect(out).toContain("bg-bg");
    expect(out).toContain("text-ink");
    expect(out).toContain("bg-surface");
    expect(out).toContain("border-line");
    expect(out).toContain("text-ink-muted");
    expect(out).not.toContain("#0B0D0E");
    expect(out).not.toContain("#242A2E");
  });

  it("préserve le suffixe d'opacité des classes arbitraires", () => {
    const { code: out } = tokenizeTheme(`<div className="bg-[#14181A]/60">x</div>`, pair);
    expect(out).toContain("bg-surface/60");
  });

  it("convertit les utilitaires de dégradé (from/via/to)", () => {
    const { code: out } = tokenizeTheme(`<div className="bg-gradient-to-b from-[#0B0D0E] to-[#14181A]">x</div>`, pair);
    expect(out).toContain("from-bg");
    expect(out).toContain("to-surface");
  });

  it("convertit les neutres Tailwind figés sans variante dark:", () => {
    const { code: out, replaced } = tokenizeTheme(`<div className="bg-white text-gray-900">x</div>`, pair);
    expect(replaced).toBeGreaterThan(0);
    expect(out).toContain("bg-surface");
    expect(out).toContain("text-ink");
    expect(out).not.toContain("bg-white");
  });

  it("laisse tranquille un attribut qui gère déjà sa bascule en dark:", () => {
    const code = `<div className="bg-white dark:bg-neutral-900 text-gray-900 dark:text-white">x</div>`;
    const { code: out, replaced } = tokenizeTheme(code, pair);
    expect(out).toBe(code);
    expect(replaced).toBe(0);
  });

  it("convertit les hex de la palette dans les styles inline en var(--token)", () => {
    const code = `<div style={{ background: "#0B0D0E", color: "#E9EDEF", borderColor: "#242A2E" }}>x</div>`;
    const { code: out } = tokenizeTheme(code, pair);
    expect(out).toContain("var(--bg)");
    expect(out).toContain("var(--ink)");
    expect(out).toContain("var(--line)");
  });

  it("convertit les rgba de la palette en rgb(var(--token-rgb) / alpha)", () => {
    const { code: out } = tokenizeTheme(`<div style={{ background: "rgba(11, 13, 14, 0.7)" }}>x</div>`, pair);
    expect(out).toContain("rgb(var(--bg-rgb) / 0.7)");
  });

  it("ne touche pas aux couleurs qui n'appartiennent pas au design system", () => {
    const code = `<div className="bg-[#16A34A] text-[#DC2626]" style={{ color: "#1DA1F2" }}>statut</div>`;
    const { code: out, replaced } = tokenizeTheme(code, pair);
    expect(out).toBe(code);
    expect(replaced).toBe(0);
  });

  it("est idempotent sur du code déjà tokenisé", () => {
    const code = `<div className="bg-bg text-ink border-line"><p className="text-ink-muted">x</p></div>`;
    const { code: out, replaced } = tokenizeTheme(code, pair);
    expect(out).toBe(code);
    expect(replaced).toBe(0);
  });

  it("ne produit jamais de classe arbitraire contenant var() (invalide en Tailwind)", () => {
    const code = `<section className="bg-[#0B0D0E]"><div style={{ background: "#14181A" }}/></section>`;
    const { code: out } = tokenizeTheme(code, pair);
    expect(out).not.toMatch(/-\[var\(/);
    expect(out).toContain("bg-bg");
    expect(out).toContain("var(--surface)");
  });

  it("rend réactive une page morte: score de réactivité 100 après conversion", () => {
    const code = `export default function Showroom() {
      return (
        <section className="bg-[#0B0D0E] text-[#E9EDEF] py-24">
          <div className="mx-auto max-w-6xl">
            <h1 className="text-[#E9EDEF] text-5xl">Showroom</h1>
            <p className="text-[#93A1A8]">Nos pièces</p>
            <div className="bg-[#14181A] border border-[#242A2E] rounded-2xl p-6" style={{ background: "#14181A" }}>
              <span className="text-[#93A1A8]">Détail</span>
            </div>
          </div>
        </section>
      );
    }`;
    const before = analyzeThemeResponse("src/pages/Showroom.tsx", code);
    const { code: out } = tokenizeTheme(code, pair);
    const after = analyzeThemeResponse("src/pages/Showroom.tsx", out);
    expect(before.dead).toBe(true);
    expect(after.dead).toBe(false);
    expect(after.score).toBe(100);
    // Le câblage et la structure ne bougent pas.
    expect(out).toContain("export default function Showroom");
    expect(out.split("\n").length).toBe(code.split("\n").length);
  });

  it("ne casse pas sur du code vide", () => {
    expect(tokenizeTheme("", pair)).toEqual({ code: "", replaced: 0 });
  });
});

describe("THEME_TOKEN_RULES", () => {
  it("nomme les tokens et interdit explicitement les couleurs figées", () => {
    expect(THEME_TOKEN_RULES).toContain("bg-surface");
    expect(THEME_TOKEN_RULES).toContain("text-ink");
    expect(THEME_TOKEN_RULES).toContain("border-line");
    expect(THEME_TOKEN_RULES.toLowerCase()).toContain("en dur");
  });
});
