// ─── LOGO : DÉTOURAGE (PNG TRANSPARENT) + COULEURS RÉELLES DE LA MARQUE ─────
//
// Pourquoi ce module existe (demande utilisateur, 2026-09-25) :
//
//   « le logo mis dans le site ne doit pas avoir de background (blanc ou noir
//     ou autre), ça doit être en PNG »
//
// Le modèle image ne sait pas produire un canal alpha : tous les prompts de logo
// (`LOGO_HARD_RULES`) demandent au contraire un fond BLANC UNI, parce que c'est
// le seul fond qu'on puisse retirer de façon fiable. Rien ne le retirait ensuite :
// le logo arrivait donc dans `src/lib/brand.ts` (header/footer) et dans le
// favicon avec son carré blanc — immédiatement visible dès que le site a un
// header sombre, et systématiquement visible sur l'onglet du navigateur.
//
// Ce module fait les deux moitiés manquantes :
//
//  1. `makeLogoTransparent()` — détourage DÉTERMINISTE (aucun appel IA, aucun
//     réseau) : le fond quasi-blanc devient réellement transparent et l'image
//     est ré-encodée en PNG (un JPEG ne PEUT PAS porter de transparence, donc le
//     ré-encodage est obligatoire même quand rien n'est détouré).
//
//  2. `extractLogoColors()` — les couleurs DOMINANTES RÉELLES du logo, mesurées
//     sur ses pixels. C'est la vérité terrain qui permet au site de suivre la
//     couleur du logo (cf. `brand-palette.ts`), plutôt que deux appels IA
//     indépendants qui produisaient un logo rouge sur un site bleu.
//
// Choix d'algorithme, et pourquoi :
//  - Le fond est retiré par PROPAGATION DEPUIS LES BORDS (flood fill), pas par
//    un simple « tout ce qui est blanc dégage ». Un seuil global mange les
//    aplats clairs de la marque elle-même ; la propagation ne peut atteindre que
//    ce qui est réellement connecté au bord, donc le symbole n'est jamais rongé.
//  - Le blanc INTÉRIEUR (contre-formes d'un logo en négatif, intérieur d'un
//    anneau) est retiré à un seuil PLUS STRICT : ces zones doivent être des
//    trous, sinon le logo garde des taches blanches sur un header sombre.
//  - Les bords anti-aliasés reçoivent une alpha PROGRESSIVE, sinon le logo
//    garde un halo blanc dentelé (le défaut classique du détourage au seuil).
//  - Garde-fous : si le détourage ne retire rien, ou s'il retire presque tout
//    (fond non blanc, logo blanc sur fond coloré…), on ABANDONNE et on renvoie
//    l'image d'origine ré-encodée en PNG. Mieux vaut le fond d'origine qu'un
//    logo effacé.

import { getSharp } from "../lib/optional-import";
import { hexToHsl, normHex } from "./theme-tokens";

export interface RawImage {
  data: string; // base64
  mimeType: string;
}

/** Seuils du détourage. Exportés pour que les tests parlent des mêmes valeurs. */
export const CUTOUT = {
  /** Un pixel du BORD est du fond au-delà de cette clarté minimale (canal le plus sombre). */
  bgMin: 236,
  /** Écart max entre canaux : au-delà, la couleur est teintée donc ce n'est pas du blanc. */
  neutralTol: 18,
  /** Le blanc INTÉRIEUR (non connecté au bord) exige un blanc plus franc. */
  innerMin: 246,
  /** Bords anti-aliasés : en dessous de cette clarté, le pixel reste 100 % opaque. */
  softMin: 198,
  /** Rayon de recherche de la couleur « pure » de la marque, pour démater un bord. */
  refRadius: 4,
  /** Marge laissée autour de la marque après recadrage, en % du plus grand côté. */
  padRatio: 0.06,
  /** Abandon si moins que ça de la surface reste opaque (on aurait effacé le logo). */
  minOpaqueRatio: 0.01,
} as const;

export interface CutoutResult {
  /** PNG (avec canal alpha quand le détourage a réussi). */
  buf: Buffer;
  width: number;
  height: number;
  /** Proportion de pixels rendus transparents. */
  keyedRatio: number;
  /** Proportion de pixels restés (au moins partiellement) opaques. */
  opaqueRatio: number;
  /** true = détourage abandonné par garde-fou ; l'image est seulement ré-encodée en PNG. */
  reverted: boolean;
  reason: string;
}

const isNeutralLight = (r: number, g: number, b: number, min: number, tol: number): boolean => {
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b);
  return lo >= min && hi - lo <= tol;
};

