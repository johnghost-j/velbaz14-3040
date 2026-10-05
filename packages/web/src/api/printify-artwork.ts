// ─── Préparation de l'artwork avant impression Printify ──────────────────────
// PROBLÈME RÉSOLU ICI : les générateurs d'images IA ne produisent pas de PNG
// transparent. Ils rendent le design « isolé sur fond blanc ». Printify imprime
// le fichier TEL QUEL : le fond blanc devient donc un vrai rectangle blanc
// imprimé sur le vêtement. Résultat = « un pull avec un carré d'image dessus »
// au lieu d'un vrai design.
//
// Ce module transforme une image IA brute en artwork réellement imprimable :
//   1. détourage du fond plat (remontée depuis les bords, donc le blanc INTERNE
//      du dessin est conservé — un œil blanc, un lettrage blanc restent),
//   2. suppression du halo clair sur le contour,
//   3. adoucissement du bord (anti-crénelage) pour un contour net à l'impression,
//   4. rognage des marges transparentes (le design remplit enfin son cadre),
//   5. montée en résolution si l'image est trop petite pour du 300 dpi,
//   6. mesure de la luminance → sert à choisir des couleurs de vêtement où le
//      design se voit vraiment (voir printify-auto.ts).

import { getSharp } from './lib/optional-import';

export interface ArtworkInfo {
  /** PNG prêt à l'upload Printify (fond transparent, rogné, haute résolution). */
  buffer: Buffer;
  width: number;
  height: number;
  /** largeur / hauteur */
  aspect: number;
  /** Luminance moyenne (0=noir, 255=blanc) des pixels visibles du design. */
  meanLuminance: number;
  /** Part de pixels visibles (0..1) — un logo fin est bas, un motif plein est haut. */
  inkCoverage: number;
  /** true si un fond plat a été détouré par ce module. */
  backgroundRemoved: boolean;
  /** true si l'image fournie avait déjà une vraie transparence. */
  alreadyTransparent: boolean;
}

export interface PrepareArtworkOptions {
  /** Désactive le détourage (ex. motif all-over voulu plein cadre). */
  removeBackground?: boolean;
  /** Tolérance couleur du fond (distance RGB). Défaut 30. */
  tolerance?: number;
  /** Côté long minimum en px (300 dpi). Défaut 2400. */
  minLongSide?: number;
  /** Côté long maximum en px (Printify accepte de gros fichiers, on borne la RAM). */
  maxLongSide?: number;
}

const DEFAULTS = { tolerance: 30, minLongSide: 2400, maxLongSide: 4500 };

