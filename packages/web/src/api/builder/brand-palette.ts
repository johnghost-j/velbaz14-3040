// ─── PALETTE DE MARQUE : UNE SEULE SOURCE DE VÉRITÉ POUR LE LOGO ET LE SITE ──
//
// Pourquoi ce module existe (demande utilisateur, 2026-09-25) :
//
//   « le site doit suivre l'idée du logo et le logo l'idée du site, ça ne doit
//     pas être des couleurs différentes, par exemple un logo rouge et un site
//     bleu »
//
// C'est exactement ce qui se produisait, et par construction : les couleurs du
// logo et celles du site étaient décidées par DEUX appels IA indépendants qui
// ne se voyaient pas.
//
//   logo : designLogoBrief()   → invente sa propre palette (1-2 hex)
//   site : engine.ts           → design system IA + fetchDesignTokens, puis
//                                deAiPalette() qui peut encore TOUT remplacer
//                                par une palette d'industrie déterministe
//
// Deux tirages indépendants : rien ne garantissait la moindre parenté. Et la
// palette que l'utilisateur VALIDE dans l'aperçu de marque (stockée en
// `designAssets type='brand_guidelines'` avec `lockedByUser: true`) n'était
// jamais relue par le build.
//
// Le principe retenu ici : **le logo est la vérité terrain**. C'est le seul
// élément que l'utilisateur voit réellement dans l'en-tête, le pied de page et
// l'onglet du navigateur ; c'est donc lui qui décide de la teinte du site, et
// pas l'inverse. Ses couleurs sont MESURÉES sur ses pixels (`extractLogoColors`),
// pas devinées : aucun appel IA, résultat identique à chaque build.
//
// Ordre de priorité :
//   1. palette verrouillée par l'utilisateur, quand elle est cohérente avec le
//      logo (même famille de teinte) — ses hex sont mieux choisis pour l'UI ;
//   2. couleurs réellement mesurées sur le logo ;
//   3. palette des brand_guidelines générées par l'IA, à défaut de logo.
//
// `alignDesignToBrand()` applique ensuite cette palette au design du site
// APRÈS `deAiPalette()` (sinon elle serait écrasée), en faisant pivoter la
// TEINTE des neutres teintés vers celle de la marque et en ne touchant jamais
// aux luminosités — c'est ce qui garantit les contrastes déjà validés.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../database/index";
import * as schema from "../database/schema";
import { extractLogoColorsFromDataUri } from "./logo-image";
import { hexToHsl, hslToHex, isDarkHex, normHex, type DesignColors } from "./theme-tokens";

export type BrandPaletteSource = "user" | "logo" | "guidelines";

export interface BrandPalette {
  /** Couleur maîtresse de la marque (celle qui domine le logo). */
  primary: string;
  /** Couleur secondaire, garantie perceptiblement différente de `primary`. */
  accent: string;
  /** Toutes les couleurs retenues, de la plus présente à la moins présente. */
  colors: string[];
  source: BrandPaletteSource;
}

/** Écart de teinte sur le cercle chromatique (0-180). */
export const hueGap = (a: string, b: string): number => {
  const d = Math.abs(hexToHsl(a).h - hexToHsl(b).h) % 360;
  return d > 180 ? 360 - d : d;
};

/** Une couleur porte-t-elle une teinte identifiable (≠ noir/blanc/gris) ? */
export const isChromatic = (hex: string): boolean => {
  const { s, l } = hexToHsl(hex);
  return s >= 18 && l >= 8 && l <= 92;
};

/**
 * Force de la teinte telle qu'on la PERÇOIT, et non la saturation HSL brute.
 *
 * La saturation seule trompe aux extrêmes de luminosité : `#FAFAF9` affiche
 * 9 % de saturation et `#17171A` 6 %, alors que l'œil n'y voit que du blanc
 * cassé et du presque-noir. Pondérer par la distance au blanc/noir sépare ces
 * neutres assumés d'un vrai fond teinté comme `#0B1220` (bleu nuit, ~8).
 */
export const tintStrength = (hex: string): number => {
  const { s, l } = hexToHsl(hex);
  return s * (1 - Math.abs((2 * l) / 100 - 1));
};

/** En dessous : neutre assumé (blanc cassé, presque-noir) → on n'y touche pas. */
export const NEUTRAL_TINT_MAX = 2.5;

const uniq = (list: string[]): string[] => {
  const out: string[] = [];
  for (const raw of list) {
    const hex = normHex(raw);
    if (hex && !out.includes(hex)) out.push(hex);
  }
  return out;
};

export interface GuidelinesPalette {
  colors: string[];
  lockedByUser: boolean;
}

/**
 * Hex d'un enregistrement `brand_guidelines`, quelle que soit sa forme.
 *
 * Trois écritures coexistent en base : la palette validée par l'utilisateur
 * (`{ colors: {primary,…}, palette: [...], lockedByUser: true }`) et deux
 * variantes produites par l'IA, dont une où `colors` contient des valeurs
 * décrites en texte (« deep navy #1B2A4A »). On ratisse donc le JSON et, en
 * dernier recours, le texte brut : mieux vaut récupérer les hex que d'échouer
 * sur une forme non prévue.
 */
