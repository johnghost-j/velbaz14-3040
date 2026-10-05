/**
 * Contrôle qualité des images renvoyées par le modèle.
 *
 * [2026-09-25] BUG « les images générées sont buguées ». Un run entier
 * (23 visuels sur 23) est arrivé dans le site avec des images floues, striées
 * horizontalement et visiblement « pixelisées par blocs ». Mesure faite sur les
 * manifestes réellement stockés en base :
 *
 *   run cassé   → énergie de gradient sur la grille de blocs : 1,55 → 2,15
 *   run sain    → 1,03 → 1,36
 *   6 générations neuves (scènes claires ET sombres) → 1,05 → 1,45
 *
 * Le profil du run cassé montre des pics nets modulo 4 et modulo 16 px : la
 * signature d'un encodage VP8/JPEG à très basse qualité, PAS un défaut de notre
 * redimensionnement (vérifié : la sortie brute du modèle et la sortie sharp d'une
 * même image sont visuellement identiques).
 *
 * CAUSE RÉELLE du fait que ça atterrissait dans le site : le pipeline ne
 * regardait JAMAIS ce que le modèle renvoyait. `sharp(buf)` sans options ne lève
 * pas d'erreur même sur un JPEG dont on a coupé 2 Ko au milieu (vérifié :
 * `failOn` par défaut n'est pas `warning`), donc n'importe quel octet douteux
 * était ré-encodé proprement en WebP et inlin-é dans le manifeste. Une image
 * cassée devenait un fichier VALIDE contenant de la bouillie — ce qui explique
 * aussi pourquoi un audit « est-ce que ça décode ? » ne trouvait rien.
 *
 * Ce module donne donc les deux gardes qui manquaient : détection de flux
 * tronqué, et score d'artefacts de bloc pour pouvoir relancer la génération.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * [2026-09-25 — 2e passe] Le correctif ci-dessus NE SUFFISAIT PAS : des images
 * « traînées » (rangées de pixels dupliquées / étirées horizontalement, comme
 * un flux vidéo qui décroche) continuaient d'arriver dans les sites. Mesures
 * refaites sur 74 images propres (68 photos réelles + 6 illustrations/dégradés
 * de synthèse) et sur l'image abîmée signalée par l'utilisateur :
 *
 *   blockArtifactScore  74 images propres → 1,10 … 1,82
 *   blockArtifactScore  image abîmée      → 1,80   ⟵ INDISTINGUABLE
 *   blockArtifactScore  flux tronqué      → ~1,10  ⟵ PLUS BAS qu'une image propre
 *
 * Deux conséquences, toutes les deux vérifiées :
 *  1. le seuil 1,55 se déclenche à tort sur ~14 % des photos propres (une photo
 *     douce ou en dégradé a naturellement un profil piqué) ;
 *  2. surtout, `blockArtifactScore` est AVEUGLE au défaut réel : une rangée
 *     dupliquée est plate, donc son gradient est FAIBLE. Le classement « on
 *     garde la moins mauvaise » des appelants PRÉFÉRAIT donc activement
 *     l'image abîmée (score ~1,1) à une image propre mais douce (score ~1,8).
 *
 * D'où ce que ce module ajoute maintenant :
 *  - `dragArtifactScore` : détecteur SPÉCIFIQUE du défaut (voir sa doc).
 *    Mesuré 0,000 … 1,145 sur les 74 images propres, 2,172 sur l'image abîmée,
 *    et 0,8 … 15,6 sur des corruptions simulées. Coût : ~8 ms / 1 MP.
 *  - une GRAVITÉ (`severity`) : `fatal` = jamais publiable (illisible, flux
 *    tronqué, traînées), `suspect` = douteux mais publiable en dernier recours
 *    (score de bloc élevé seulement, ce qui peut être un faux positif).
 *    Les appelants doivent relancer sur `suspect` et JETER sur `fatal`.
 */

import { getSharp } from '../lib/optional-import';

/**
 * Au-dessus de ce score, l'image est SUSPECTE d'être abîmée par la compression.
 *
 * Volontairement laissé à 1,55 alors que ~14 % des photos propres le dépassent :
 * depuis la 2e passe un dépassement n'est plus bloquant (`severity: 'suspect'`),
 * il déclenche seulement une relance. Un faux positif coûte donc une génération
 * de plus, jamais un visuel manquant.
 */
export const ARTIFACT_MAX = 1.55;

/**
 * Au-dessus de ce pourcentage de pixels « traînés », l'image est abîmée pour de
 * bon. Calibré sur 74 images propres (max relevé : 1,145) contre 2,172 pour
 * l'image signalée par l'utilisateur.
 */
