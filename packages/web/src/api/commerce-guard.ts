// ─── Garde-fous commerce (paiement & prix) ───────────────────────────────────
// Deux règles NON NÉGOCIABLES pour tout site généré qui encaisse de l'argent :
//
//  RÈGLE 1 — AUCUN PAIEMENT SANS PRODUIT RÉEL.
//    Un client ne peut jamais payer un article qui n'existe pas dans le
//    catalogue réel de l'entreprise (table `products`). La session Stripe est
//    REFUSÉE avant tout encaissement si une ligne du panier ne correspond pas à
//    un produit existant, publié et avec un prix. Le prix facturé est TOUJOURS
//    celui de la base (jamais celui envoyé par le navigateur) : plus de panier
//    falsifiable, plus de "boutique vitrine" qui encaisse dans le vide.
//
//  RÈGLE 2 — UN PRODUIT PRINTIFY SE VEND PLUS CHER QU'IL NE COÛTE.
//    Dès qu'un produit est lié à Printify (`printifyProductId`), son prix de
//    vente doit être STRICTEMENT supérieur au coût de production réel facturé
//    par Printify (champ `cost` des variantes, lu en direct sur l'API). Sinon
//    le prix est corrigé vers le haut (marge mini) côté Velbaz ET côté Printify,
//    et tant qu'un prix reste sous le coût, la vente est bloquée : on ne vend
//    jamais à perte.
//
// Ces garde-fous ne dépendent d'AUCUNE clé API pour bloquer : sans token
// Printify on retombe sur le coût enregistré en base ; sans coût connu on ne
// corrige rien mais on n'invente rien non plus.

import { db } from './database/index';
import * as schema from './database/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import * as printify from './printify';
import { resolvePrintifyConfig } from './printify-config';
import { priceVariantsFromCost, repriceVariantsJson, targetRetailFor, marginPercent } from './pricing';

export { targetRetailFor, TARGET_MARKUP, TARGET_PROFIT_MIN } from './pricing';

// ── Réglages ────────────────────────────────────────────────────────────────
// Marge minimale appliquée quand un prix doit être corrigé (40 % au-dessus du
// coût Printify, et au moins +2 € pour les tout petits articles).
export const MIN_MARGIN_RATE = 0.4;
export const MIN_MARGIN_ABS = 2;

// Statuts d'un produit réellement achetable. `concept` (défaut) = brouillon.
export const PURCHASABLE_STATUSES: ReadonlySet<string> = new Set(['active', 'published', 'live', 'in_stock']);

export const MAX_QUANTITY = 100;

// ── Types ───────────────────────────────────────────────────────────────────
export interface GuardVariant {
  vid: string | null;
  label: string;
  price: number | null; // prix de vente de la variante (unité monétaire, pas centimes)
}

export interface GuardProduct {
  id: string;
  name: string;
  status: string | null;
  retailPrice: number | null;
  costPrice: number | null;
  printifyProductId: string | null;
  variants: GuardVariant[];
}

export interface CheckoutItemInput {
  productId?: string | null;
  vid?: string | null;
  quantity?: number | null;
  name?: string | null;
  amount?: number | null; // centimes (client) — le prix AFFICHÉ ; doit correspondre au catalogue (sinon refus price_changed)
  currency?: string | null;
  interval?: string | null;
}

export interface ResolvedCheckoutItem {
  productId: string | null;
  vid: string | null;
  quantity: number;
  name: string;
  unitAmountCents: number;
  currency: string;
  interval?: string;
}

export interface RejectedCheckoutItem {
  index: number;
  productId: string | null;
  reason: string;
  message: string;
  minPriceCents?: number;
  currentPriceCents?: number;
}

export type CheckoutGuardResult =
  | { ok: true; items: ResolvedCheckoutItem[]; totalCents: number; currency: string }
  | { ok: false; code: string; message: string; rejected: RejectedCheckoutItem[] };