function lum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function dist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/** Couleur moyenne d'un bloc carré ancré sur un coin. */
function cornerColor(data: Buffer, w: number, h: number, cx: number, cy: number, size = 6) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = cy; y < cy + size && y < h; y++) {
    for (let x = cx; x < cx + size && x < w; x++) {
      const i = (y * w + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 255, g: 255, b: 255 };
}

/**
 * Détourage d'un fond PLAT par propagation depuis les bords.
 * On ne supprime que les pixels connectés au bord de l'image et proches de la
 * couleur de fond : le blanc à l'intérieur du dessin est donc préservé.
 * Renvoie null si l'image n'a pas de fond plat détourable (design plein cadre).
 */
function floodRemoveBackground(
  data: Buffer,
  w: number,
  h: number,
  tolerance: number,
): { removed: number } | null {
  const corners = [
    cornerColor(data, w, h, 0, 0),
    cornerColor(data, w, h, Math.max(0, w - 6), 0),
    cornerColor(data, w, h, 0, Math.max(0, h - 6)),
    cornerColor(data, w, h, Math.max(0, w - 6), Math.max(0, h - 6)),
  ];
  // Les 4 coins doivent se ressembler : sinon il n'y a pas de fond uni à retirer.
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const a = corners[i], b = corners[j];
      if (dist(a.r, a.g, a.b, b.r, b.g, b.b) > 42) return null;
    }
  }
  const bg = {
    r: corners.reduce((s, c) => s + c.r, 0) / 4,
    g: corners.reduce((s, c) => s + c.g, 0) / 4,
    b: corners.reduce((s, c) => s + c.b, 0) / 4,
  };

  const total = w * h;
  const visited = new Uint8Array(total);
  // Pile de pixels à examiner, amorcée par tout le pourtour de l'image.
  const stack = new Int32Array(total);
  let sp = 0;
  const push = (p: number) => {
    if (!visited[p]) { visited[p] = 1; stack[sp++] = p; }
  };
  const near = (p: number): boolean => {
    const i = p * 4;
    return dist(data[i], data[i + 1], data[i + 2], bg.r, bg.g, bg.b) <= tolerance;
  };

  for (let x = 0; x < w; x++) {
    const top = x, bot = (h - 1) * w + x;
    if (near(top)) push(top);
    if (near(bot)) push(bot);
  }
  for (let y = 0; y < h; y++) {
    const left = y * w, right = y * w + (w - 1);
    if (near(left)) push(left);
    if (near(right)) push(right);
  }

  // Propagation 4-connexe : marque tout le fond connecté au bord.
  const mask = new Uint8Array(total);
  let removed = 0;
  while (sp > 0) {
    const p = stack[--sp];
    mask[p] = 1; removed++;
    const x = p % w, y = (p - x) / w;
    if (x > 0) { const q = p - 1; if (!visited[q] && near(q)) push(q); }
    if (x < w - 1) { const q = p + 1; if (!visited[q] && near(q)) push(q); }
    if (y > 0) { const q = p - w; if (!visited[q] && near(q)) push(q); }
    if (y < h - 1) { const q = p + w; if (!visited[q] && near(q)) push(q); }
  }

  const frac = removed / total;
  // Rien de significatif retiré, ou au contraire tout effacé → on ne touche pas.
  if (frac < 0.015 || frac > 0.97) return null;

  // Applique le masque : alpha 0 sur le fond.
  for (let p = 0; p < total; p++) if (mask[p]) data[p * 4 + 3] = 0;

  // Anti-halo : un pixel transparent voisin d'un pixel gardé reçoit la couleur
  // de ce voisin. Sans ça, l'adoucissement du bord ferait baver du blanc.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x < w - 1 ? p + 1 : -1,
        y > 0 ? p - w : -1,
        y < h - 1 ? p + w : -1,
      ];
      for (const q of neighbours) {
        if (q < 0 || mask[q]) continue;
        const pi = p * 4, qi = q * 4;
        data[pi] = data[qi]; data[pi + 1] = data[qi + 1]; data[pi + 2] = data[qi + 2];
        break;
      }
    }
  }
  return { removed };
}

/**
 * Boîte englobante des pixels VISIBLES, calculée sur le canal alpha seul.
 * Marge de 2 px pour ne pas couper le bord adouci. null si l'image est vide.
 */
function alphaBoundingBox(
  data: Buffer,
  w: number,
  h: number,
  threshold = 8,
  pad = 2,
): { left: number; top: number; width: number; height: number } | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(w - 1, maxX + pad);
  const bottom = Math.min(h - 1, maxY + pad);
  const width = right - left + 1;
  const height = bottom - top + 1;
  if (width <= 0 || height <= 0) return null;
  // Déjà ajusté : inutile de rogner.
  if (left === 0 && top === 0 && width === w && height === h) return null;
  return { left, top, width, height };
}

