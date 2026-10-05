import { describe, it, expect } from "bun:test";
import {
  findBlock,
  retintThemeCss,
  retintTailwindConfig,
  retintDesignJson,
  retintProjectFiles,
  designColorsFromJson,
} from "./retheme";
import { buildThemeCss, buildTailwindColors, deriveThemePair, hexToHsl } from "./theme-tokens";
import type { BrandPalette } from "./brand-palette";

const BLUE_DESIGN = {
  primary: "#1D4ED8",
  accent: "#3B82F6",
  background: "#F8FAFF",
  surface: "#FFFFFF",
  text: "#0B1220",
  muted: "#5A6B87",
  border: "#D8E1F2",
};

const RED_BRAND: BrandPalette = {
  primary: "#C0392B",
  accent: "#E8613C",
  colors: ["#C0392B", "#E8613C"],
  source: "logo",
};

const scaffoldCss = () => `@tailwind base;
@tailwind components;
@tailwind utilities;

${buildThemeCss(deriveThemePair(BLUE_DESIGN))}
/* custom code written later by the AI — must survive untouched */
.hero-glow { animation: pulse 3s infinite; }
@media (max-width: 640px) { .hero-glow { animation: none; } }
`;

const scaffoldTailwind = () => `export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
${buildTailwindColors({ primaryColor: BLUE_DESIGN.primary, accentColor: BLUE_DESIGN.accent })}
      },
    },
  },
  plugins: [],
};
`;

describe("findBlock", () => {
  it("returns the body range of a selector", () => {
    const css = ":root {\n  --bg: #fff;\n}\n";
    const b = findBlock(css, ":root")!;
    expect(b).not.toBeNull();
    expect(css.slice(b.start, b.end)).toContain("--bg: #fff");
  });

  it("balances nested braces", () => {
    const css = "html.dark {\n  --bg: #000;\n  @media (x) { --bg: #111; }\n}\n.after{}";
    const b = findBlock(css, "html.dark")!;
    const body = css.slice(b.start, b.end);
    expect(body).toContain("@media");
    expect(body).not.toContain(".after");
  });

  it("returns null when the selector is absent or unclosed", () => {
    expect(findBlock(":root { --bg: #fff; }", "html.dark")).toBeNull();
    expect(findBlock(":root { --bg: #fff;", ":root")).toBeNull();
  });
});

describe("retintThemeCss", () => {
  const pair = deriveThemePair({ ...BLUE_DESIGN, primary: RED_BRAND.primary, accent: RED_BRAND.accent });
  const out = retintThemeCss(scaffoldCss(), pair);

  it("rewrites both hex and -rgb forms of the accent in :root", () => {
    expect(out.changed).toBeGreaterThan(0);
    const root = out.css.slice(findBlock(out.css, ":root")!.start, findBlock(out.css, ":root")!.end);
    expect(root).toContain(`--accent: ${pair.light.accent}`);
    // Les canaux RGB doivent suivre le hex, sinon `bg-accent/60` resterait bleu.
    const [r, g, b] = [pair.light.accent.slice(1, 3), pair.light.accent.slice(3, 5), pair.light.accent.slice(5, 7)]
      .map((h) => parseInt(h, 16));
    expect(root).toContain(`--accent-rgb: ${r} ${g} ${b}`);
  });

  it("retints the dark block with the dark tone, not the light one", () => {
    const dark = out.css.slice(findBlock(out.css, "html.dark")!.start, findBlock(out.css, "html.dark")!.end);
    expect(dark).toContain(`--accent: ${pair.dark.accent}`);
    // Le fond diffère forcément entre les deux tons : si le bloc sombre avait
    // reçu le ton clair, le site en mode sombre s'afficherait en blanc.
    expect(pair.dark.bg).not.toBe(pair.light.bg);
    expect(dark).toContain(`--bg: ${pair.dark.bg}`);
    expect(dark).not.toContain(`--bg: ${pair.light.bg}`);
    expect(dark).toContain(`--ink: ${pair.dark.ink}`);
  });

  it("brings the new accent into the brand hue family", () => {
    const gap = Math.abs(hexToHsl(pair.light.accent).h - hexToHsl(RED_BRAND.accent).h);
    expect(Math.min(gap, 360 - gap)).toBeLessThanOrEqual(30);
  });

  it("preserves every non-token line byte for byte", () => {
    expect(out.css).toContain(".hero-glow { animation: pulse 3s infinite; }");
    expect(out.css).toContain("@media (max-width: 640px) { .hero-glow { animation: none; } }");
    expect(out.css.startsWith("@tailwind base;")).toBe(true);
  });

  it("is idempotent", () => {
    const again = retintThemeCss(out.css, pair);
    expect(again.changed).toBe(0);
    expect(again.css).toBe(out.css);
  });

  it("leaves css without theme blocks untouched", () => {
    const plain = ".x { color: red; }";
    const res = retintThemeCss(plain, pair);
    expect(res.changed).toBe(0);
    expect(res.css).toBe(plain);
  });

  it("handles empty input", () => {
    expect(retintThemeCss("", pair).css).toBe("");
  });
});

