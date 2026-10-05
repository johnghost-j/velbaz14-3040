// ─── Prompt de génération des artworks d'impression (Printify) ───────────────
// Un design imprimé n'est PAS une illustration carrée collée sur un vêtement.
// L'ancien prompt demandait une image « centrée sur fond blanc, composition
// carrée » : le résultat était un carré blanc imprimé sur le t-shirt, avec un
// dessin dedans. On demande maintenant un VRAI graphisme d'apparel :
//   - silhouette libre (pas de cadre, pas de panneau de fond, pas de bordure) ;
//   - style sérigraphie : formes pleines, palette réduite, contours nets ;
//   - marge blanche propre autour (le fond est détourné avant l'upload, voir
//     printify-artwork.ts — un coin non uniforme fait échouer le détourage).

export interface PrintDesignPromptOptions {
  /** Concept du design (une phrase décrivant ce qu'on veut voir). */
  concept: string;
  /** Couleurs de marque à respecter, ex. "#0f172a, #e11d48". */
  palette?: string;
  /** Type de produit, pour adapter la composition. */
  kind?: 'apparel' | 'flat' | 'mug' | 'accessory';
  /**
   * Texte EXACT à écrire sur le design. `null` = aucun texte (le modèle
   * inventait sinon un slogan : « SAUVAGES LOUPS » sur un mug « loup
   * minimaliste »). Absent = comportement historique (texte court autorisé).
   */
  text?: string | null;
}

/**
 * Texte demandé dans la demande : entre guillemets (« Wolf Pack »), ou
 * « écrit/texte/slogan … ». Le logo / le nom de la marque comptent aussi.
 * null = l'utilisateur n'a demandé aucun texte.
 */
export function requestedDesignText(request: string, brandName: string): string | null {
  const r = String(request || '');
  const quoted = r.match(/[«"“]\s*([^»"”]{1,40}?)\s*[»"”]/);
  if (quoted) return quoted[1];
  const written = r.match(/(?<!\p{L})(?:[ée]crit|[ée]crire|texte|slogan|inscription|marqu[ée])\s*:?\s*(.{1,40})$/iu);
  if (written) return written[1].replace(/[.!?]+$/, '').trim();
  if (/\b(logo|nom de (la|ma|notre) marque|notre nom|mon nom|brand name)\b/i.test(r) && brandName) return brandName;
  return null;
}

// Construit le prompt d'artwork prêt à imprimer.
export function printDesignPrompt(opts: PrintDesignPromptOptions): string {
  const concept = String(opts.concept || '').trim();
  const palette = String(opts.palette || '').trim();
  const kind = opts.kind || 'apparel';

  const composition =
    kind === 'apparel'
      ? 'Composition verticale ou carrée conçue pour une impression poitrine, lisible à 2 mètres.'
      : 'Composition équilibrée, lisible en petit format.';

  return [
    'Professional screen-print artwork for apparel — the exact graphic that gets printed, nothing else.',
    `Design concept: ${concept}.`,
    palette ? `Use only this brand palette: ${palette}.` : 'Limited palette of 2 to 4 flat colors.',
    // Le point critique : pas de cadre, pas de fond, pas de carré.
    'CRITICAL: the graphic must have a FREE ORGANIC SILHOUETTE. Absolutely NO rectangular or square background panel, NO frame, NO border, NO box, NO card, NO circle badge filling the canvas, NO backdrop shape behind the design — the shapes and letters ARE the design and the background around them stays completely empty.',
    'Style: bold silkscreen / vector illustration, flat solid color fills, thick confident shapes, crisp clean edges, strong negative space, high contrast, no gradients, no photographic texture, no drop shadow, no 3D render, no mockup, no garment, no model, no hanger.',
    opts.text === undefined
      ? 'Typography, if any: one short word or line, bold and perfectly spelled, integrated into the artwork, not floating on a plate.'
      : opts.text === null
        ? 'ABSOLUTELY NO TEXT: no letters, no words, no slogan, no brand name, no numbers anywhere in the artwork — illustration only.'
        : `The ONLY text in the artwork is exactly "${opts.text}", bold and perfectly spelled, integrated into the artwork, not floating on a plate. No other words.`,
    composition,
    // Aide le détourage automatique : fond blanc parfaitement uniforme et coins vides.
    'Background: pure uniform white (#FFFFFF), perfectly flat, with a clean even white margin all around — the artwork must NOT touch the canvas edges and the four corners must be empty white.',
    'No watermark, no signature, no text label, no color swatches, no grid, no paper texture.',
    'Make it a design someone would actually buy and wear.',
  ]
    .filter(Boolean)
    .join(' ');
}