export const DRAG_MAX = 1.6;

/**
 * [2026-10-01] Traînées « modérées » sur une image DÉJÀ suspecte ⇒ fatal.
 * Signalé par l'utilisateur (capture du héro SoulStride) : deux visuels
 * publiés avec des traînées horizontales bien visibles, mais sous DRAG_MAX —
 * héro score 1,57 / traînées 1,10 ; « pulse runner » 1,68 / 1,45. Seuls, ni
 * le score de bloc ni les traînées ne les séparent des photos propres (max
 * 1,145 de traînées sur les 74 de calibration). ENSEMBLE si : sur 30 images
 * propres remesurées (24 photos + 6 sorties du modèle d'image), aucune n'a un
 * score > ARTIFACT_MAX, et leurs traînées plafonnent à 0,79. La combinaison
 * « score suspect ET traînées > 0,9 » ne touche donc que des images déjà
 * douteuses, et elle les relance au lieu de les publier.
 */
export const DRAG_SUSPECT_MAX = 0.9;

/** On ne mesure jamais plus que cette surface (recadrage centré, sans resize). */
const MAX_MEASURE_PIXELS = 1_400_000;

/**
 * Au-dessus de cette part de pixels tenue par les 8 niveaux de gris les plus
 * fréquents, l'image est un GRAPHIQUE (aplats, maquette d'écran, illustration
 * plate) et non une photo : le détecteur de traînées n'y veut rien dire (voir
 * `dragArtifactScore`). Mesuré : photos 0,065 … 0,503 · image abîmée 0,185 ·
 * captures d'écran / maquettes 0,768 … 1,000.
 */
export const GRAPHIC_PALETTE_MAX = 0.6;

/** Longueur minimale (px) d'une série identique pour parler de traînée. */
const DRAG_RUN = 6;
/** Marche minimale au bord de la série (sinon c'est un aplat, pas une traînée). */
const DRAG_STEP = 3;
/** Variation minimale sur l'AUTRE axe (sinon c'est une zone unie légitime). */
const DRAG_VAR = 3;

/** Gravité du défaut. `fatal` ⇒ ne jamais publier, même faute de mieux. */
export type ImageSeverity = 'ok' | 'suspect' | 'fatal';

export interface ImageInspection {
  ok: boolean;
  /** Raison de l'échec, pour les logs. */
  reason: string | null;
  /** `ok` | `suspect` (relancer, publiable en dernier recours) | `fatal` (jeter). */
  severity: ImageSeverity;
  /** Score d'artefacts de bloc : ~1,0 = propre, > 1,55 = suspect. */
  score: number;
  /** % de pixels en traînée horizontale : 0 = propre, > 1,6 = abîmé. */
  dragH: number;
  /** % de pixels en traînée verticale. */
  dragV: number;
  /** Part des pixels tenue par les 8 niveaux de gris dominants (> 0,6 ⇒ graphique). */
  paletteShare: number;
  width: number;
  height: number;
  format: string;
  truncated: boolean;
}

/**
 * Score d'artefacts de bloc, indépendant de la phase.
 *
 * Un encodeur par blocs (JPEG 8 px, VP8/WebP 4 et 16 px) laisse des marches
 * périodiques sur les frontières de ses blocs. On mesure l'énergie moyenne du
 * gradient horizontal pour chaque phase modulo 16, puis on renvoie
 * `max(profil) / moyenne(profil)`. Une photo propre a un profil plat (~1,0) ;
 * une image massacrée par la compression a un pic marqué (1,7 → 2,1).
 *
 * Indépendant de la phase ⇒ un recadrage ne fausse pas la mesure.
 */
export function blockArtifactScore(gray: Uint8Array | Buffer, width: number, height: number): number {
  if (width < 32 || height < 8) return 1;
  const sum = new Float64Array(16);
  const cnt = new Float64Array(16);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 1; x < width; x++) {
      const g = Math.abs(gray[row + x] - gray[row + x - 1]);
      const ph = x & 15;
      sum[ph] += g;
      cnt[ph]++;
    }
  }
  let mean = 0;
  let peak = 0;
  const prof = new Array<number>(16);
  for (let i = 0; i < 16; i++) {
    prof[i] = cnt[i] ? sum[i] / cnt[i] : 0;
    mean += prof[i];
    if (prof[i] > peak) peak = prof[i];
  }
  mean /= 16;
  if (mean <= 0.0001) return 1; // image uniforme : rien à mesurer
  return peak / mean;
}