/**
 * Retire le fond quasi-blanc d'une image de logo et renvoie un PNG à canal alpha.
 *
 * Ne jette jamais : toute erreur (sharp absent, image illisible) remonte en
 * `reverted` avec l'entrée telle quelle, parce qu'un logo au fond blanc reste
 * infiniment préférable à pas de logo du tout.
 */
export async function cutoutLogoBackground(input: Buffer): Promise<CutoutResult> {
  const fallback = async (reason: string): Promise<CutoutResult> => {
    try {
      const sharp = await getSharp();
      const out = await sharp(input).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
      const m = await sharp(out).metadata();
      return { buf: out, width: m.width || 0, height: m.height || 0, keyedRatio: 0, opaqueRatio: 1, reverted: true, reason };
    } catch {
      return { buf: input, width: 0, height: 0, keyedRatio: 0, opaqueRatio: 1, reverted: true, reason: `${reason} (ré-encodage PNG impossible)` };
    }
  };

  let sharp: any;
  try {
    sharp = await getSharp();
  } catch {
    return fallback("sharp indisponible");
  }
  if (!sharp) return fallback("sharp indisponible");

  let px: Buffer;
  let width = 0;
  let height = 0;
  try {
    const raw = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    px = raw.data as Buffer;
    width = raw.info.width;
    height = raw.info.height;
    if (raw.info.channels !== 4) return fallback("image sans canal alpha exploitable");
  } catch {
    return fallback("image illisible");
  }
  const n = width * height;
  if (n === 0) return fallback("image vide");

  // ── 1) Propagation depuis les bords : le VRAI fond, celui qui touche le cadre.
  const bg = new Uint8Array(n); // 1 = fond
  const stack = new Int32Array(n);
  let sp = 0;
  const pushIfBg = (i: number) => {
    if (bg[i]) return;
    const o = i * 4;
    if (px[o + 3] < 8) { bg[i] = 1; return; } // déjà transparent → c'est du fond
    if (!isNeutralLight(px[o], px[o + 1], px[o + 2], CUTOUT.bgMin, CUTOUT.neutralTol)) return;
    bg[i] = 1;
    stack[sp++] = i;
  };
  for (let x = 0; x < width; x++) {
    pushIfBg(x);
    pushIfBg((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    pushIfBg(y * width);
    pushIfBg(y * width + width - 1);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) pushIfBg(i - 1);
    if (x < width - 1) pushIfBg(i + 1);
    if (y > 0) pushIfBg(i - width);
    if (y < height - 1) pushIfBg(i + width);
  }

  // ── 2) Blanc INTÉRIEUR (contre-formes) : seuil plus strict, sans connectivité.
  //     Un logo en négatif doit laisser voir le fond du site à travers ses trous,
  //     sinon il traîne des taches blanches sur un header sombre.
  for (let i = 0; i < n; i++) {
    if (bg[i]) continue;
    const o = i * 4;
    if (px[o + 3] < 8) { bg[i] = 1; continue; }
    if (isNeutralLight(px[o], px[o + 1], px[o + 2], CUTOUT.innerMin, 10)) bg[i] = 1;
  }

  let keyed = 0;
  for (let i = 0; i < n; i++) if (bg[i]) keyed++;
  if (keyed === 0) return fallback("aucun fond blanc détecté");
  const opaqueRatio = (n - keyed) / n;
  if (opaqueRatio < CUTOUT.minOpaqueRatio) {
    return fallback(`détourage abandonné (il ne resterait que ${(opaqueRatio * 100).toFixed(1)} % de l'image)`);
  }

  // ── 3) Application : fond → alpha 0, puis DÉMATAGE de la bande de bord.
  for (let i = 0; i < n; i++) {
    if (!bg[i]) continue;
    px[i * 4 + 3] = 0;
  }

  // Bande de bord : les pixels anti-aliasés, à 1 ou 2 px du fond. Ce sont des
  // MÉLANGES entre la couleur de la marque et le blanc du fond. Les laisser
  // opaques cerne le logo d'un liseré clair (le fameux « halo » visible dès
  // qu'on le pose sur un header sombre) ; leur baisser l'alpha sans corriger
  // leur couleur laisse ce même liseré, juste plus pâle.
  const band = new Uint8Array(n); // 1 = à 1 px du fond, 2 = à 2 px
  const neighbors = (i: number, x: number, y: number, out: number[]) => {
    out.length = 0;
    if (x > 0) out.push(i - 1);
    if (x < width - 1) out.push(i + 1);
    if (y > 0) out.push(i - width);
    if (y < height - 1) out.push(i + width);
    return out;
  };
  const scratch: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (bg[i]) continue;
      for (const j of neighbors(i, x, y, scratch)) if (bg[j]) { band[i] = 1; break; }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (bg[i] || band[i]) continue;
      for (const j of neighbors(i, x, y, scratch)) if (band[j] === 1) { band[i] = 2; break; }
    }
  }

  // Couleur de référence d'un pixel de bande = moyenne des pixels INTÉRIEURS
  // (ni fond, ni bande) les plus proches. C'est la couleur « pure » de la
  // marque à cet endroit, y compris quand le logo a deux couleurs.
  const refAt = (cx: number, cy: number): [number, number, number] | null => {
    for (let r = 1; r <= CUTOUT.refRadius; r++) {
      let sr = 0, sg = 0, sb = 0, count = 0;
      const x0 = Math.max(0, cx - r), x1 = Math.min(width - 1, cx + r);
      const y0 = Math.max(0, cy - r), y1 = Math.min(height - 1, cy + r);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue; // anneau
          const i = y * width + x;
          if (bg[i] || band[i]) continue;
          const o = i * 4;
          if (px[o + 3] < 200) continue;
          sr += px[o]; sg += px[o + 1]; sb += px[o + 2]; count++;
        }
      }
      if (count) return [sr / count, sg / count, sb / count];
    }
    return null;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!band[i]) continue;
      const o = i * 4;
      const ref = refAt(x, y);
      if (!ref) continue;
      // Fond blanc : observé = α·marque + (1−α)·255. On résout α sur le canal
      // qui s'écarte le plus du blanc (le plus stable numériquement), puis on
      // repose la couleur PURE de la marque. Le liseré disparaît : ce qui reste
      // du blanc est porté par l'alpha, pas par la couleur.
      let best = -1;
      let alpha = 1;
      for (let ch = 0; ch < 3; ch++) {
        const denom = 255 - ref[ch];
        if (denom <= best || denom < 8) continue;
        best = denom;
        alpha = (255 - px[o + ch]) / denom;
      }
      if (best < 0) continue; // référence quasi blanche : on ne touche à rien
      const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
      px[o + 3] = Math.min(px[o + 3], a);
      if (px[o + 3] > 0) {
        px[o] = Math.round(ref[0]);
        px[o + 1] = Math.round(ref[1]);
        px[o + 2] = Math.round(ref[2]);
      }
    }
  }

  // ── 4) Recadrage sur la marque + marge régulière. Le prompt demande de
  //     « grandes marges » pour ne jamais rogner le symbole : sans recadrage, le
  //     logo occupe parfois moins de la moitié de son cadre et paraît minuscule
  //     dans le header.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] < 16) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  try {
    let pipeline = sharp(px, { raw: { width, height, channels: 4 } });
    let outW = width;
    let outH = height;
    if (maxX >= minX && maxY >= minY && (maxX - minX + 1 < width || maxY - minY + 1 < height)) {
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const pad = Math.max(1, Math.round(Math.max(bw, bh) * CUTOUT.padRatio));
      pipeline = pipeline
        .extract({ left: minX, top: minY, width: bw, height: bh })
        .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } });
      outW = bw + pad * 2;
      outH = bh + pad * 2;
    }
    const buf = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    return {
      buf,
      width: outW,
      height: outH,
      keyedRatio: keyed / n,
      opaqueRatio,
      reverted: false,
      reason: `fond détouré (${Math.round((keyed / n) * 100)} % de la surface)`,
    };
  } catch {
    return fallback("ré-encodage du détourage impossible");
  }
}