/** Transforme une image IA brute en artwork imprimable. */
export async function prepareArtwork(src: Buffer, opts: PrepareArtworkOptions = {}): Promise<ArtworkInfo> {
  const tolerance = opts.tolerance ?? DEFAULTS.tolerance;
  const minLongSide = opts.minLongSide ?? DEFAULTS.minLongSide;
  const maxLongSide = opts.maxLongSide ?? DEFAULTS.maxLongSide;
  const sharp = await getSharp();

  // Borne la taille de travail pour ne pas exploser la RAM sur le flood fill.
  let work = sharp(src, { failOn: 'none' }).rotate();
  const meta0 = await work.metadata();
  if (Math.max(meta0.width || 0, meta0.height || 0) > maxLongSide) {
    work = work.resize({
      width: (meta0.width || 0) >= (meta0.height || 0) ? maxLongSide : undefined,
      height: (meta0.height || 0) > (meta0.width || 0) ? maxLongSide : undefined,
      fit: 'inside',
    });
  }

  // `depth: 'uchar'` est OBLIGATOIRE : une source 16 bits (PNG/TIFF) sortirait
  // sinon en 16 bits et toute l'indexation octet-par-octet ci-dessous serait
  // décalée d'un facteur 2 (fond mal détouré, rognage aberrant).
  const { data, info } = await work
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const total = w * h;

  // L'image a-t-elle DÉJÀ une vraie transparence ? (alors on ne détoure pas)
  let transparentPixels = 0;
  for (let p = 0; p < total; p++) if (data[p * 4 + 3] < 250) transparentPixels++;
  const alreadyTransparent = transparentPixels / total > 0.02;

  let backgroundRemoved = false;
  if (!alreadyTransparent && opts.removeBackground !== false) {
    const res = floodRemoveBackground(data, w, h, tolerance);
    backgroundRemoved = res !== null;
    if (process.env.PRINTIFY_ARTWORK_DEBUG) {
      console.error('[artwork] flood', { w, h, removed: res?.removed ?? 0, frac: ((res?.removed ?? 0) / total).toFixed(3) });
    }
  }

  // Statistiques sur les pixels VISIBLES (ce que l'on imprime réellement).
  let sumLum = 0, visible = 0;
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    if (data[i + 3] < 24) continue;
    sumLum += lum(data[i], data[i + 1], data[i + 2]);
    visible++;
  }

  // Adoucit le bord du détourage : on floute légèrement le canal alpha seul.
  if (backgroundRemoved) {
    const alphaOnly = Buffer.allocUnsafe(total);
    for (let p = 0; p < total; p++) alphaOnly[p] = data[p * 4 + 3];
    const softAlpha = await sharp(alphaOnly, { raw: { width: w, height: h, channels: 1 } })
      .blur(0.9).raw({ depth: 'uchar' }).toBuffer();
    // ATTENTION : sharp renvoie 3 canaux pour une entrée niveaux de gris floutée
    // (« b-w » promu en RGB). Lire softAlpha[p] au lieu de softAlpha[p * ch]
    // décale tout le canal alpha et INVERSE visuellement le détourage.
    const ch = Math.max(1, Math.round(softAlpha.length / total));
    for (let p = 0; p < total; p++) data[p * 4 + 3] = softAlpha[p * ch];
  }

  // Rogne les marges transparentes → le design remplit son cadre, et le
  // placement calculé ensuite correspond au dessin, pas à du vide.
  // NB : on ne se sert PAS de sharp.trim() — il compare les canaux RGB et
  // confond donc le blanc transparent du fond avec un lettrage blanc opaque du
  // design. On calcule la boîte englobante sur le canal ALPHA uniquement.
  let img = sharp(data, { raw: { width: w, height: h, channels: 4 } });
  if (backgroundRemoved || alreadyTransparent) {
    const bbox = alphaBoundingBox(data, w, h);
    if (bbox) {
      img = img.extract(bbox);
      if (process.env.PRINTIFY_ARTWORK_DEBUG) console.error('[artwork] bbox alpha', bbox);
    }
  }
  let buf = await img.png().toBuffer();
  let m = await sharp(buf).metadata();
  if (process.env.PRINTIFY_ARTWORK_DEBUG) {
    console.error('[artwork] apres trim', { w: m.width, h: m.height });
  }

  // Remonte en résolution si trop petit pour une impression 300 dpi propre.
  const longSide = Math.max(m.width || 0, m.height || 0);
  if (longSide > 0 && longSide < minLongSide) {
    const factor = minLongSide / longSide;
    buf = await sharp(buf)
      .resize({
        width: Math.round((m.width || 0) * factor),
        height: Math.round((m.height || 0) * factor),
        kernel: 'lanczos3',
      })
      .png()
      .toBuffer();
    m = await sharp(buf).metadata();
  }

  const width = m.width || w, height = m.height || h;
  return {
    buffer: buf,
    width,
    height,
    aspect: height > 0 ? width / height : 1,
    meanLuminance: visible ? sumLum / visible : 128,
    inkCoverage: total ? visible / total : 1,
    backgroundRemoved,
    alreadyTransparent,
  };
}

