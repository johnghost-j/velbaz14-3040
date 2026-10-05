// Aperçu d'image au survol dans le chat (composant ImagePreview).
// Les logos sont des PNG transparents : l'aperçu les pose sur ce fond blanc,
// celui pour lequel ils sont dessinés, sinon un logo foncé disparaît sur la
// carte sombre.
export const PREVIEW_BACKDROP = '#FFFFFF';

/** Hauteur d'affichage à la proportion réelle de l'image, bornée à 100–300 px. */
export function previewHeight(width: number, naturalW: number, naturalH: number, fallback: number): number {
  if (!(naturalW > 0) || !(naturalH > 0)) return fallback;
  return Math.round(Math.min(Math.max((width * naturalH) / naturalW, 100), 300));
}