/** `data:<mime>;base64,<data>` → parties, ou null si ce n'est pas une data URI. */
export function parseDataUri(uri: string): RawImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec((uri || "").trim());
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

export const toDataUri = (img: RawImage): string => `data:${img.mimeType};base64,${img.data}`;

/**
 * Point d'entrée des chemins de génération : renvoie TOUJOURS un PNG, détouré
 * quand c'est possible. Ne jette jamais — au pire l'image d'entrée revient telle
 * quelle, jamais `null` (un logo au fond blanc > pas de logo).
 */
export async function makeLogoTransparent(img: RawImage | null): Promise<RawImage | null> {
  if (!img?.data) return img;
  try {
    const res = await cutoutLogoBackground(Buffer.from(img.data, "base64"));
    if (res.reverted) console.warn(`[logo] fond non détouré — ${res.reason}`);
    return { data: res.buf.toString("base64"), mimeType: "image/png" };
  } catch (e) {
    console.error("[logo] détourage impossible (logo conservé tel quel):", e);
    return img;
  }
}

export interface LogoCutout {
  image: RawImage;
  /** false = le fond n'a pas pu être retiré (pas de fond blanc, détourage absurde…). */
  ok: boolean;
  reason: string;
}

/**
 * Détourage pour la génération de logo : contrairement à `makeLogoTransparent`,
 * un échec n'est pas masqué — `generateBrandLogo` rejette alors l'essai, car un
 * logo livré sur un fond coloré ou un panneau n'est pas professionnel.
 */