// ── Prix plancher ───────────────────────────────────────────────────────────
// Prix de vente minimum acceptable pour un coût fournisseur donné : coût + 40 %
// (au moins coût + 2 €), arrondi en .99 — donc TOUJOURS strictement > coût.
export function minRetailFor(costPrice: number): number {
  if (!Number.isFinite(costPrice) || costPrice <= 0) return 0;
  const target = Math.max(costPrice * (1 + MIN_MARGIN_RATE), costPrice + MIN_MARGIN_ABS);
  const nice = Math.floor(target) + 0.99;
  return Number((nice > costPrice ? nice : Number((costPrice + 0.99).toFixed(2))).toFixed(2));
}

// Le prix de vente couvre-t-il le coût fournisseur ? (strictement supérieur)
export function coversCost(retailPrice: number | null | undefined, costPrice: number | null | undefined): boolean {
  if (costPrice == null || !Number.isFinite(costPrice) || costPrice <= 0) return true; // coût inconnu → rien à comparer
  if (retailPrice == null || !Number.isFinite(retailPrice)) return false;
  return retailPrice > costPrice;
}

// [2026-10-01] « Le prix écrit sur le site doit être le prix payé sur Stripe. »
// Le navigateur envoie le prix qu'il AFFICHE (centimes). S'il diffère du prix
// réel du catalogue (site resté sur un ancien prix, panier falsifié), on ne
// facture JAMAIS un autre montant que celui vu par l'acheteur : on refuse, on
// annonce le bon prix et le site est resynchronisé. Tolérances : montant
// absent (rien à comparer), arrondi d'un centime, prix envoyé en euros, ou
// total de ligne (prix × quantité).
export function clientPriceMatches(amount: unknown, unitCents: number, quantity = 1): boolean {
  if (amount == null || amount === '') return true;
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return true;
  if (Math.abs(a - unitCents) <= 1) return true;
  if (Math.abs(a * 100 - unitCents) <= 1) return true;
  if (quantity > 1 && Math.abs(a - unitCents * quantity) <= 1) return true;
  return false;
}

export function formatEuros(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

function clampQuantity(q: unknown): number {
  const n = Math.floor(Number(q ?? 1));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_QUANTITY);
}

function parseVariants(raw: string | null | undefined): GuardVariant[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 200).map((v: any) => ({
      vid: v?.vid != null ? String(v.vid) : null,
      label: String(v?.label ?? ''),
      price: v?.price != null && Number.isFinite(Number(v.price)) ? Number(v.price) : null,
    }));
  } catch {
    return [];
  }
}

export function toGuardProduct(row: typeof schema.products.$inferSelect): GuardProduct {
  return {
    id: row.id,
    name: row.name,
    status: row.status ?? null,
    retailPrice: row.retailPrice ?? null,
    costPrice: row.costPrice ?? null,
    printifyProductId: row.printifyProductId ?? null,
    variants: parseVariants(row.variants),
  };
}

