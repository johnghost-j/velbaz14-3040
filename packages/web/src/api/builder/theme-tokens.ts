// ─────────────────────────────────────────────────────────────────────────────
// THÈME CLAIR/SOMBRE RÉELLEMENT FONCTIONNEL
//
// Bug constaté sur les sites générés: le bouton de thème est présent (le
// scaffold rend <ThemeToggle/> dans le Header, `ThemeProvider` pose bien la
// classe `.dark` sur <html>, Tailwind est en `darkMode: "class"`)… mais
// cliquer ne change RIEN, ou ne change QU'UNE PARTIE de la page.
//
// Cause: le design system est une palette de hex FIXES, et les pages générées
// l'appliquent en dur (`bg-[#0B0D0E]`, `text-[#E9EDEF]`, `border-[#242A2E]`).
// Une couleur codée en dur ne peut PAS réagir à une classe sur <html>. Seules
// les zones écrites avec des utilitaires Tailwind + variante `dark:` (le
// Header/Footer du scaffold, le `body`) basculent — d'où le « ça ne change
// qu'un bout ».
//
// Correctif: la palette devient un jeu de VARIABLES CSS déclinées en deux tons
// (`:root` = clair, `html.dark` = sombre), exposées à Tailwind sous des noms
// sémantiques (`bg-bg`, `bg-surface`, `text-ink`, `border-line`…). Écrire
// `bg-surface` au lieu de `bg-[#111]` suffit alors pour que la page entière
// bascule. Ce module:
//   1. dérive les DEUX tons depuis la palette unique du design (deriveThemePair)
//   2. produit le CSS des variables + la config Tailwind (buildThemeCss…)
//   3. détecte les couleurs non réactives dans une page (analyzeThemeResponse)
//   4. les convertit MÉCANIQUEMENT en tokens (tokenizeTheme) — déterministe,
//      sans appel modèle
//   5. fournit les règles injectées dans les prompts (THEME_TOKEN_RULES)
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemeTokens {
  bg: string;
  surface: string;
  surface2: string;
  ink: string;
  inkMuted: string;
  line: string;
  accent: string;
  accentInk: string; // encre POSÉE SUR l'accent (contraste garanti)
}

export interface ThemePair {
  light: ThemeTokens;
  dark: ThemeTokens;
  /** Ton dans lequel le design a été conçu — celui qui reste fidèle à 100 %. */
  designed: "light" | "dark";
}

// ─── Couleur: helpers ────────────────────────────────────────────────────────

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function normHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) s = "#" + s.slice(1).split("").map((c) => c + c).join("");
  return HEX6.test(s) ? s.toUpperCase() : null;
}

export function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: Math.max(0, Math.min(1, s)) * 100, l: l * 100 };
}