/**
 * Part des pixels tenue par les 8 niveaux de gris les plus fréquents.
 *
 * Sert à savoir si on regarde une PHOTO (histogramme étalé : 0,06 → 0,50) ou un
 * GRAPHIQUE — capture d'écran, maquette d'UI, illustration à plat (0,77 → 1,00).
 * Cette distinction est indispensable au détecteur de traînées : dans un
 * graphique, les longues séries de pixels identiques bordées d'une marche nette
 * sont la NORME (bords de cartes, hampes de lettres, aplats), et le détecteur y
 * monte jusqu'à 26 % sans aucun défaut.
 */
export function flatPaletteShare(gray: Uint8Array | Buffer): number {
  if (!gray.length) return 1;
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  // Somme des 8 plus gros bacs, sans trier les 256 (sélection directe).
  const top = new Float64Array(8);
  for (let v = 0; v < 256; v++) {
    const c = hist[v];
    if (c <= top[7]) continue;
    let i = 7;
    while (i > 0 && top[i - 1] < c) { top[i] = top[i - 1]; i--; }
    top[i] = c;
  }
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += top[i];
  return sum / gray.length;
}

/**
 * Détecteur de TRAÎNÉES : le défaut réellement visible sur les images buguées.
 *
 * Quand le flux renvoyé par le modèle décroche, le décodeur ne s'arrête pas —
 * il rejoue le dernier pixel connu. Ça produit des rangées (ou colonnes)
 * ÉTIRÉES : de longues séries de pixels rigoureusement identiques, qui se
 * terminent par une marche nette, dans une zone d'image par ailleurs détaillée.
 * On compte le pourcentage de pixels pris dans une telle série :
 *
 *   1. série de ≥ DRAG_RUN pixels de valeur EXACTEMENT identique ;
 *   2. bordée par une marche de ≥ DRAG_STEP (une vraie cassure, pas un dégradé) ;
 *   3. dans une zone qui varie de ≥ DRAG_VAR sur l'AUTRE axe — c'est ce test qui
 *      épargne les aplats légitimes (ciel, fond uni, illustration à plat), où
 *      les longues séries identiques sont normales et entourées de pixels
 *      identiques eux aussi.
 *
 * Complémentaire de `blockArtifactScore`, qui mesure l'inverse (trop de
 * gradient sur la grille de blocs) et reste donc aveugle à ce défaut-ci.
 *
 * ⚠️ Ne vaut que pour du CONTENU PHOTOGRAPHIQUE. Sur un graphique (capture
 * d'écran, maquette, illustration à plat) ces trois conditions sont remplies
 * par construction et le score monte à 26 % sans le moindre défaut : c'est
 * `flatPaletteShare` qui sert à écarter ces images avant de juger.
 */
export function dragArtifactScore(
  gray: Uint8Array | Buffer,
  width: number,
  height: number,
): { horizontal: number; vertical: number } {
  if (width < 16 || height < 16) return { horizontal: 0, vertical: 0 };
  const total = (height - 2) * width;
  if (total <= 0) return { horizontal: 0, vertical: 0 };

  let dragged = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      const v0 = gray[row + x];
      let end = x + 1;
      while (end < width && gray[row + end] === v0) end++;
      const len = end - x;
      if (len >= DRAG_RUN) {
        const step = end < width
          ? Math.abs(gray[row + end] - v0)
          : x > 0 ? Math.abs(v0 - gray[row + x - 1]) : 0;
        if (step >= DRAG_STEP) {
          let vary = 0;
          for (let i = x; i < end; i++) {
            vary += Math.abs(gray[row + width + i] - gray[row - width + i]);
          }
          if (vary / len >= DRAG_VAR) dragged += len;
        }
      }
      x = end;
    }
  }
  const horizontal = (100 * dragged) / total;

  dragged = 0;
  for (let x = 1; x < width - 1; x++) {
    let y = 0;
    while (y < height) {
      const v0 = gray[y * width + x];
      let end = y + 1;
      while (end < height && gray[end * width + x] === v0) end++;
      const len = end - y;
      if (len >= DRAG_RUN) {
        const step = end < height
          ? Math.abs(gray[end * width + x] - v0)
          : y > 0 ? Math.abs(v0 - gray[(y - 1) * width + x]) : 0;
        if (step >= DRAG_STEP) {
          let vary = 0;
          for (let i = y; i < end; i++) {
            vary += Math.abs(gray[i * width + x + 1] - gray[i * width + x - 1]);
          }
          if (vary / len >= DRAG_VAR) dragged += len;
        }
      }
      y = end;
    }
  }
  const vertical = (100 * dragged) / total;

  return { horizontal, vertical };
}