// ── RÈGLE 1 (cœur pur, testable) ────────────────────────────────────────────
// Confronte le panier au catalogue réel et renvoie les lignes AUTORITAIRES
// (nom + prix issus de la base). Toute ligne non adossée à un vrai produit fait
// échouer l'ensemble : on ne crée pas de session de paiement partielle.
export function resolveItemsAgainstCatalog(
  products: GuardProduct[],
  items: CheckoutItemInput[],
  opts?: { mode?: string; currency?: string },
): CheckoutGuardResult {
  const mode = opts?.mode === 'subscription' ? 'subscription' : 'payment';
  const currency = (opts?.currency || 'eur').toLowerCase();
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: 'no_items', message: 'Panier vide : rien à payer.', rejected: [] };
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  const resolved: ResolvedCheckoutItem[] = [];
  const rejected: RejectedCheckoutItem[] = [];

  items.forEach((raw, index) => {
    const productId = raw?.productId ? String(raw.productId) : null;
    const quantity = clampQuantity(raw?.quantity);

    // Ligne sans référence produit : tolérée UNIQUEMENT pour un abonnement
    // (plan récurrent, il n'y a pas d'article physique à livrer).
    if (!productId) {
      if (mode === 'subscription') {
        const cents = Math.round(Number(raw?.amount ?? 0));
        if (!Number.isFinite(cents) || cents <= 0) {
          rejected.push({
            index, productId: null, reason: 'plan_without_price',
            message: "Abonnement sans montant valide : paiement refusé.",
          });
          return;
        }
        resolved.push({
          productId: null, vid: null, quantity,
          name: String(raw?.name || 'Abonnement').slice(0, 120),
          unitAmountCents: cents,
          currency: (raw?.currency || currency).toLowerCase(),
          interval: raw?.interval ? String(raw.interval) : 'month',
        });
        return;
      }
      rejected.push({
        index, productId: null, reason: 'no_product_reference',
        message: `"${String(raw?.name || 'Article')}" ne correspond à aucun produit du catalogue : paiement refusé.`,
      });
      return;
    }

    const product = byId.get(productId);
    if (!product) {
      rejected.push({
        index, productId, reason: 'product_not_found',
        message: `Produit introuvable dans le catalogue (${productId}) : paiement refusé.`,
      });
      return;
    }
    if (!PURCHASABLE_STATUSES.has(String(product.status || '').toLowerCase())) {
      rejected.push({
        index, productId, reason: 'product_not_published',
        message: `"${product.name}" n'est pas encore un produit publié (statut ${product.status || 'inconnu'}) : paiement refusé.`,
      });
      return;
    }

    // Variante : si une variante est demandée, elle doit exister.
    let variant: GuardVariant | null = null;
    const vid = raw?.vid != null && String(raw.vid) !== '' ? String(raw.vid) : null;
    const realVariants = product.variants.filter((v) => v.vid);
    if (vid) {
      variant = product.variants.find((v) => v.vid === vid) || null;
      if (!variant) {
        rejected.push({
          index, productId, reason: 'variant_not_found',
          message: `Variante inconnue pour "${product.name}" : paiement refusé.`,
        });
        return;
      }
    } else if (realVariants.length === 1) {
      // Un seul choix possible (ex: taille unique) : pas d'ambiguïté, on
      // sélectionne automatiquement l'unique variante réelle du produit.
      variant = realVariants[0];
    } else if (realVariants.length > 1) {
      // RÈGLE 1bis — VRAIE PERSONNALISATION OBLIGATOIRE : un produit avec
      // plusieurs variantes réelles (taille/couleur/option Printify) ne peut
      // JAMAIS être acheté sans que le client ait choisi LAQUELLE. Sans ce
      // garde-fou, un panier sans "vid" passerait quand même (au prix du
      // produit) et le fulfillment devrait deviner une variante au hasard —
      // le client recevrait potentiellement une taille/couleur différente de
      // celle qu'il croyait commander. On refuse plutôt que d'inventer.
      rejected.push({
        index, productId, reason: 'variant_required',
        message: `Choisis une option (taille/couleur/modèle) pour "${product.name}" avant d'acheter : paiement refusé.`,
      });
      return;
    }

    const retail = variant?.price != null ? variant.price : product.retailPrice;
    if (retail == null || !Number.isFinite(retail) || retail <= 0) {
      rejected.push({
        index, productId, reason: 'product_without_price',
        message: `"${product.name}" n'a pas de prix de vente : paiement refusé.`,
      });
      return;
    }

    // RÈGLE 2 en dernier rempart : jamais de vente sous le coût fournisseur.
    if (!coversCost(retail, product.costPrice)) {
      rejected.push({
        index, productId, reason: 'price_below_supplier_cost',
        message: `"${product.name}" est affiché à ${retail.toFixed(2)} € alors qu'il coûte ${Number(product.costPrice).toFixed(2)} € chez le fournisseur : vente bloquée (prix à corriger).`,
        minPriceCents: Math.round(minRetailFor(Number(product.costPrice)) * 100),
      });
      return;
    }

    const unitCents = Math.round(retail * 100);
    if (!clientPriceMatches(raw?.amount, unitCents, quantity)) {
      const shown = Number(raw?.amount);
      rejected.push({
        index, productId, reason: 'price_changed',
        message: `Le prix de « ${product.name} » a changé : ${formatEuros(unitCents)} (le site affichait ${formatEuros(Math.round(shown))}). Recharge la page pour voir le bon prix avant de payer.`,
        currentPriceCents: unitCents,
      });
      return;
    }

    resolved.push({
      productId: product.id,
      // IMPORTANT : vid RÉSOLU (celui de `variant`, y compris quand il a été
      // auto-sélectionné pour un produit à variante unique), jamais le vid brut
      // du navigateur — sinon la personnalisation choisie/déduite se perd entre
      // le checkout et la commande fournisseur (metadata Stripe → orderItems).
      vid: variant?.vid ?? vid,
      quantity,
      name: variant?.label ? `${product.name} — ${variant.label}`.slice(0, 120) : product.name.slice(0, 120),
      unitAmountCents: unitCents,
      currency,
    });
  });

  if (rejected.length) {
    return {
      ok: false,
      code: rejected.every((r) => r.reason === 'price_changed') ? 'price_changed'
        : rejected.length === items.length ? rejected[0].reason : 'cart_has_unknown_items',
      message: rejected[0].message,
      rejected,
    };
  }
  const totalCents = resolved.reduce((s, it) => s + it.unitAmountCents * it.quantity, 0);
  return { ok: true, items: resolved, totalCents, currency };
}

