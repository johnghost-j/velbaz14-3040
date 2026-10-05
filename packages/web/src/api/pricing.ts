// ─── Prix de vente d'un produit Printify (pur, sans réseau ni base) ─────────
// [2026-10-01] Bug signalé : quand l'IA ajoutait un produit Printify au site,
// le prix affiché était un prix figé (25 €, ou celui inventé par l'IA) sans
// jamais regarder ce que Printify facture réellement. Sur une chaussure qui
// coûte 19,74 € à produire, le site vendait 25 € : quasiment rien de gagné.
//
// Règle : le prix de vente part du COÛT RÉEL Printify (champ `cost` de chaque
// variante, en centimes) et ajoute une vraie marge :
//   prix = max(coût × TARGET_MARKUP, coût + TARGET_PROFIT_MIN), arrondi en .99
// Un prix demandé (IA ou utilisateur) plus élevé est conservé ; un prix plus
// bas est relevé. Jamais de vente à perte, jamais de marge symbolique.

export const TARGET_MARKUP = 1.8; // coût × 1,8 → ~45 % de marge sur le prix de vente
export const TARGET_PROFIT_MIN = 10; // au moins +10 € par article (couvre frais Stripe, retours…)

// Arrondi commercial au .99 SUPÉRIEUR (ou égal) : 35,53 → 35,99 ; 36,00 → 36,99.
export function ceilTo99(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const base = Math.floor(value);
  const candidate = base + 0.99;
  return Number((candidate >= value - 1e-9 ? candidate : base + 1.99).toFixed(2));
}

// Prix de vente cible pour un coût fournisseur (unité monétaire, pas centimes).
export function targetRetailFor(cost: number): number {
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  return ceilTo99(Math.max(cost * TARGET_MARKUP, cost + TARGET_PROFIT_MIN));
}

// Marge en % du prix de vente (null si non calculable).
export function marginPercent(retail: number | null | undefined, cost: number | null | undefined): number | null {
  if (retail == null || cost == null || !Number.isFinite(retail) || !Number.isFinite(cost) || retail <= 0 || cost <= 0) return null;
  return Number((((retail - cost) / retail) * 100).toFixed(1));
}

export interface CostedVariant {
  id: number;
  cost: number; // centimes, tel que renvoyé par Printify
  is_enabled: boolean;
}

export interface VariantPricing {
  /** Prix de vente par id de variante Printify, en centimes. */
  priceCents: Map<number, number>;
  /** Coût le plus élevé des variantes actives (unité monétaire). */
  costPrice: number;
  /** Prix « à partir de » : le plus bas des variantes actives (unité monétaire). */
  retailPrice: number;
  /** Marge (%) du prix « à partir de » sur le coût le plus élevé (conservateur). */
  margin: number | null;
}

// Calcule le prix de chaque variante à partir de son coût réel. Le prix d'une
// variante = max(prix demandé, prix cible de SA variante, prix cible du coût le
// plus élevé) — la dernière borne garantit que même le prix « à partir de »
// couvre largement la variante la plus chère à produire (le garde-fou checkout
// compare au coût max). Renvoie null si aucun coût n'est connu.
export function priceVariantsFromCost(
  variants: CostedVariant[],
  requestedCents?: number | null,
): VariantPricing | null {
  const known = variants.filter((v) => v.id > 0 && Number.isFinite(v.cost) && v.cost > 0);
  const pool = known.filter((v) => v.is_enabled).length ? known.filter((v) => v.is_enabled) : known;
  if (!pool.length) return null;
  const maxCost = Math.max(...pool.map((v) => v.cost)) / 100;
  const floorAll = targetRetailFor(maxCost);
  const requested = requestedCents != null && Number.isFinite(requestedCents) && requestedCents > 0 ? requestedCents / 100 : 0;
  const priceCents = new Map<number, number>();
  for (const v of variants) {
    if (!(v.id > 0)) continue;
    const own = v.cost > 0 ? targetRetailFor(v.cost / 100) : floorAll;
    const price = Math.max(requested, own, floorAll);
    priceCents.set(v.id, Math.round(price * 100));
  }
  const enabledPrices = pool.map((v) => priceCents.get(v.id) || 0).filter((c) => c > 0);
  const retailPrice = Number(((enabledPrices.length ? Math.min(...enabledPrices) : Math.round(floorAll * 100)) / 100).toFixed(2));
  return {
    priceCents,
    costPrice: Number(maxCost.toFixed(2)),
    retailPrice,
    margin: marginPercent(retailPrice, maxCost),
  };
}

// Réécrit les prix d'un champ `variants` (JSON en base) avec les nouveaux prix.
// Deux formes existent : un tableau [{vid,label,price}] (aperçu de marque) ou
// un objet { …, printifyVariants: [{vid,label,price}] } (création depuis le
// chat). Les variantes sans prix connu prennent `fallback`. Pur → testable.
export function repriceVariantsJson(
  raw: string | null | undefined,
  priceByVid: Map<number, number> | null,
  fallback: number,
): string | null {
  if (!raw) return raw ?? null;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  const fix = (list: any[]) => list.map((v) => {
    if (!v || typeof v !== 'object') return v;
    const cents = priceByVid?.get(Number(v.vid));
    const price = cents != null ? Number((cents / 100).toFixed(2)) : fallback;
    return { ...v, price: Math.max(Number(v.price) || 0, price) };
  });
  if (Array.isArray(parsed)) return JSON.stringify(fix(parsed));
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.printifyVariants)) {
    return JSON.stringify({ ...parsed, printifyVariants: fix(parsed.printifyVariants) });
  }
  return raw;
}
