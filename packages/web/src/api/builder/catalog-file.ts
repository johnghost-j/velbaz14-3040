import type { DropshipCatalogItem } from "./routes";

// Fichier src/lib/catalog.ts injecté dans le site généré : catalogue réel.
export function catalogFileContent(catalog: DropshipCatalogItem[]): string {
  return `// ─── CATALOGUE RÉEL (généré par Velbaz — produits sourcés fournisseur) ───────
// Ne PAS inventer de produits : ce catalogue est la source de vérité.
// checkout() avec productId + vid déclenche la commande fournisseur automatique.
export interface CatalogVariant { vid: string | null; label: string; priceCents: number | null; }
export interface CatalogProduct {
  id: string; name: string; description: string | null;
  priceCents: number; currency: string; imageUrl: string | null;
  /** Galerie de la fiche produit (images[0] === imageUrl). */
  images: string[];
  supplier: string; variants: CatalogVariant[];
}
export const CATALOG: CatalogProduct[] = ${JSON.stringify(catalog, null, 2)};
export function findProduct(id: string): CatalogProduct | undefined {
  return CATALOG.find((p) => p.id === id);
}
// Sépare les libellés de variantes en TAILLES et COULEURS selon leur CONTENU
// (l'ordre "Couleur / Taille" ou "Taille / Couleur" dépend du fournisseur).
const SIZE_RE = /^(?:(?:EU|US|UK|FR|IT|JP|CN)\\s*)?\\d{1,3}(?:[.,]\\d)?(?:\\s*(?:cm|mm|ml|l|oz|g|kg|in|"))?$|^(?:XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|One size|Taille unique)$/i;
export function isSizeLabel(part: string): boolean { return SIZE_RE.test(part.trim()); }
export function variantOptions(p: CatalogProduct) {
  const sizes: string[] = []; const colors: string[] = [];
  const parse = (v: CatalogVariant) => {
    const parts = v.label.split(" / ").map((x) => x.trim()).filter(Boolean);
    const size = parts.find(isSizeLabel) ?? null;
    const color = parts.filter((x) => x !== size).join(" / ") || null;
    return { size, color };
  };
  for (const v of p.variants) {
    const { size, color } = parse(v);
    if (size && !sizes.includes(size)) sizes.push(size);
    if (color && !colors.includes(color)) colors.push(color);
  }
  /** Variante correspondant au choix (null si pas encore choisie / inexistante). */
  const find = (color: string | null, size: string | null): CatalogVariant | null =>
    p.variants.find((v) => { const o = parse(v); return (o.color ?? null) === (colors.length ? color : null) && (o.size ?? null) === (sizes.length ? size : null); }) ?? null;
  return { sizes, colors, find };
}
`;
}