// ── RÈGLE 1 (accès base) ────────────────────────────────────────────────────
export async function resolveCheckoutItems(
  companyId: string,
  items: CheckoutItemInput[],
  opts?: { mode?: string; currency?: string },
): Promise<CheckoutGuardResult> {
  const ids = Array.from(new Set((items || []).map((i) => (i?.productId ? String(i.productId) : '')).filter(Boolean)));
  let rows: Array<typeof schema.products.$inferSelect> = [];
  if (ids.length) {
    rows = await db.select().from(schema.products)
      .where(and(eq(schema.products.companyId, companyId), inArray(schema.products.id, ids)));
  }
  const result = resolveItemsAgainstCatalog(rows.map(toGuardProduct), items, opts);
  // Le site affiche un ancien prix → on le remet à jour tout de suite.
  if (!result.ok && result.rejected.some((r) => r.reason === 'price_changed')) notifyPriceChanged(companyId, 'checkout');
  return result;
}

// ── Prix modifié → le site doit le refléter ─────────────────────────────────
// index.ts enregistre ici la resynchronisation du catalogue du site (fichier
// src/lib/catalog.ts), pour que le prix affiché suive le prix réel facturé.
let priceChangedHook: ((companyId: string, why: string) => void) | null = null;
export function onPriceChanged(fn: (companyId: string, why: string) => void): void { priceChangedHook = fn; }
export function notifyPriceChanged(companyId: string, why: string): void {
  try { priceChangedHook?.(companyId, why); } catch { /* best-effort */ }
}

// ── RÈGLE 2 : coût réel Printify ────────────────────────────────────────────
// Résolution partagée : secrets entreprise → secret store global → env
// (cf. printify-config.ts). Sans token, on retombe sur le coût stocké en base.
async function loadPrintifyConfig(companyId: string): Promise<printify.PrintifyConfig | null> {
  return resolvePrintifyConfig(companyId);
}

export interface PrintifyCostInfo {
  // Coût de production réel le plus élevé parmi les variantes actives (en unité
  // monétaire). `null` = coût inconnu (pas de token, produit absent, API muette).
  costPrice: number | null;
  source: 'printify_api' | 'stored' | 'unknown';
  // Variantes brutes Printify (id/price/cost/is_enabled) pour pouvoir repousser
  // un prix corrigé sur la boutique Printify.
  variants: Array<{ id: number; price: number; cost: number; is_enabled: boolean }>;
}