export function hslToHex(h: number, s: number, l: number): string {
  const S = Math.max(0, Math.min(100, s)) / 100;
  const L = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = L - c / 2;
  return (
    "#" +
    [r1, g1, b1]
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/** Même teinte, luminosité imposée. Sert à dériver un ton depuis l'autre. */
export function withL(hex: string, l: number, s?: number): string {
  const c = hexToHsl(hex);
  return hslToHex(c.h, s === undefined ? c.s : s, l);
}

export function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a), lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDarkHex(hex: string): boolean {
  return relLuminance(hex) < 0.2;
}

/** Encre lisible SUR une couleur donnée (blanc ou encre très foncée). */
function inkOn(bg: string): string {
  const dark = withL(bg, 10, Math.min(hexToHsl(bg).s, 25));
  return contrastRatio(bg, "#FFFFFF") >= contrastRatio(bg, dark) ? "#FFFFFF" : dark;
}

/** Remonte le contraste texte/fond jusqu'au seuil visé, en gardant la teinte. */
function ensureContrast(fg: string, bg: string, target: number): string {
  if (contrastRatio(fg, bg) >= target) return fg;
  const bgDark = isDarkHex(bg);
  const { h, s } = hexToHsl(fg);
  // On pousse l'encre dans la direction opposée au fond, cran par cran.
  for (let step = 0; step <= 100; step += 2) {
    const l = bgDark ? Math.min(100, hexToHsl(fg).l + step) : Math.max(0, hexToHsl(fg).l - step);
    const cand = hslToHex(h, s, l);
    if (contrastRatio(cand, bg) >= target) return cand;
  }
  return bgDark ? "#FFFFFF" : "#000000";
}

// ─── 1) Dériver les deux tons depuis la palette unique du design ─────────────

export interface DesignColors {
  primary?: string; accent?: string; background?: string;
  surface?: string; text?: string; muted?: string; border?: string;
  [k: string]: unknown;
}

const FALLBACK_LIGHT: ThemeTokens = {
  bg: "#FAFAF9", surface: "#FFFFFF", surface2: "#F4F4F2", ink: "#17171A",
  inkMuted: "#5B5B63", line: "#E4E4E1", accent: "#B3261E", accentInk: "#FFFFFF",
};

/**
 * Le design ne fournit qu'UNE palette (souvent sombre). On garde ce ton tel
 * quel — c'est celui que le designer/l'IA a validé — et on dérive l'autre en
 * conservant teinte et saturation, pour que le site reste la MÊME marque en
 * clair comme en sombre (et pas un thème générique gris).
 */
export function deriveThemePair(colors: DesignColors | undefined | null): ThemePair {
  const c = colors || {};
  const bg = normHex(c.background);
  const accentRaw = normHex(c.accent) || normHex(c.primary) || FALLBACK_LIGHT.accent;
  if (!bg) {
    const light = { ...FALLBACK_LIGHT, accent: accentRaw, accentInk: inkOn(accentRaw) };
    return { light, dark: flipTone(light, "dark"), designed: "light" };
  }

  const designed: "light" | "dark" = isDarkHex(bg) ? "dark" : "light";
  const surface = normHex(c.surface) || withL(bg, designed === "dark" ? hexToHsl(bg).l + 4 : hexToHsl(bg).l + 2);
  const ink = ensureContrast(normHex(c.text) || (designed === "dark" ? "#ECECEF" : "#17171A"), bg, 7);
  const muted = ensureContrast(normHex(c.muted) || withL(ink, designed === "dark" ? 62 : 42), bg, 4.5);
  const line = normHex(c.border) || withL(bg, designed === "dark" ? hexToHsl(bg).l + 10 : hexToHsl(bg).l - 8);
  const surface2 = withL(surface, designed === "dark" ? hexToHsl(surface).l + 4 : hexToHsl(surface).l - 4);

  const own: ThemeTokens = {
    bg, surface, surface2, ink, inkMuted: muted, line,
    accent: accentRaw, accentInk: inkOn(accentRaw),
  };
  const other = flipTone(own, designed === "dark" ? "light" : "dark");
  return designed === "dark"
    ? { dark: own, light: other, designed }
    : { light: own, dark: other, designed };
}

/** Dérive le ton opposé: on inverse les luminosités, pas les teintes. */
function flipTone(src: ThemeTokens, target: "light" | "dark"): ThemeTokens {
  const hBg = hexToHsl(src.bg);
  const hInk = hexToHsl(src.ink);
  if (target === "light") {
    // Fond quasi blanc mais TEINTÉ par la marque (jamais #FFF pur et froid).
    const bg = hslToHex(hBg.h, Math.min(hBg.s, 18), 97);
    const surface = hslToHex(hBg.h, Math.min(hBg.s, 10), 100);
    const ink = ensureContrast(hslToHex(hInk.h || hBg.h, Math.min(Math.max(hInk.s, 8), 30), 13), bg, 7);
    const accent = adjustAccent(src.accent, "light");
    return {
      bg, surface,
      surface2: hslToHex(hBg.h, Math.min(hBg.s, 14), 93),
      ink,
      inkMuted: ensureContrast(hslToHex(hInk.h || hBg.h, Math.min(Math.max(hInk.s, 6), 22), 44), bg, 4.5),
      line: hslToHex(hBg.h, Math.min(hBg.s, 16), 88),
      accent, accentInk: inkOn(accent),
    };
  }
  const bg = hslToHex(hBg.h, Math.min(Math.max(hBg.s, 6), 26), 7);
  const accent = adjustAccent(src.accent, "dark");
  return {
    bg,
    surface: hslToHex(hBg.h, Math.min(Math.max(hBg.s, 5), 22), 11),
    surface2: hslToHex(hBg.h, Math.min(Math.max(hBg.s, 5), 20), 15),
    ink: ensureContrast(hslToHex(hInk.h || hBg.h, Math.min(hInk.s, 12), 95), bg, 7),
    inkMuted: ensureContrast(hslToHex(hInk.h || hBg.h, Math.min(Math.max(hInk.s, 4), 16), 66), bg, 4.5),
    line: hslToHex(hBg.h, Math.min(Math.max(hBg.s, 5), 20), 20),
    accent, accentInk: inkOn(accent),
  };
}

/** L'accent doit rester lisible dans les deux tons (trop clair sur blanc,
 *  trop sombre sur noir = illisible). On ne bouge QUE la luminosité. */
function adjustAccent(accent: string, target: "light" | "dark"): string {
  const { h, s, l } = hexToHsl(accent);
  if (target === "light") return hslToHex(h, s, Math.min(Math.max(l, 32), 52));
  return hslToHex(h, s, Math.min(Math.max(l, 52), 70));
}

// ─── 2) CSS des variables + config Tailwind ──────────────────────────────────

const TOKEN_VARS: Array<[keyof ThemeTokens, string]> = [
  ["bg", "--bg"], ["surface", "--surface"], ["surface2", "--surface-2"],
  ["ink", "--ink"], ["inkMuted", "--ink-muted"], ["line", "--line"],
  ["accent", "--accent"], ["accentInk", "--accent-ink"],
];

function varBlock(t: ThemeTokens): string {
  // Deux formes par token: le hex (pour les styles inline / dégradés) et les
  // canaux RGB (pour que Tailwind gère l'opacité: `bg-surface/60`).
  return TOKEN_VARS.map(([k, v]) => {
    const hex = t[k];
    const [r, g, b] = hexToRgb(hex);
    return `  ${v}: ${hex};\n  ${v}-rgb: ${r} ${g} ${b};`;
  }).join("\n");
}

/** Bloc CSS à injecter dans styles.css: les deux tons du design system. */
export function buildThemeCss(pair: ThemePair): string {
  return `/* ─── Design system en VARIABLES (le bouton clair/sombre agit ici) ─────────
   Toute couleur de fond / texte / bordure d'une page passe par ces tokens
   (classes bg-bg, bg-surface, text-ink, text-ink-muted, border-line, accent).
   Basculer la classe .dark sur <html> rebascule donc TOUT le site d'un coup —
   y compris les zones qu'aucun composant ne restyle explicitement. */
:root {
${varBlock(pair.light)}
  color-scheme: light;
}
html.dark {
${varBlock(pair.dark)}
  color-scheme: dark;
}
html { scroll-behavior: smooth; }
body {
  margin: 0;
  -webkit-font-smoothing: antialiased;
  background-color: var(--bg);
  color: var(--ink);
  transition: background-color .2s ease, color .2s ease;
}
::selection { background: var(--accent); color: var(--accent-ink); }
`;
}

/** Couleurs sémantiques à injecter dans tailwind.config.js. */
export function buildTailwindColors(meta: { primaryColor: string; accentColor: string }): string {
  const rgb = (v: string) => `"rgb(var(${v}-rgb) / <alpha-value>)"`;
  return `        brand: "${meta.primaryColor}",
        // Tokens du thème — réagissent au bouton clair/sombre. À PRIVILÉGIER
        // sur tout hex codé en dur (un hex en dur ne bascule jamais).
        bg: ${rgb("--bg")},
        surface: ${rgb("--surface")},
        "surface-2": ${rgb("--surface-2")},
        ink: ${rgb("--ink")},
        "ink-muted": ${rgb("--ink-muted")},
        line: ${rgb("--line")},
        accent: ${rgb("--accent")},
        "accent-ink": ${rgb("--accent-ink")},`;
}

// ─── 3) Détection: la page réagit-elle vraiment au thème ? ───────────────────

export interface ThemeIssue {
  code: "HARDCODED_BG" | "HARDCODED_INK" | "HARDCODED_LINE" | "NO_DARK_VARIANT" | "INLINE_STATIC_COLOR";
  message: string;
  count: number;
}

export interface ThemeReport {
  file: string;
  score: number;
  issues: ThemeIssue[];
  /** true = le bouton de thème n'aura aucun (ou quasi aucun) effet ici. */
  dead: boolean;
}

/** Classes Tailwind de fond/texte/bordure figées (ni token, ni variante dark:). */
// Note: le `\b` de fin ne peut PAS être commun aux deux formes — après le `]`
// d'une classe arbitraire il n'y a aucune frontière de mot, donc un `\b` final
// ferait silencieusement échouer toute la détection des `bg-[#hex]`.
const STATIC_BG = /\b(?:hover:|focus:|active:|group-hover:)?bg-(?:\[#[0-9a-fA-F]{3,8}\]|(?:white|black|(?:gray|slate|zinc|neutral|stone)-(?:50|100|200|800|900|950))\b)/g;
const STATIC_INK = /\b(?:hover:|focus:|active:|group-hover:)?text-(?:\[#[0-9a-fA-F]{3,8}\]|(?:white|black|(?:gray|slate|zinc|neutral|stone)-(?:100|200|300|400|500|600|700|800|900))\b)/g;
const STATIC_LINE = /\b(?:hover:|focus:|active:|group-hover:)?border-(?:\[#[0-9a-fA-F]{3,8}\]|(?:gray|slate|zinc|neutral|stone)-(?:100|200|300|700|800)\b)/g;

/** Retire les commentaires: du code commenté n'affiche rien. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function classAttrs(src: string): string[] {
  return Array.from(src.matchAll(/class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g))
    .map((m) => m[1] || m[2] || m[3] || "");
}

export function analyzeThemeResponse(file: string, code: string): ThemeReport {
  const src = stripComments(code || "");
  const issues: ThemeIssue[] = [];
  const add = (code: ThemeIssue["code"], message: string, count: number) => {
    if (count > 0) issues.push({ code, message, count });
  };

  // Une couleur figée n'est un problème que si RIEN ne la fait basculer: ni
  // token sémantique, ni variante dark: dans le même attribut class.
  let bgDead = 0, inkDead = 0, lineDead = 0, noDark = 0;
  for (const attr of classAttrs(src)) {
    const hasDarkBg = /\bdark:bg-/.test(attr);
    const hasDarkInk = /\bdark:text-/.test(attr);
    const hasDarkLine = /\bdark:border-/.test(attr);
    const bgs = (attr.match(STATIC_BG) || []).filter((c) => !c.startsWith("dark:")).length;
    const inks = (attr.match(STATIC_INK) || []).filter((c) => !c.startsWith("dark:")).length;
    const lines = (attr.match(STATIC_LINE) || []).filter((c) => !c.startsWith("dark:")).length;
    if (bgs && !hasDarkBg) bgDead += bgs;
    if (inks && !hasDarkInk) inkDead += inks;
    if (lines && !hasDarkLine) lineDead += lines;
    if ((bgs || inks || lines) && !hasDarkBg && !hasDarkInk && !hasDarkLine) noDark++;
  }

  // Couleurs figées dans les styles inline (backgroundColor/color/背景 dégradés):
  // elles n'ont AUCUN équivalent `dark:`, seule une var CSS les rend réactives.
  const inlineStatic = Array.from(
    src.matchAll(/(?:background(?:Color|Image)?|borderColor|(?<![a-zA-Z])color)\s*:\s*"(?![^"]*var\(--)[^"]*#[0-9a-fA-F]{3,8}[^"]*"/g),
  ).length;

  add("HARDCODED_BG", `${bgDead} fond(s) codé(s) en dur sans variante dark: ni token — ces zones ne changent PAS quand on clique sur le bouton de thème. Remplace par bg-bg / bg-surface / bg-surface-2.`, bgDead);
  add("HARDCODED_INK", `${inkDead} couleur(s) de texte figée(s) — remplace par text-ink / text-ink-muted (sinon: texte sombre sur fond sombre en basculant).`, inkDead);
  add("HARDCODED_LINE", `${lineDead} bordure(s) figée(s) — remplace par border-line.`, lineDead);
  add("INLINE_STATIC_COLOR", `${inlineStatic} couleur(s) en style inline sans var(--…) — un style inline ne peut pas avoir de variante dark:. Utilise var(--bg) / var(--surface) / var(--ink) / var(--accent).`, inlineStatic);
  add("NO_DARK_VARIANT", `${noDark} élément(s) entièrement peints en couleurs figées — le thème est inopérant dessus.`, noDark);

  let penalty = 0;
  for (const i of issues) {
    const w = i.code === "NO_DARK_VARIANT" ? 4 : i.code === "HARDCODED_LINE" ? 2 : 5;
    penalty += w * Math.min(i.count, 6);
  }
  const score = Math.max(0, 100 - penalty);
  return { file, score, issues, dead: score < 70 };
}

// ─── 4) Conversion MÉCANIQUE des couleurs figées en tokens ───────────────────

/** Distance perceptuelle grossière (suffit pour « est-ce ce token ? »). */
function dist(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 * 0.3 + (g1 - g2) ** 2 * 0.59 + (b1 - b2) ** 2 * 0.11);
}

type Slot = "bg" | "surface" | "surface-2" | "ink" | "ink-muted" | "line" | "accent" | "accent-ink";

function slotOf(hex: string, t: ThemeTokens): Slot | null {
  const table: Array<[Slot, string]> = [
    ["bg", t.bg], ["surface", t.surface], ["surface-2", t.surface2],
    ["ink", t.ink], ["ink-muted", t.inkMuted], ["line", t.line],
    ["accent", t.accent], ["accent-ink", t.accentInk],
  ];
  let best: Slot | null = null, bestD = Infinity;
  for (const [slot, ref] of table) {
    const d = dist(hex, ref);
    if (d < bestD) { bestD = d; best = slot; }
  }
  // Seuil serré: on ne convertit que ce qui EST une couleur du design system,
  // pas une couleur de contenu (photo, badge de statut, logo…).
  return bestD <= 26 ? best : null;
}

/** Classes Tailwind neutres → token équivalent, quand rien ne les fait basculer. */
const NEUTRAL_MAP: Record<string, Slot> = {
  white: "surface", black: "ink",
  "50": "bg", "100": "surface-2", "200": "line", "300": "line",
  "400": "ink-muted", "500": "ink-muted", "600": "ink-muted",
  "700": "ink", "800": "ink", "900": "ink", "950": "bg",
};

export interface TokenizeResult { code: string; replaced: number }

/**
 * Rend une page réactive au thème SANS appel modèle: chaque couleur du design
 * system codée en dur devient le token sémantique correspondant. Déterministe,
 * et volontairement conservateur — une couleur qui n'appartient pas à la
 * palette (statut, illustration, marque tierce) n'est jamais touchée.
 */
export function tokenizeTheme(code: string, pair: ThemePair): TokenizeResult {
  if (!code) return { code, replaced: 0 };
  const t = pair[pair.designed];
  let replaced = 0;

  let out = code;

  // a) Classes arbitraires `bg-[#hex]` / `text-[#hex]` / `border-[#hex]`…
  out = out.replace(
    /\b(bg|text|border|ring|divide|fill|stroke|from|via|to|decoration|outline|shadow|caret|accent)-\[(#[0-9a-fA-F]{3,8})\](\/\d{1,3})?/g,
    (m, util: string, hex: string, op?: string) => {
      const n = normHex(hex.length === 9 ? hex.slice(0, 7) : hex);
      if (!n) return m;
      const slot = slotOf(n, t);
      if (!slot) return m;
      replaced++;
      return `${util}-${slot}${op || ""}`;
    },
  );

  // b) Classes neutres figées (bg-white, text-gray-900, border-gray-200…) —
  //    uniquement quand l'attribut n'a AUCUNE variante dark: pour cet
  //    utilitaire (sinon la page gère déjà son basculement à la main).
  out = out.replace(/class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (m, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? "";
    const q = dq !== undefined ? '"' : "'";
    const key = m.slice(0, m.indexOf("=")).trim();
    let changed = false;
    const next = raw.replace(
      /\b(bg|text|border|divide|ring)-(white|black|(?:gray|slate|zinc|neutral|stone)-(?:50|100|200|300|400|500|600|700|800|900|950))\b/g,
      (cm, util: string, tone: string) => {
        if (new RegExp(`\\bdark:${util}-`).test(raw)) return cm; // déjà géré
        const shade = tone.includes("-") ? tone.split("-")[1] : tone;
        const slot = NEUTRAL_MAP[shade];
        if (!slot) return cm;
        // Cohérence sémantique: un fond ne devient pas de l'encre.
        const isInk = slot === "ink" || slot === "ink-muted";
        if ((util === "bg" && isInk) || (util === "text" && !isInk && slot !== "accent")) {
          const fb: Slot = util === "bg" ? "surface" : "ink";
          changed = true; replaced++;
          return `${util}-${fb}`;
        }
        changed = true; replaced++;
        return `${util}-${slot}`;
      },
    );
    return changed ? `${key}=${q}${next}${q}` : m;
  });

  // c) Styles inline: hex du design system → var(--token), y compris dans les
  //    dégradés (mesh gradients) où aucune variante dark: n'est possible.
  out = out.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => {
    const n = normHex(hex);
    if (!n) return hex;
    const slot = slotOf(n, t);
    if (!slot) return hex;
    replaced++;
    return `var(--${slot})`;
  });
  // Les classes Tailwind arbitraires ne supportent pas var() sans préfixe:
  // si l'étape (c) a touché l'intérieur d'un `bg-[...]`, on répare.
  out = out.replace(/\b(bg|text|border|ring|divide|fill|stroke|from|via|to|decoration|outline|shadow|caret|accent)-\[var\((--[a-z0-9-]+)\)\]/g,
    (_m, util: string, v: string) => `${util}-${v.replace(/^--/, "")}`);

  // d) rgba() issues de la palette → couleur du token avec la même opacité.
  out = out.replace(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)/g, (m, r, g, b, a) => {
    const hex = "#" + [r, g, b].map((v: string) => Number(v).toString(16).padStart(2, "0")).join("").toUpperCase();
    const n = normHex(hex);
    if (!n) return m;
    const slot = slotOf(n, t);
    if (!slot) return m;
    replaced++;
    return `rgb(var(--${slot}-rgb)${a !== undefined ? ` / ${a}` : ""})`;
  });

  return { code: out, replaced };
}

// ─── 5) Règles injectées dans les prompts de génération ──────────────────────

export const THEME_TOKEN_RULES = `## 🌓 THÈME CLAIR/SOMBRE — IL DOIT RÉELLEMENT FONCTIONNER
Le site a un bouton clair/sombre (<ThemeToggle/> dans le Header). Le bug le plus visible d'un site généré: on clique, et rien ne change — ou seulement le header. Cause: des couleurs codées en dur. Une couleur en dur NE BASCULE JAMAIS.

Le design system est exposé en TOKENS qui basculent tout seuls. Utilise-les pour TOUTE couleur de fond, de texte et de bordure:
- Fonds: \`bg-bg\` (fond de page), \`bg-surface\` (carte/panneau), \`bg-surface-2\` (zone en retrait)
- Texte: \`text-ink\` (titres/corps), \`text-ink-muted\` (secondaire, légendes)
- Bordures/séparateurs: \`border-line\`, \`divide-line\`
- Accent: \`bg-accent\`, \`text-accent\`, \`border-accent\`, et \`text-accent-ink\` pour le texte POSÉ SUR l'accent
- Opacités disponibles comme d'habitude: \`bg-surface/60\`, \`border-line/50\`…
- En style inline (mesh gradients, box-shadow, backgroundImage): \`var(--bg)\`, \`var(--surface)\`, \`var(--ink)\`, \`var(--accent)\`, ou \`rgb(var(--accent-rgb) / 0.15)\` pour une transparence.

INTERDIT (c'est exactement ce qui casse le bouton de thème):
- \`bg-[#0B0D0E]\`, \`text-[#E9EDEF]\`, \`border-[#242A2E]\` — aucun hex de la palette en dur.
- \`bg-white\`, \`bg-black\`, \`text-gray-900\`, \`bg-neutral-900\`, \`border-gray-200\` sans variante \`dark:\`.
- \`style={{ background: "#0B0D0E" }}\` ou \`color: "#fff"\` — passe par \`var(--…)\`.
- Mélanger un fond clair en dur et un fond sombre en dur dans la même page (header clair sur page sombre).

Les tokens sont déjà calés pour le contraste dans LES DEUX tons: en écrivant \`bg-surface text-ink\`, la lisibilité est garantie en clair comme en sombre, sans que tu aies à écrire une seule variante \`dark:\`. Réserve \`dark:\` aux ajustements fins et volontaires (ex: \`dark:opacity-40\` sur un bloom coloré, \`shadow-lg dark:shadow-none\`).
Une couleur qui n'appartient PAS au thème (photo, logo tiers, code couleur de statut métier) reste évidemment libre.`;