describe("retintTailwindConfig", () => {
  it("replaces the hardcoded brand hex", () => {
    const res = retintTailwindConfig(scaffoldTailwind(), RED_BRAND.primary);
    expect(res.changed).toBe(1);
    expect(res.css).toContain(`brand: "${RED_BRAND.primary}"`);
    expect(res.css).not.toContain(BLUE_DESIGN.primary);
  });

  it("keeps the rgb var tokens intact", () => {
    const res = retintTailwindConfig(scaffoldTailwind(), RED_BRAND.primary);
    expect(res.css).toContain('bg: "rgb(var(--bg-rgb) / <alpha-value>)"');
    expect(res.css).toContain('"accent-ink": "rgb(var(--accent-ink-rgb) / <alpha-value>)"');
  });

  it("is idempotent and tolerant of bad input", () => {
    const once = retintTailwindConfig(scaffoldTailwind(), RED_BRAND.primary);
    expect(retintTailwindConfig(once.css, RED_BRAND.primary).changed).toBe(0);
    expect(retintTailwindConfig("", RED_BRAND.primary).changed).toBe(0);
    expect(retintTailwindConfig(once.css, "not-a-hex").changed).toBe(0);
  });
});

describe("retintDesignJson", () => {
  it("aligns the stored design system palette to the brand", () => {
    const json = JSON.stringify({ companyName: "X", colors: BLUE_DESIGN, font: "Inter" }, null, 2);
    const res = retintDesignJson(json, RED_BRAND);
    expect(res.changed).toBeGreaterThan(0);
    const parsed = JSON.parse(res.css);
    expect(parsed.colors.primary).toBe(RED_BRAND.primary);
    expect(parsed.colors.accent).toBe(RED_BRAND.accent);
    // Les champs hors palette ne doivent pas bouger.
    expect(parsed.companyName).toBe("X");
    expect(parsed.font).toBe("Inter");
  });

  it("returns the input unchanged on invalid json", () => {
    expect(retintDesignJson("{not json", RED_BRAND).css).toBe("{not json");
    expect(retintDesignJson("", RED_BRAND).changed).toBe(0);
  });
});

describe("retintProjectFiles", () => {
  const files = [
    { path: "src/styles.css", content: scaffoldCss() },
    { path: "tailwind.config.js", content: scaffoldTailwind() },
    { path: ".velbaz/design.json", content: JSON.stringify({ colors: BLUE_DESIGN }, null, 2) },
    { path: "src/pages/Home.tsx", content: "export default () => null;" },
    { path: "src/lib/brand.ts", content: 'export const LOGO_URL = "x";' },
  ];

  it("returns only the theme files, changed", () => {
    const res = retintProjectFiles(files, RED_BRAND, BLUE_DESIGN);
    const paths = res.files.map((f) => f.path).sort();
    expect(paths).toEqual([".velbaz/design.json", "src/styles.css", "tailwind.config.js"]);
  });

  it("never touches page or brand files", () => {
    const res = retintProjectFiles(files, RED_BRAND, BLUE_DESIGN);
    expect(res.files.find((f) => f.path.endsWith("Home.tsx"))).toBeUndefined();
    expect(res.files.find((f) => f.path.endsWith("brand.ts"))).toBeUndefined();
  });

  it("derives a theme pair in the brand hue", () => {
    const res = retintProjectFiles(files, RED_BRAND, BLUE_DESIGN);
    const gap = Math.abs(hexToHsl(res.pair.light.accent).h - hexToHsl(RED_BRAND.accent).h);
    expect(Math.min(gap, 360 - gap)).toBeLessThanOrEqual(30);
  });

  it("returns nothing to write when already on brand", () => {
    const once = retintProjectFiles(files, RED_BRAND, BLUE_DESIGN);
    const merged = files.map((f) => once.files.find((o) => o.path === f.path) || f);
    const twice = retintProjectFiles(merged, RED_BRAND, BLUE_DESIGN);
    expect(twice.files).toEqual([]);
  });

  it("works without a known current palette", () => {
    const res = retintProjectFiles(files, RED_BRAND, null);
    expect(res.files.length).toBeGreaterThan(0);
    expect(res.pair.light.accent).toBeTruthy();
  });

  it("handles a project with prefixed paths (mobile)", () => {
    const res = retintProjectFiles(
      [{ path: "mobile/tailwind.config.js", content: scaffoldTailwind() }],
      RED_BRAND,
      BLUE_DESIGN,
    );
    expect(res.files.map((f) => f.path)).toEqual(["mobile/tailwind.config.js"]);
  });
});

describe("designColorsFromJson", () => {
  it("reads colors from a design.json", () => {
    expect(designColorsFromJson(JSON.stringify({ colors: BLUE_DESIGN }))?.primary).toBe(BLUE_DESIGN.primary);
  });

  it("returns null on missing, empty or invalid input", () => {
    expect(designColorsFromJson(null)).toBeNull();
    expect(designColorsFromJson("")).toBeNull();
    expect(designColorsFromJson("{oops")).toBeNull();
    expect(designColorsFromJson(JSON.stringify({ font: "Inter" }))).toBeNull();
  });
});
