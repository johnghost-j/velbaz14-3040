/**
 * Choix de LA photo qui représente un produit.
 * ---------------------------------------------------------------------------
 * [2026-09-25] Un produit accumule plusieurs lignes dans `product_images`, et
 * toutes ne sont PAS des photos du produit :
 *
 *   type              | ce que c'est                         | montrable ?
 *   ------------------+--------------------------------------+------------
 *   printify/mockup   | photo du produit réellement fabriqué | OUI (priorité)
 *   supplier          | photo du fournisseur                 | OUI (priorité)
 *   ai_mockup, hero,  | packshot généré par l'IA              | oui (repli)
 *   studio, model…    |                                      |
 *   reference_sheet   | planche technique 3 vues front/side/back | NON
 *   print_design      | motif à imprimer, à plat              | NON
 *   print             | fichier print-ready upscalé 4x       | NON
 *
 * Les deux bugs constatés par un compte de test venaient de là : le tri se
 * faisait sur le seul `sortOrder`, et la planche technique — insérée sans
 * `sortOrder` explicite, donc 0, à égalité avec le mockup réel, mais AVANT lui —
 * gagnait. La vitrine affichait donc un dessin technique en trois vues (perçu
 * comme une « image buguée ») ou un swatch de motif (« pas le produit ») au lieu
 * de la photo.
 *
 * D'où ce module unique : un seul endroit décide, pour la vitrine du site généré
 * comme pour le visuel produit d'une publicité.
 */

/** Documents de production — jamais des photos de produit. */
export const NON_PHOTO_IMAGE_TYPES = new Set([
  "reference_sheet", // planche technique 3 vues (front/side/back)
  "print_design",    // motif/artwork à imprimer (swatch à plat)
  "print",           // fichier print-ready upscalé 4x
  "design",
  "artwork",
  "pattern",
  "logo",
]);

/** Produit RÉELLEMENT fabriqué ou sourcé : sa photo passe devant tout visuel IA. */
export const REAL_PRODUCT_IMAGE_TYPES = new Set(["printify", "mockup", "supplier"]);

/**
 * [2026-10-04] Photos de PRÉSENTATION professionnelles (product-presentation.ts) :
 * générées À PARTIR des vues réelles du produit (mockups Printify, photos
 * fournisseur) — c'est le produit fabriqué, mis en scène en studio / en
 * situation. Elles passent devant le mockup brut : c'est la vitrine que
 * l'utilisateur a demandée. Les mockups réels restent dans la galerie.
 */
export const PRESENTATION_IMAGE_TYPES = new Set(["presentation"]);

export interface ProductPhotoRow {
  id: string;
  type: string;
  imageData: string | null;
  sortOrder: number | null;
  createdAt?: Date | null;
}

function photoRank(type: string): number {
  if (PRESENTATION_IMAGE_TYPES.has(type)) return 0;
  if (REAL_PRODUCT_IMAGE_TYPES.has(type)) return 1;
  return 2;
}

/** Ordre de vitrine : présentation pro, puis produit réel, puis visuels IA. */
function shopOrder<T extends ProductPhotoRow>(imgs: T[]): T[] {
  return imgs
    .filter((i) => !!i.imageData && !NON_PHOTO_IMAGE_TYPES.has(i.type))
    .sort((a, b) => {
      // 1. La présentation pro (issue des vues réelles) d'abord, puis le
      //    produit réel brut : on ne montre pas un visuel inventé par l'IA
      //    quand la photo de l'article fabriqué existe.
      const ra = photoRank(a.type);
      const rb = photoRank(b.type);
      if (ra !== rb) return ra - rb;
      // 2. Puis l'ordre voulu par le pipeline.
      const sa = a.sortOrder ?? 0;
      const sb = b.sortOrder ?? 0;
      if (sa !== sb) return sa - sb;
      // 3. À égalité, la plus récente (une régénération remplace l'ancienne).
      return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
    });
}

/**
 * Renvoie la meilleure photo parmi les images d'un produit, ou `null` s'il n'en
 * existe aucune. Les documents de production sont ÉCARTÉS (jamais rétrogradés) :
 * mieux vaut aucune image — l'appelant a un repli propre — qu'un dessin
 * technique présenté comme la photo du produit.
 */
export function pickShopPhoto<T extends ProductPhotoRow>(imgs: T[]): T | null {
  return shopOrder(imgs)[0] ?? null;
}

/**
 * Galerie de la fiche produit : toutes les photos montrables, dans l'ordre de
 * vitrine (la 1re est toujours `pickShopPhoto`), sans doublon d'image.
 */
export function pickShopGallery<T extends ProductPhotoRow>(imgs: T[], max = 6): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of shopOrder(imgs)) {
    const key = i.imageData!;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
    if (out.length >= max) break;
  }
  return out;
}