// Extrait le coût (le plus élevé des variantes actives) d'une réponse produit
// Printify. Pur → testable sans réseau.
export function costFromPrintifyProduct(data: any): PrintifyCostInfo {
  const raw: any[] = Array.isArray(data?.variants) ? data.variants : [];
  const variants = raw
    .map((v) => ({
      id: Number(v?.id) || 0,
      price: Number(v?.price) || 0,
      cost: Number(v?.cost) || 0,
      is_enabled: v?.is_enabled !== false,
    }))
    .filter((v) => v.id > 0);
  const enabled = variants.filter((v) => v.is_enabled && v.cost > 0);
  const pool = enabled.length ? enabled : variants.filter((v) => v.cost > 0);
  if (!pool.length) return { costPrice: null, source: 'unknown', variants };
  const maxCostCents = Math.max(...pool.map((v) => v.cost));
  return { costPrice: Number((maxCostCents / 100).toFixed(2)), source: 'printify_api', variants };
}

// Coût réel d'un produit Printify, lu en direct sur l'API quand c'est possible,
// sinon le coût déjà enregistré en base (jamais une invention).
export async function printifyCost(
  companyId: string,
  product: { printifyProductId: string | null; costPrice: number | null },
  cfgIn?: printify.PrintifyConfig | null,
): Promise<PrintifyCostInfo> {
  const stored: PrintifyCostInfo = {
    costPrice: product.costPrice != null && product.costPrice > 0 ? product.costPrice : null,
    source: product.costPrice != null && product.costPrice > 0 ? 'stored' : 'unknown',
    variants: [],
  };
  if (!product.printifyProductId) return stored;
  const cfg = cfgIn ?? (await loadPrintifyConfig(companyId));
  if (!cfg) return stored;
  try {
    const shopId = cfg.shopId || (await printify.resolveShopId(cfg));
    if (!shopId) return stored;
    const res = await printify.getProduct({ ...cfg, shopId }, product.printifyProductId);
    if (!res.ok || !res.data) return stored;
    const info = costFromPrintifyProduct(res.data);
    if (info.costPrice == null) return { ...stored, variants: info.variants };
    return info;
  } catch {
    return stored;
  }
}

export interface FloorEnforcement {
  productId: string;
  printifyProductId: string | null;
  costPrice: number | null;
  costSource: PrintifyCostInfo['source'];
  previousRetail: number | null;
  retailPrice: number | null;
  corrected: boolean;
  pushedToPrintify: boolean;
  blocked: boolean; // prix toujours invalide (coût inconnu impossible à couvrir)
  reason?: string;
}