// ─── Géométrie de placement réaliste ────────────────────────────────────────
// Printify exprime `scale` par rapport à la LARGEUR de la zone d'impression, et
// x/y comme le centre du calque (0..1) dans cette zone. Un `scale: 0.9` centré
// en y: 0.5 (l'ancien comportement) étire le design des aisselles à l'ourlet :
// c'est exactement le rendu « amateur » que l'on corrige ici.

export interface PlacementGeometry {
  x: number;
  y: number;
  scale: number;
}

export type PlacementStyle = 'chest' | 'full_front' | 'pocket' | 'full_bleed' | 'wrap' | 'centered' | 'logo' | 'all_over';

/** Style de placement par défaut selon la position d'impression. */
export function defaultStyleForPosition(position: string, kind: 'apparel' | 'flat' | 'mug' | 'accessory' | 'footwear'): PlacementStyle {
  const p = (position || 'front').toLowerCase();
  if (kind === 'flat') return 'full_bleed';        // poster, sticker → plein cadre
  if (kind === 'mug') return 'wrap';                // mug → bandeau large
  // [2026-10-04] Johne : une chaussure reçoit un DESIGN COMPLET (motif
  // all-over pensé pour l'empeigne), plus un petit logo sur le flanc (règle
  // du 2026-09-23, abandonnée). Le motif couvre toute la zone, bord à bord.
  // Les artworks « motif sur fond blanc » hérités sont traités à part dans
  // printify-auto (footwearArtworkMode).
  if (kind === 'footwear') return 'all_over';
  if (/sleeve|neck|label|pocket/.test(p)) return 'pocket';
  if (kind === 'accessory') return 'centered';      // tote bag, coque
  return 'chest';                                   // vêtement, face avant/arrière
}

/**
 * Calcule x/y/scale pour que le design tombe là où un vrai print tombe.
 * @param aspect    largeur/hauteur de l'artwork DÉTOURÉ
 * @param areaRatio largeur/hauteur de la zone d'impression (ex 4200/4800)
 */