export function hexesFromGuidelines(content: string): GuidelinesPalette {
  const raw = (content || "").trim();
  if (!raw) return { colors: [], lockedByUser: false };

  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Pas du JSON (ou du JSON dans un bloc markdown) : on se rabat sur le texte.
  }

  const ordered: string[] = [];
  if (parsed && typeof parsed === "object") {
    const c = parsed.colors;
    // Ordre sémantique d'abord : primary est la couleur de marque.
    if (c && typeof c === "object" && !Array.isArray(c)) {
      for (const key of ["primary", "secondary", "accent", "neutral"]) {
        if (typeof c[key] === "string") ordered.push(...matchHexes(c[key]));
      }
      for (const v of Object.values(c)) if (typeof v === "string") ordered.push(...matchHexes(v));
    } else if (Array.isArray(c)) {
      for (const v of c) if (typeof v === "string") ordered.push(...matchHexes(v));
    }
    if (Array.isArray(parsed.palette)) {
      for (const v of parsed.palette) if (typeof v === "string") ordered.push(...matchHexes(v));
    }
  }
  if (!ordered.length) ordered.push(...matchHexes(raw));

  return {
    colors: uniq(ordered),
    lockedByUser: parsed?.lockedByUser === true,
  };
}

const matchHexes = (s: string): string[] => s.match(/#[0-9a-fA-F]{3,8}\b/g) || [];

/**
 * Compose la palette de marque à partir des couleurs mesurées sur le logo et
 * des brand_guidelines.
 *
 * Le cas intéressant est le désaccord : palette verrouillée bleue, logo rouge.
 * On suit alors le LOGO, parce que c'est lui qui s'affiche dans l'en-tête — un
 * site bleu autour d'un logo rouge est précisément le défaut signalé. La
 * palette verrouillée n'est préférée que quand elle parle de la même teinte
 * (≤ 30° d'écart) : ses hex sont alors un meilleur choix d'interface que la
 * moyenne des pixels d'un aplat.
 */
export function buildBrandPalette(input: {
  logoColors?: string[] | null;
  guidelines?: GuidelinesPalette | null;
}): BrandPalette | null {
  const logo = uniq(input.logoColors || []);
  const guide = uniq(input.guidelines?.colors || []);
  const locked = input.guidelines?.lockedByUser === true;

  const logoHead = logo.find(isChromatic) || logo[0];
  const guideHead = guide.find(isChromatic) || guide[0];

  let ordered: string[];
  let source: BrandPaletteSource;
  if (logoHead && guideHead && locked && hueGap(logoHead, guideHead) <= 30) {
    // Accord : on garde la palette utilisateur, complétée par le logo.
    ordered = uniq([guideHead, ...guide, ...logo]);
    source = "user";
  } else if (logoHead) {
    // Le logo décide. Les couleurs de la palette qui restent dans sa famille
    // servent de secondaires ; les autres sont écartées (c'est justement le
    // bleu qui n'avait rien à faire autour d'un logo rouge).
    const compatible = guide.filter((h) => hueGap(h, logoHead) <= 40 || !isChromatic(h));
    ordered = uniq([logoHead, ...logo, ...compatible]);
    source = "logo";
  } else if (guideHead) {
    // Pas encore de logo (génération asynchrone, ~40 s) : la palette fait foi.
    ordered = uniq([guideHead, ...guide]);
    source = locked ? "user" : "guidelines";
  } else {
    return null; // Rien de fiable : on laisse le design faire son travail.
  }

  const primary = ordered[0];
  // Un accent identique au primary ne se voit pas. On cherche une couleur
  // vraiment distincte, sinon on la dérive en décalant la teinte.
  const accent =
    ordered.slice(1).find((h) => hueGap(h, primary) >= 25 && isChromatic(h)) ||
    ordered.slice(1).find((h) => Math.abs(hexToHsl(h).l - hexToHsl(primary).l) >= 18) ||
    deriveAccent(primary);

  return { primary, accent, colors: uniq([primary, accent, ...ordered]), source };
}

/** Accent dérivé : teinte voisine, luminosité corrigée pour rester lisible. */
export function deriveAccent(primary: string): string {
  const { h, s, l } = hexToHsl(primary);
  if (s < 18) {
    // Marque neutre (logo noir & blanc) : l'accent reste neutre, en contraste
    // de valeur. Inventer une teinte ici trahirait la marque.
    return hslToHex(h, s, l > 50 ? Math.max(12, l - 40) : Math.min(92, l + 40));
  }
  return hslToHex((h + 28) % 360, Math.min(92, s + 6), Math.min(62, Math.max(38, l)));
}

/**
 * Palette de marque d'une entreprise : logo mesuré + guidelines en base.
 * Best-effort, ne jette jamais — un build ne doit pas échouer pour une couleur.
 */
export async function loadBrandPalette(companyId: string): Promise<BrandPalette | null> {
  if (!companyId) return null;
  try {
    const [logoAsset, guideAsset] = await Promise.all([
      db.select({ content: schema.designAssets.content }).from(schema.designAssets)
        .where(and(eq(schema.designAssets.companyId, companyId), eq(schema.designAssets.type, "logo")))
        .orderBy(desc(schema.designAssets.createdAt)).limit(1).get().catch(() => null),
      db.select({ content: schema.designAssets.content }).from(schema.designAssets)
        .where(and(eq(schema.designAssets.companyId, companyId), eq(schema.designAssets.type, "brand_guidelines")))
        .orderBy(desc(schema.designAssets.createdAt)).limit(1).get().catch(() => null),
    ]);

    const logoColors = logoAsset?.content ? await extractLogoColorsFromDataUri(logoAsset.content, 4) : [];
    const guidelines = guideAsset?.content ? hexesFromGuidelines(guideAsset.content) : null;

    // La palette verrouillée par l'utilisateur peut être plus ancienne que la
    // dernière génération de guidelines IA : on la cherche explicitement.
    let merged = guidelines;
    if (!merged?.lockedByUser) {
      const lockedRow = await db.select({ content: schema.designAssets.content }).from(schema.designAssets)
        .where(and(eq(schema.designAssets.companyId, companyId), eq(schema.designAssets.type, "brand_guidelines")))
        .orderBy(desc(schema.designAssets.createdAt)).all().catch(() => [] as any[]);
      for (const row of lockedRow) {
        const g = hexesFromGuidelines(row?.content || "");
        if (g.lockedByUser && g.colors.length) { merged = g; break; }
      }
    }

    return buildBrandPalette({ logoColors, guidelines: merged });
  } catch {
    return null;
  }
}

export interface AlignResult {
  colors: DesignColors;
  /** Clés réellement modifiées (vide = le design était déjà cohérent). */
  changed: string[];
}

/**
 * Aligne les couleurs du site sur la marque.
 *
 * Ce qui est imposé : `primary` et `accent` — ce sont les couleurs de marque,
 * elles doivent être CELLES du logo.
 * Ce qui est seulement corrigé : les neutres teintés (fond, surface, bordure,
 * texte). On ne fait PIVOTER que leur teinte quand elle contredit la marque
 * (> 40° d'écart) ; saturation et luminosité sont conservées, donc tous les
 * contrastes déjà validés par `deriveThemePair()` le restent. Un fond
 * volontairement neutre (saturation < 6) n'est pas touché : un site noir et
 * blanc avec un logo rouge est un choix de design valable, pas une erreur.
 */
export function alignDesignToBrand(design: DesignColors | null | undefined, brand: BrandPalette | null): AlignResult {
  const colors: DesignColors = { ...(design || {}) };
  if (!brand) return { colors, changed: [] };

  const changed: string[] = [];
  const set = (key: string, value: string) => {
    if (normHex(colors[key] as string) === value) return;
    colors[key] = value;
    changed.push(key);
  };

  set("primary", brand.primary);
  set("accent", brand.accent);

  const brandHue = hexToHsl(brand.primary).h;
  const brandSat = hexToHsl(brand.primary).s;
  for (const key of ["background", "surface", "text", "muted", "border"]) {
    const hex = normHex(colors[key] as string);
    if (!hex) continue;
    const { s, l } = hexToHsl(hex);
    if (tintStrength(hex) < NEUTRAL_TINT_MAX) continue; // neutre assumé : rien à recaler
    if (hueGap(hex, brand.primary) <= 40) continue; // déjà dans la famille
    // Teinte de la marque, saturation plafonnée (un fond ne doit pas devenir
    // un aplat de marque), luminosité intacte → contraste intact.
    set(key, hslToHex(brandHue, Math.min(s, Math.max(6, Math.round(brandSat * 0.35))), l));
  }

  return { colors, changed };
}

/**
 * Consigne textuelle passée au design system IA, pour qu'il PARTE des couleurs
 * de la marque au lieu d'en inventer d'autres qu'il faudra corriger après coup.
 * (La correction déterministe reste appliquée derrière : le prompt aide, il ne
 * garantit rien.)
 */
export function brandPaletteInstruction(brand: BrandPalette | null): string {
  if (!brand) return "";
  const tone = isDarkHex(brand.primary) ? "sombre" : "claire";
  return [
    `## 🎨 COULEURS DE MARQUE — NON NÉGOCIABLES`,
    `Le logo de cette entreprise est DÉJÀ créé et sa couleur dominante est ${brand.primary} (${tone}).`,
    `- primary DOIT être ${brand.primary}`,
    `- accent DOIT être ${brand.accent}`,
    brand.colors.length > 2 ? `- palette complète du logo : ${brand.colors.join(", ")}` : "",
    `- fond / surfaces / bordures : neutres, ou TEINTÉS de cette même teinte.`,
    `- INTERDIT : une couleur d'une autre famille chromatique (un logo rouge sur un site bleu est un défaut signalé par l'utilisateur).`,
  ].filter(Boolean).join("\n");
}