// Applique la RÈGLE 2 à un produit : le prix de vente passe au-dessus du coût
// Printify (correction vers le haut), en base ET sur la boutique Printify.
export async function enforcePrintifyFloor(
  companyId: string,
  productId: string,
  opts?: {
    cfg?: printify.PrintifyConfig | null;
    pushToPrintify?: boolean;
    costInfo?: PrintifyCostInfo;
    /**
     * 'floor' (défaut) : ne corrige que les prix qui ne couvrent pas le coût
     * (+40 % mini) — respecte un prix choisi à la main par l'utilisateur.
     * 'target' : produit ajouté par l'IA → prix relevé jusqu'au prix cible
     * (coût × 1,8, au moins +10 €, cf. pricing.ts) pour vraiment gagner de
     * l'argent. Un prix déjà plus haut n'est jamais baissé.
     */
    mode?: 'floor' | 'target';
  },
): Promise<FloorEnforcement> {
  const row = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), eq(schema.products.id, productId))).get();
  if (!row) {
    return {
      productId, printifyProductId: null, costPrice: null, costSource: 'unknown',
      previousRetail: null, retailPrice: null, corrected: false, pushedToPrintify: false,
      blocked: true, reason: 'product_not_found',
    };
  }
  const info = opts?.costInfo ?? (await printifyCost(companyId, { printifyProductId: row.printifyProductId ?? null, costPrice: row.costPrice ?? null }, opts?.cfg));
  const previousRetail = row.retailPrice ?? null;

  if (info.costPrice == null) {
    return {
      productId, printifyProductId: row.printifyProductId ?? null,
      costPrice: null, costSource: info.source, previousRetail, retailPrice: previousRetail,
      corrected: false, pushedToPrintify: false,
      blocked: previousRetail == null || previousRetail <= 0,
      reason: 'cost_unknown',
    };
  }

  const cost = info.costPrice;
  const target = opts?.mode === 'target';
  const wanted = target ? targetRetailFor(cost) : minRetailFor(cost);
  const needsFix = target
    ? previousRetail == null || !Number.isFinite(previousRetail) || previousRetail < wanted
    : !coversCost(previousRetail, cost);
  const retailPrice = needsFix ? wanted : (previousRetail as number);
  const margin = marginPercent(retailPrice, cost);

  // Prix par variante Printify (coût propre de chaque variante) : en mode
  // cible, calculés par pricing.ts ; en mode plancher, prix unique corrigé.
  const variantPricing = target && info.variants.length
    ? priceVariantsFromCost(info.variants.map((v) => ({ id: v.id, cost: v.cost, is_enabled: v.is_enabled })), Math.round(retailPrice * 100))
    : null;

  const patch: Record<string, any> = { costPrice: cost, margin };
  if (needsFix) {
    patch.retailPrice = retailPrice;
    // Les variantes en base portent AUSSI un prix (c'est lui que le checkout
    // facture quand une taille/couleur est choisie) : sans cette mise à jour,
    // le prix du produit montait mais la variante restait à l'ancien prix.
    const repriced = repriceVariantsJson(row.variants, variantPricing?.priceCents ?? null, retailPrice);
    if (repriced !== row.variants) patch.variants = repriced;
  }
  if (row.costPrice !== cost || needsFix || row.margin !== margin) {
    await db.update(schema.products).set(patch).where(eq(schema.products.id, row.id));
    if (needsFix) notifyPriceChanged(companyId, 'floor');
  }

  // Aligner la boutique Printify sur le prix corrigé (best-effort : une API
  // muette ne doit pas annuler la correction déjà enregistrée côté Velbaz).
  let pushedToPrintify = false;
  if (needsFix && opts?.pushToPrintify !== false && row.printifyProductId && info.variants.length) {
    try {
      const cfg = opts?.cfg ?? (await loadPrintifyConfig(companyId));
      if (cfg) {
        const shopId = cfg.shopId || (await printify.resolveShopId(cfg));
        if (shopId) {
          const cents = Math.round(retailPrice * 100);
          const res = await printify.updateProduct({ ...cfg, shopId }, row.printifyProductId, {
            variants: info.variants.map((v) => ({
              id: v.id,
              price: variantPricing?.priceCents.get(v.id)
                ?? (v.cost > 0 && cents <= v.cost ? Math.round(minRetailFor(v.cost / 100) * 100) : cents),
              is_enabled: v.is_enabled,
            })),
          });
          pushedToPrintify = !!res.ok;
        }
      }
    } catch { /* correction locale conservée */ }
  }

  return {
    productId, printifyProductId: row.printifyProductId ?? null,
    costPrice: cost, costSource: info.source,
    previousRetail, retailPrice,
    corrected: needsFix, pushedToPrintify,
    blocked: false,
  };
}

// Applique la RÈGLE 2 à TOUS les produits Printify d'une entreprise.
export async function enforcePrintifyFloorAll(companyId: string, mode: 'floor' | 'target' = 'floor'): Promise<FloorEnforcement[]> {
  const rows = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), isNotNull(schema.products.printifyProductId)));
  const cfg = await loadPrintifyConfig(companyId);
  const out: FloorEnforcement[] = [];
  for (const r of rows) {
    out.push(await enforcePrintifyFloor(companyId, r.id, { cfg, mode }));
  }
  return out;
}