/**
 * Décode les octets d'une image et dit si on peut la publier.
 *
 * Deux vérifications indépendantes :
 *  1. flux tronqué / octets perdus — `failOn: 'warning'` fait remonter les
 *     avertissements libjpeg (« premature end of data segment ») que le décodage
 *     par défaut avale en silence ;
 *  2. artefacts de bloc — voir `blockArtifactScore`.
 */
export async function inspectImageBuffer(buf: Buffer): Promise<ImageInspection> {
  const fail = (reason: string): ImageInspection => ({
    ok: false, reason, severity: 'fatal', score: 0, dragH: 0, dragV: 0, paletteShare: 0,
    width: 0, height: 0, format: 'unknown', truncated: false,
  });
  if (!buf?.length) return fail('buffer vide');

  const sharp = await getSharp();
  let meta: any;
  try {
    meta = await sharp(buf, { failOn: 'none' }).metadata();
  } catch (e: any) {
    return fail(`illisible: ${String(e?.message || e).slice(0, 120)}`);
  }
  const width = meta?.width || 0;
  const height = meta?.height || 0;
  const format = meta?.format || 'unknown';
  if (!width || !height) return fail('dimensions inconnues');

  // 1) flux complet ?
  let truncated = false;
  let reason: string | null = null;
  try {
    await sharp(buf, { failOn: 'warning' }).stats();
  } catch (e: any) {
    truncated = true;
    reason = `flux abîmé: ${String(e?.message || e).slice(0, 120)}`;
  }

  // 2) artefacts de bloc + traînées — mesurés à la résolution NATIVE (un resize
  //    détruirait la grille qu'on cherche ET lisserait les séries identiques),
  //    sur un recadrage centré si l'image est très grande.
  let score = 1;
  let dragH = 0;
  let dragV = 0;
  let paletteShare = 0;
  try {
    let pipeline = sharp(buf, { failOn: 'none' });
    let mw = width;
    let mh = height;
    if (width * height > MAX_MEASURE_PIXELS) {
      const ratio = Math.sqrt(MAX_MEASURE_PIXELS / (width * height));
      mw = Math.max(32, Math.floor(width * ratio));
      mh = Math.max(8, Math.floor(height * ratio));
      pipeline = pipeline.extract({
        left: Math.floor((width - mw) / 2),
        top: Math.floor((height - mh) / 2),
        width: mw,
        height: mh,
      });
    }
    const { data, info } = await pipeline.greyscale().raw().toBuffer({ resolveWithObject: true });
    score = blockArtifactScore(data, info.width, info.height);
    const drag = dragArtifactScore(data, info.width, info.height);
    dragH = drag.horizontal;
    dragV = drag.vertical;
    paletteShare = flatPaletteShare(data);
  } catch (e: any) {
    // Impossible de mesurer : on ne bloque pas pour autant, l'image peut être bonne.
    score = 1;
  }

  // Gravité. Un flux abîmé ou des traînées ⇒ FATAL : l'image ne doit jamais
  // partir dans le site, même si c'est la moins mauvaise des tentatives.
  // Un simple score de bloc élevé ⇒ SUSPECT : on relance, mais on accepte de
  // la publier en dernier recours (c'est un faux positif dans ~14 % des cas).
  const photographic = paletteShare <= GRAPHIC_PALETTE_MAX;
  let severity: ImageSeverity = 'ok';
  if (reason) {
    severity = 'fatal';
  } else if (photographic && Math.max(dragH, dragV) > DRAG_MAX) {
    severity = 'fatal';
    const axis = dragH >= dragV ? 'horizontales' : 'verticales';
    reason = `traînées ${axis} (${Math.max(dragH, dragV).toFixed(2)} % > ${DRAG_MAX} %)`;
  } else if (photographic && score > ARTIFACT_MAX && Math.max(dragH, dragV) > DRAG_SUSPECT_MAX) {
    severity = 'fatal';
    const axis = dragH >= dragV ? 'horizontales' : 'verticales';
    reason = `traînées ${axis} sur image dégradée (${Math.max(dragH, dragV).toFixed(2)} % > ${DRAG_SUSPECT_MAX} %, score ${score.toFixed(2)} > ${ARTIFACT_MAX})`;
  } else if (score > ARTIFACT_MAX) {
    severity = 'suspect';
    reason = `artefacts de compression (score ${score.toFixed(2)} > ${ARTIFACT_MAX})`;
  }
  return {
    ok: severity === 'ok', reason, severity, score, dragH, dragV, paletteShare,
    width, height, format, truncated,
  };
}
