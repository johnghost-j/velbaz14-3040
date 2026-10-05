/**
 * RE-THÈME D'UN SITE DÉJÀ CONSTRUIT (cohérence logo ↔ site, après coup).
 *
 * Le problème réel : quand l'utilisateur change SON LOGO en cours de projet
 * (« change le logo »), l'ancien code ne touchait que `src/lib/brand.ts`
 * (LOGO_URL) et le favicon dans `index.html`. Les COULEURS du site restaient
 * celles du build initial → nouveau logo rouge posé sur un site resté bleu,
 * exactement ce que l'utilisateur ne veut pas.
 *
 * Ce module reteinte les fichiers de thème d'un projet EXISTANT à partir d'une
 * palette de marque. Il est volontairement :
 *  - DÉTERMINISTE (aucune IA, aucun réseau) ;
 *  - CHIRURGICAL : il ne réécrit QUE les déclarations de variables déjà
 *    présentes et le `brand:` de Tailwind. Tout le CSS ajouté par l'IA ou par
 *    l'utilisateur (animations, media queries, classes maison) est préservé
 *    à l'octet près ;
 *  - non destructif : si un fichier n'a pas la forme attendue, il est rendu
 *    inchangé plutôt que remplacé par un fichier neuf (on ne perd jamais le
 *    travail existant).
 */

import {
  deriveThemePair,
  hexToRgb,
  normHex,
  type DesignColors,
  type ThemePair,
  type ThemeTokens,
} from "./theme-tokens";
import type { BrandPalette } from "./brand-palette";
import { alignDesignToBrand } from "./brand-palette";

/** Les mêmes paires (token → variable CSS) que celles écrites par le scaffold. */
const TOKEN_VARS: Array<[keyof ThemeTokens, string]> = [
  ["bg", "--bg"], ["surface", "--surface"], ["surface2", "--surface-2"],
  ["ink", "--ink"], ["inkMuted", "--ink-muted"], ["line", "--line"],
  ["accent", "--accent"], ["accentInk", "--accent-ink"],
];

/**
 * Trouve le corps d'un bloc CSS (`:root { … }`) en équilibrant les accolades,
 * ce qui reste correct même si le bloc contient des sous-blocs.
 * Rend `null` si le sélecteur est absent ou le bloc non fermé.
 */
export function findBlock(css: string, selector: string): { start: number; end: number } | null {
  // Le sélecteur peut être suivi d'espaces/retours avant `{`.
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m");
  const m = re.exec(css);
  if (!m) return null;
  const open = m.index + m[0].length;
  let depth = 1;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i };
    }
  }
  return null;
}

/**
 * Réécrit, DANS un corps de bloc, les valeurs des variables de thème. Les
 * déclarations absentes ne sont PAS ajoutées : on ne fait que corriger ce qui
 * existe, pour ne jamais casser un fichier restructuré à la main.
 */
function retintBlockBody(body: string, tokens: ThemeTokens): { body: string; changed: number } {
  let out = body;
  let changed = 0;
  for (const [key, cssVar] of TOKEN_VARS) {
    const hex = normHex(tokens[key]);
    if (!hex) continue;
    const [r, g, b] = hexToRgb(hex);
    // `--bg-rgb` d'abord : sinon le motif de `--bg` matcherait aussi son préfixe.
    const rgbRe = new RegExp(`(${cssVar}-rgb\\s*:\\s*)([^;\\n}]+)`, "g");
    const rgbVal = `${r} ${g} ${b}`;
    out = out.replace(rgbRe, (m0, head: string, val: string) => {
      if (val.trim() === rgbVal) return m0; // déjà à jour → pas un changement
      changed++;
      return `${head}${rgbVal}`;
    });
    const hexRe = new RegExp(`(${cssVar}\\s*:\\s*)(?!.*-rgb)([^;\\n}]+)`, "g");
    out = out.replace(hexRe, (m0, head: string, val: string) => {
      // Ne pas re-toucher la ligne `-rgb` déjà traitée.
      if (/-rgb\s*:/.test(m0)) return m0;
      if (val.trim() === hex) return m0;
      changed++;
      return `${head}${hex}`;
    });
  }
  return { body: out, changed };
}

export interface RetintCssResult { css: string; changed: number }