export function placementFor(style: PlacementStyle, aspect: number, areaRatio: number): PlacementGeometry {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const r = Number.isFinite(areaRatio) && areaRatio > 0 ? areaRatio : 0.875;

  // maxW : largeur max occupée (fraction de la zone) — maxH : hauteur max.
  // topMargin : vide laissé au-dessus du design (sous l'encolure).
  const box: Record<PlacementStyle, { maxW: number; maxH: number; topMargin: number; center?: boolean }> = {
    // Print poitrine classique : large mais pas jusqu'aux coutures, placé haut.
    chest: { maxW: 0.70, maxH: 0.60, topMargin: 0.10 },
    // Grand print façade (streetwear) : plus large, descend plus bas.
    full_front: { maxW: 0.86, maxH: 0.78, topMargin: 0.07 },
    // Petit print cœur/manche/nuque.
    pocket: { maxW: 0.26, maxH: 0.26, topMargin: 0.12 },
    // Plein cadre (poster, sticker) : occupe toute la zone.
    full_bleed: { maxW: 1, maxH: 1, topMargin: 0, center: true },
    // Mug : bandeau large centré verticalement.
    wrap: { maxW: 0.92, maxH: 0.82, topMargin: 0, center: true },
    // Accessoire : centré, marge de sécurité.
    centered: { maxW: 0.74, maxH: 0.74, topMargin: 0, center: true },
    // Logo (chaussure, casquette…) : petit repère de marque, jamais un
    // visuel qui couvre tout le flanc du produit.
    logo: { maxW: 0.30, maxH: 0.30, topMargin: 0, center: true },
    // All-over (chaussure) : COUVRE la zone (calcul dédié ci-dessous).
    all_over: { maxW: 1, maxH: 1, topMargin: 0, center: true },
  };
  // All-over : l'artwork RECOUVRE toute la zone (aucun bord vide), quitte à
  // déborder sur l'axe le plus long — comme un tissu imprimé coupé au patron.
  // scale = largeur de l'artwork / largeur de la zone ; hauteur occupée =
  // scale * r / a, qui doit être ≥ 1.
  if (style === 'all_over') {
    const scale = Math.max(1, a / r);
    return { x: 0.5, y: 0.5, scale: Number(scale.toFixed(4)) };
  }
  const b = box[style] || box.chest;

  // hauteur occupée = scale * r / a  →  scale limité par la largeur ET la hauteur
  const scaleByHeight = (b.maxH * a) / r;
  const scale = Math.max(0.05, Math.min(b.maxW, scaleByHeight));
  const usedHeight = (scale * r) / a;

  const y = b.center
    ? 0.5
    : Math.min(0.62, Math.max(0.18, b.topMargin + usedHeight / 2));

  return { x: 0.5, y: Number(y.toFixed(4)), scale: Number(scale.toFixed(4)) };
}

// Mots désignant une chaussure, en français ET en anglais (titres du
// catalogue Printify sont en anglais : « Men's sneakers », « High Top Shoes »…).
const FOOTWEAR_WORDS = /shoe|shoes|sneaker|sneakers|boot|boots|sandal|sandals|slipper|slippers|footwear|chaussure|chaussures|basket|baskets|sandale|sandales|bottine|bottines|chausson|chaussons|escarpin|escarpins|mule|mules/i;

/**
 * Famille de produit → règles de placement et de couleurs.
 * @param title       titre RÉDIGÉ PAR L'IA (ex. « Urban Glide ») — ne contient
 *                    pas forcément le mot « chaussure ».
 * @param catalogTitle titre RÉEL du blueprint chez Printify (ex. « Men's
 *                    canvas shoes »), lu en direct dans le catalogue — c'est
 *                    lui qui identifie fiablement le type de produit, quel
 *                    que soit le blueprint choisi (pas de liste d'ID figée :
 *                    Printify propose plusieurs modèles de chaussures et le
 *                    choix varie d'un produit à l'autre).
 */
export function productKindFromBlueprint(
  blueprintId: number,
  title = '',
  catalogTitle = '',
): 'apparel' | 'flat' | 'mug' | 'accessory' | 'footwear' {
  const t = title.toLowerCase();
  const ct = catalogTitle.toLowerCase();
  if (FOOTWEAR_WORDS.test(ct) || FOOTWEAR_WORDS.test(t)) return 'footwear';
  if (/poster|affiche|canvas|print|sticker|autocollant/.test(t)) return 'flat';
  if (/mug|tasse|cup|bottle|gourde/.test(t)) return 'mug';
  if (/bag|tote|sac|case|coque|pillow|coussin|towel/.test(t)) return 'accessory';
  // Blueprints connus non textiles.
  if ([5, 400, 282].includes(blueprintId)) return 'flat';
  if ([68, 69, 70].includes(blueprintId)) return 'mug';
  if ([397, 268, 269].includes(blueprintId)) return 'accessory';
  return 'apparel';
}