export async function cutoutLogo(img: RawImage): Promise<LogoCutout> {
  const res = await cutoutLogoBackground(Buffer.from(img.data, "base64"));
  return { image: { data: res.buf.toString("base64"), mimeType: "image/png" }, ok: !res.reverted, reason: res.reason };
}

/** Même chose sur une data URI (chemins qui ne manipulent que des data URIs). */
export async function makeLogoDataUriTransparent(dataUri: string): Promise<string> {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return dataUri; // URL http distante : rien à détourer ici
  const out = await makeLogoTransparent(parsed);
  return out ? toDataUri(out) : dataUri;
}

// ─── Couleurs réelles du logo ────────────────────────────────────────────────

const rgbToHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/**
 * Couleurs DOMINANTES du logo, de la plus présente à la moins présente.
 *
 * Mesurées sur les pixels opaques uniquement (le fond détouré et les bords
 * adoucis ne comptent pas, sinon toute la palette tire vers le blanc). Le blanc
 * et le quasi-transparent sont écartés ; une couleur CHROMATIQUE est préférée en
 * tête, car c'est elle qui fait la marque (un logo « noir + rouge » doit donner
 * un site rouge, pas un site gris).
 */
export async function extractLogoColors(input: Buffer, max = 4): Promise<string[]> {
  let sharp: any;
  try {
    sharp = await getSharp();
  } catch {
    return [];
  }
  if (!sharp) return [];

  let px: Buffer;
  let n = 0;
  try {
    // Réduction avant analyse : 128 px suffisent pour des aplats et l'analyse
    // coûte alors moins d'une milliseconde.
    const raw = await sharp(input)
      .ensureAlpha()
      .resize(128, 128, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    px = raw.data as Buffer;
    n = raw.info.width * raw.info.height;
  } catch {
    return [];
  }

  type Bucket = { count: number; r: number; g: number; b: number };
  const buckets = new Map<number, Bucket>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = px[o + 3];
    if (a < 250) continue; // bord adouci ou fond : non représentatif
    const r = px[o], g = px[o + 1], b = px[o + 2];
    if (isNeutralLight(r, g, b, 232, 22)) continue; // blanc / quasi-blanc
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key);
    if (cur) { cur.count++; cur.r += r; cur.g += g; cur.b += b; }
    else buckets.set(key, { count: 1, r, g, b });
  }
  if (buckets.size === 0) return [];

  const sorted = [...buckets.values()]
    .map((b) => ({
      count: b.count,
      hex: rgbToHex(b.r / b.count, b.g / b.count, b.b / b.count),
    }))
    .sort((a, b) => b.count - a.count);

  const withHsl = sorted.map((s) => ({ ...s, hsl: hexToHsl(s.hex) }));
  const chromatic = withHsl.filter((s) => s.hsl.s >= 18 && s.hsl.l >= 8 && s.hsl.l <= 92);
  const head = chromatic[0] || withHsl[0];

  const out: string[] = [head.hex];
  for (const cand of withHsl) {
    if (out.length >= max) break;
    if (out.includes(cand.hex)) continue;
    // On ne garde qu'une couleur VRAIMENT différente : deux nuances du même
    // rouge ne forment pas une palette, et donneraient un « accent » invisible.
    const distinct = out.every((hex) => {
      const a = hexToHsl(hex);
      const dh = Math.min(Math.abs(a.h - cand.hsl.h), 360 - Math.abs(a.h - cand.hsl.h));
      return dh >= 25 || Math.abs(a.l - cand.hsl.l) >= 18 || Math.abs(a.s - cand.hsl.s) >= 25;
    });
    if (distinct) out.push(cand.hex);
  }
  return out.filter((h): h is string => !!normHex(h));
}

/** Couleurs du logo depuis une data URI (ou '' si ce n'en est pas une). */
export async function extractLogoColorsFromDataUri(dataUri: string, max = 4): Promise<string[]> {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return [];
  try {
    return await extractLogoColors(Buffer.from(parsed.data, "base64"), max);
  } catch {
    return [];
  }
}
