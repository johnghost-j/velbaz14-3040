// ─── Design d'impression pour CHAUSSURE (Printify) ───────────────────────────
// [2026-10-04] Bug signalé : pour une chaussure, l'IA posait un petit LOGO sur
// le flanc au lieu d'un vrai design. Trois causes cumulées :
//   1. le prompt était celui d'un t-shirt (silhouette isolée sur fond blanc,
//      souvent le nom de la marque) — il dessinait donc… un logo ;
//   2. l'image sortait CARRÉE alors que la zone d'impression d'une basket
//      Printify est un bandeau ≈ 2.8:1 (1537×545 par flanc) ;
//   3. le placement « logo » réduisait ce visuel à 30 % de la zone.
// Ici : un motif COMPLET, pensé pour l'empeigne, bord à bord, au format large,
// imprimé en all-over (fond conservé) sur toutes les zones du corps.

import type { PlacementStyle } from './printify-artwork';

/** Format demandé au modèle image : le plus proche des zones Printify (≈ 2.8:1). */
export const FOOTWEAR_DESIGN_ASPECT = '21:9';

/** Type canonique (pod-guard) d'un produit chaussure. */
export function isFootwearPodType(podType?: string | null): boolean {
  return String(podType || '').trim().toLowerCase() === 'shoe';
}

export interface FootwearDesignOptions {
  /** Concept du design (ce qu'on veut voir sur la chaussure). */
  concept: string;
  /** Nom du produit (« Urban Glide »), pour donner un fil conducteur. */
  productName?: string;
  /** Couleurs de marque, ex. "#0f172a, #e11d48". */
  palette?: string;
  /**
   * Texte EXACT demandé par l'utilisateur. null/absent = AUCUN texte ni logo :
   * une chaussure se vend sur son motif, pas sur un nom écrit en gros.
   */
  text?: string | null;
}

/** Tout ce qu'il faut pour générer ET imprimer le design d'une chaussure. */
export interface PrintDesignPlan {
  prompt: string;
  aspectRatio?: string;
  placementStyle?: PlacementStyle;
  keepBackground?: boolean;
}

export function footwearDesignPrompt(opts: FootwearDesignOptions): string {
  const concept = String(opts.concept || '').trim();
  const palette = String(opts.palette || '').trim();
  const name = String(opts.productName || '').trim();
  const text = typeof opts.text === 'string' && opts.text.trim() ? opts.text.trim() : null;
  return [
    'Complete all-over surface design for the side panels of a sneaker upper — the exact flat artwork that is printed edge to edge on the shoe fabric, nothing else.',
    name ? `Sneaker model: "${name}".` : '',
    concept ? `Design concept: ${concept}.` : '',
    'Make it a fully imagined, premium sneaker colorway: a cohesive composition that flows horizontally from toe (left) to heel (right), with a rich base color, bold shapes, lines or a motif that wraps the whole panel, accent details and varied scale — like a limited-edition designer sneaker, not a t-shirt graphic.',
    palette ? `Use this brand palette as the colorway: ${palette}.` : 'Harmonious palette of 3 to 5 colors with one strong accent.',
    'CRITICAL: the artwork FILLS THE ENTIRE CANVAS, edge to edge — no white background, no margin, no empty corners, no border, no frame, no single centered emblem, no small logo, no badge, no sticker.',
    text
      ? `The ONLY text allowed is exactly "${text}", integrated subtly into the pattern (small, perfectly spelled). No other words.`
      : 'ABSOLUTELY NO TEXT, NO LOGO, NO BRAND NAME, no letters or numbers anywhere.',
    'Flat 2D print file seen straight on: no shoe silhouette, no shoe photo, no mockup, no 3D render, no perspective, no shadows, no laces, no sole, no model.',
    'Crisp, high resolution, print-ready for dye-sublimation, no watermark, no signature.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Prompt + format + placement d'un design de chaussure (all-over, fond conservé). */
export function footwearDesignPlan(opts: FootwearDesignOptions): PrintDesignPlan {
  return {
    prompt: footwearDesignPrompt(opts),
    aspectRatio: FOOTWEAR_DESIGN_ASPECT,
    placementStyle: 'all_over',
    keepBackground: true,
  };
}