/**
 * Reteinte `src/styles.css` : le bloc `:root` prend le ton clair, `html.dark`
 * le ton sombre. Le reste du fichier est intouché.
 */
export function retintThemeCss(css: string, pair: ThemePair): RetintCssResult {
  if (!css) return { css, changed: 0 };
  let out = css;
  let changed = 0;
  for (const [selector, tokens] of [[":root", pair.light], ["html.dark", pair.dark]] as const) {
    const block = findBlock(out, selector);
    if (!block) continue;
    const body = out.slice(block.start, block.end);
    const res = retintBlockBody(body, tokens);
    if (res.changed) {
      out = out.slice(0, block.start) + res.body + out.slice(block.end);
      changed += res.changed;
    }
  }
  return { css: out, changed };
}

/**
 * Reteinte `tailwind.config.js`. Seul `brand:` porte un hex en dur ; les autres
 * tokens pointent sur les variables CSS (déjà reteintées ci-dessus) et n'ont
 * donc RIEN à changer ici.
 */
export function retintTailwindConfig(js: string, primary: string): RetintCssResult {
  const hex = normHex(primary);
  if (!js || !hex) return { css: js, changed: 0 };
  let changed = 0;
  const out = js.replace(/(\bbrand\s*:\s*)(["'])(#[0-9a-fA-F]{3,8})\2/g, (m0, head: string, q: string, old: string) => {
    if (old.toUpperCase() === hex.toUpperCase()) return m0;
    changed++;
    return `${head}${q}${hex}${q}`;
  });
  return { css: out, changed };
}

/**
 * Met à jour la palette dans `.velbaz/design.json`, le design system que les
 * éditions de chat suivantes relisent. Sans ça, la prochaine édition
 * régénérerait des composants avec les ANCIENNES couleurs et le site
 * redeviendrait incohérent avec le logo.
 */
export function retintDesignJson(json: string, brand: BrandPalette): RetintCssResult {
  if (!json) return { css: json, changed: 0 };
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return { css: json, changed: 0 };
    const aligned = alignDesignToBrand(parsed.colors as DesignColors | undefined, brand);
    if (!aligned.changed.length) return { css: json, changed: 0 };
    const next = { ...parsed, colors: aligned.colors };
    return { css: JSON.stringify(next, null, 2), changed: aligned.changed.length };
  } catch {
    return { css: json, changed: 0 };
  }
}

export interface ProjectFileLike { path: string; content: string }
export interface RetintFilesResult {
  files: ProjectFileLike[];
  /** Palette de thème réellement appliquée (utile pour journaliser/tester). */
  pair: ThemePair;
}

const isStylesCss = (p: string) => /(^|\/)src\/styles\.css$/.test(p) || p.endsWith("src/styles.css");
const isTailwindConfig = (p: string) => /(^|\/)tailwind\.config\.(js|cjs|mjs|ts)$/.test(p);
const isDesignJson = (p: string) => /(^|\/)\.velbaz\/design\.json$/.test(p);

/**
 * Point d'entrée : rend UNIQUEMENT les fichiers dont le contenu change.
 * `currentColors` (la palette du design system existant) sert de base pour
 * conserver les neutres/typo déjà calibrés ; seule la marque est imposée.
 */
export function retintProjectFiles(
  files: ProjectFileLike[],
  brand: BrandPalette,
  currentColors?: DesignColors | null,
): RetintFilesResult {
  const aligned = alignDesignToBrand(currentColors, brand);
  const pair = deriveThemePair(aligned.colors);
  const out: ProjectFileLike[] = [];
  for (const f of files) {
    const content = f.content || "";
    let next = content;
    if (isStylesCss(f.path)) next = retintThemeCss(content, pair).css;
    else if (isTailwindConfig(f.path)) next = retintTailwindConfig(content, aligned.colors.primary).css;
    else if (isDesignJson(f.path)) next = retintDesignJson(content, brand).css;
    else continue;
    if (next !== content) out.push({ path: f.path, content: next });
  }
  return { files: out, pair };
}

/** Lit les couleurs du design system depuis le contenu de `.velbaz/design.json`. */
export function designColorsFromJson(json: string | undefined | null): DesignColors | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    const colors = parsed?.colors;
    return colors && typeof colors === "object" ? (colors as DesignColors) : null;
  } catch {
    return null;
  }
}
