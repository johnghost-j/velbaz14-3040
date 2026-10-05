// ─── FAVICON CARRÉ À PARTIR DU LOGO (sans déformation) ──────────────────────
//
// Bug constaté le 2026-10-04 (« les images icônes en haut des onglets dans les
// sites générés : les logos sont étirés ») :
//
// Le favicon de l'onglet (`<link rel="icon">` et `apple-touch-icon` dans
// `index.html`) recevait le logo BRUT. Or le détourage (`logo-image.ts`)
// recadre le logo au plus près de la marque : il n'est presque jamais carré.
// Mesuré en base : Paséo 925×456, Paselle 608×265, Denimora 438×508.
// Un navigateur dessine l'icône d'onglet dans un carré (16/32 px) SANS garder
// les proportions : un wordmark 2:1 était donc écrasé dans le carré.
//
// Correctif : le favicon est une image DISTINCTE du logo, toujours carrée.
// Le logo est recadré sur ses pixels visibles, puis posé « contain » (rapport
// largeur/hauteur conservé) au centre d'un carré transparent. Le logo du
// header/footer, lui, reste le logo d'origine.
//
// L'icône Apple (écran d'accueil iOS) ne supporte pas la transparence : iOS
// remplit le transparent en NOIR. Elle est donc aplatie sur un fond uni — blanc
// pour un logo foncé, quasi-noir pour un logo clair (sinon il disparaîtrait).

import { createHash } from "crypto";
import { getSharp } from "../lib/optional-import";

export const FAVICON = {
  /** Côté de l'icône d'onglet (net sur écran Retina, léger en data URI). */
  iconSize: 256,
  /** Côté recommandé par Apple pour `apple-touch-icon`. */
  appleSize: 180,
  /** Marge autour du logo dans l'icône d'onglet, en part du côté. */
  iconPad: 0.04,
  /** Marge plus large pour l'icône iOS (coins arrondis appliqués par iOS). */
  applePad: 0.12,
  /** Un pixel compte comme « visible » au-delà de cette opacité. */
  alphaMin: 8,
  /** Luminance moyenne (0-255) au-delà de laquelle le logo est dit « clair ». */
  lightLogoMin: 200,
} as const;

export interface FaviconSet {
  /** PNG carré transparent → `<link rel="icon">`. */
  icon: string;
  /** PNG carré sur fond uni → `<link rel="apple-touch-icon">`. */
  appleTouch: string;
}

/** Octets du logo : data URI base64 ou URL http(s) (logo d'un site cloné). */
async function loadLogoBytes(logoUrl: string): Promise<Buffer> {
  const url = logoUrl.trim();
  const m = /^data:[^;,]+;base64,(.+)$/s.exec(url);
  if (m) return Buffer.from(m[1], "base64");
  if (/^data:image\/svg\+xml,/i.test(url)) {
    return Buffer.from(decodeURIComponent(url.slice(url.indexOf(",") + 1)), "utf8");
  }
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`logo distant illisible (HTTP ${res.status}) : ${url.slice(0, 120)}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`format de logo non pris en charge pour le favicon : ${url.slice(0, 40)}`);
}

interface Visible {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Luminance moyenne des pixels visibles (0-255). */
  luminance: number;
}

/** Boîte englobante des pixels visibles + luminance moyenne de la marque. */
function visibleBox(px: Buffer, width: number, height: number): Visible {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  let lum = 0, weight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = px[i + 3];
      if (a <= FAVICON.alphaMin) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const w = a / 255;
      lum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) * w;
      weight += w;
    }
  }
  if (maxX < 0) throw new Error("logo entièrement transparent : aucun favicon possible");
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1, luminance: lum / weight };
}

/**
 * Pose le logo au centre d'un carré `size`×`size`, proportions conservées.
 * `background` absent → fond transparent.
 */
async function squarePng(
  sharp: any,
  input: Buffer,
  box: Visible,
  size: number,
  pad: number,
  background?: { r: number; g: number; b: number },
): Promise<Buffer> {
  const inner = Math.max(1, Math.round(size * (1 - 2 * pad)));
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const fitted = await sharp(input)
    .ensureAlpha()
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .resize(inner, inner, { fit: "contain", background: clear })
    .png()
    .toBuffer();
  const before = Math.floor((size - inner) / 2);
  const after = size - inner - before;
  let img = sharp(fitted).extend({ top: before, bottom: after, left: before, right: after, background: clear });
  if (background) img = sharp(await img.png().toBuffer()).flatten({ background });
  return img.png({ compressionLevel: 9 }).toBuffer();
}

const toPngUri = (buf: Buffer) => `data:image/png;base64,${buf.toString("base64")}`;

/**
 * Favicon carré (onglet + iOS) à partir des octets du logo.
 * Jette si l'image est illisible ou vide : l'appelant décide (jamais de logo
 * brut déformé en guise de favicon).
 */
export async function buildFaviconSetFromBytes(input: Buffer): Promise<FaviconSet> {
  const sharp = await getSharp();
  const raw = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = visibleBox(raw.data as Buffer, raw.info.width, raw.info.height);
  const appleBg = box.luminance >= FAVICON.lightLogoMin ? { r: 17, g: 17, b: 17 } : { r: 255, g: 255, b: 255 };
  const [icon, apple] = await Promise.all([
    squarePng(sharp, input, box, FAVICON.iconSize, FAVICON.iconPad),
    squarePng(sharp, input, box, FAVICON.appleSize, FAVICON.applePad, appleBg),
  ]);
  return { icon: toPngUri(icon), appleTouch: toPngUri(apple) };
}

// Le même logo est re-présenté souvent (réparation de l'aperçu à chaque
// démarrage, fin de build, changement de logo) : on ne refait pas le travail
// d'image pour un logo identique. Clé = empreinte du logo, pas le logo entier.
const cache = new Map<string, Promise<FaviconSet>>();
const CACHE_MAX = 32;

/** Favicon carré pour `logoUrl` (data URI ou URL http(s)). Jette en cas d'échec. */
export function buildFaviconSet(logoUrl: string): Promise<FaviconSet> {
  const key = createHash("sha256").update(logoUrl.trim()).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;
  const job = loadLogoBytes(logoUrl).then(buildFaviconSetFromBytes);
  // Un échec ne reste pas en cache : la prochaine tentative recommence.
  job.catch(() => cache.delete(key));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, job);
  return job;
}
