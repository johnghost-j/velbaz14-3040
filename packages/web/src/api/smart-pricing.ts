// ─── Prix intelligent (équivalent du « Pricing tool » Printify) ─────────────
// [2026-10-01] Demande : « Printify a un système qui dit si le prix mis sur un
// produit est trop bas ou trop haut. Utilise ce système pour donner le prix
// parfait, et tu le mets. »
//
// Constat (vérifié sur l'API réelle, lecture seule) : le « Pricing tool » de
// Printify (fourchette de prix conseillée, verdict trop bas / trop haut,
// bouton Optimize) n'existe QUE dans leur tableau de bord. L'API publique ne
// renvoie aucun champ de suggestion (`GET /shops/{id}/products/{id}.json` →
// variantes avec `cost` et `price` seulement ; les routes « pricing » → 404).
// En plus, ce tool s'appuie sur les ventes d'une boutique Etsy/Shopify
// connectée : la boutique API de Velbaz est « disconnected ».
//
// On reproduit donc la même logique, avec les données réelles qu'on a :
//   1. coût de production réel Printify (variante la plus chère, API live) ;
//   2. frais de port Printify vers le pays principal de la boutique — le site
//      offre la livraison (Stripe ne facture pas de port), donc ils sortent de
//      la marge, exactement comme l'option « Free shipping » du Pricing tool ;
//   3. conversion USD → EUR (Printify facture en USD, le site vend en EUR) ;
//   4. frais Stripe (cartes UE : 1,5 % + 0,25 €) ;
//   5. fourchette de prix du marché pour ce TYPE de produit (repères marché
//      français, marques indépendantes / print-on-demand).
// Résultat : un verdict (trop bas / dans la fourchette / trop haut) et un prix
// recommandé en .99, rentable ET dans la fourchette du marché.
//
// Ce fichier est PUR (aucun réseau, aucune base) → testable unitairement.
// L'application réelle (base + Printify + catalogue du site) est dans
// smart-pricing-service.ts.

import { ceilTo99, TARGET_MARKUP, TARGET_PROFIT_MIN } from './pricing';

// ── Réglages ────────────────────────────────────────────────────────────────
export const STRIPE_FEE_RATE = 0.015; // cartes européennes standard
export const STRIPE_FEE_FIXED = 0.25;
// Bénéfice NET minimal (après production, port et Stripe) pour qu'un prix soit
// acceptable : 25 % du prix ET au moins 5 € par article.
export const MIN_NET_RATE = 0.25;
export const MIN_NET_ABS = 5;
// Sans repère de marché connu : la fourchette va du plancher à 3× le coût.
export const NO_MARKET_HIGH_MULTIPLE = 3;

// .99 inférieur ou égal : 65,00 → 64,99 ; 64,99 → 64,99 ; 64,50 → 63,99.
export function floorTo99(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const base = Math.floor(value);
  const candidate = base + 0.99;
  const out = candidate <= value + 1e-9 ? candidate : base - 0.01;
  return Number(Math.max(0, out).toFixed(2));
}

const r2 = (n: number) => Number(n.toFixed(2));

export function stripeFee(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return r2(price * STRIPE_FEE_RATE + STRIPE_FEE_FIXED);
}

// Ce qu'il reste vraiment dans la poche par article vendu.
export function netProfit(price: number, landedCost: number): number {
  return r2(price - stripeFee(price) - landedCost);
}

// ── Repères de marché par type de produit (EUR TTC, marché français) ───────
// Fourchettes observées chez les marques indépendantes / print-on-demand.
// L'ordre compte : le plus spécifique d'abord (« zip hoodie » avant
// « hoodie », « long sleeve » avant « t-shirt »…).
export interface MarketRange {
  key: string;
  label: string;
  low: number;
  typical: number;
  high: number;
}
interface Benchmark extends MarketRange { match: RegExp }

export const MARKET_BENCHMARKS: Benchmark[] = [
  { key: 'zip_hoodie', label: 'Zip hoodie', match: /\bzip[\s-]?(up)?[\s-]?hood|full[\s-]?zip|sweat zipp|veste [àa] capuche/i, low: 49.99, typical: 59.99, high: 74.99 },
  { key: 'hoodie', label: 'Hoodie', match: /hood(ie|ed)?\b|capuche/i, low: 44.99, typical: 54.99, high: 69.99 },
  { key: 'sweatpants', label: 'Joggers / sweatpants', match: /jogger|sweatpant|jogging|track ?pant/i, low: 39.99, typical: 49.99, high: 64.99 },
  { key: 'sweatshirt', label: 'Sweatshirt', match: /sweat[\s-]?shirt|crew[\s-]?neck|\bsweat\b|pull\b/i, low: 39.99, typical: 47.99, high: 59.99 },
  { key: 'jacket', label: 'Jacket', match: /jacket|bomber|windbreaker|coupe[\s-]?vent|blouson|veste/i, low: 49.99, typical: 69.99, high: 99.99 },
  { key: 'long_sleeve', label: 'Long-sleeve tee', match: /long[\s-]?sleeve|manches? longues?/i, low: 24.99, typical: 32.99, high: 39.99 },
  { key: 'tank', label: 'Tank top', match: /tank[\s-]?top|d[ée]bardeur|\btank\b/i, low: 17.99, typical: 24.99, high: 29.99 },
  { key: 'tshirt', label: 'T-shirt', match: /t[\s-]?shirt|\btee\b|jersey/i, low: 19.99, typical: 27.99, high: 34.99 },
  { key: 'sneakers', label: 'Sneakers', match: /sneaker|basket|trainer|running shoe|\bshoes?\b|chaussure|high[\s-]?top|low[\s-]?top/i, low: 59.99, typical: 79.99, high: 109.99 },
  { key: 'slides', label: 'Slides / sandals', match: /slide|sandal|flip[\s-]?flop|tong|claquette/i, low: 24.99, typical: 34.99, high: 44.99 },
  { key: 'leggings', label: 'Leggings', match: /legging/i, low: 29.99, typical: 39.99, high: 54.99 },
  { key: 'shorts', label: 'Shorts', match: /\bshorts?\b/i, low: 24.99, typical: 32.99, high: 39.99 },
  { key: 'socks', label: 'Socks', match: /\bsocks?\b|chaussette/i, low: 9.99, typical: 14.99, high: 19.99 },
  { key: 'beanie', label: 'Beanie', match: /beanie|bonnet/i, low: 17.99, typical: 24.99, high: 29.99 },
  { key: 'cap', label: 'Cap / hat', match: /\bcap\b|\bhat\b|casquette|snapback|trucker|bucket/i, low: 19.99, typical: 27.99, high: 34.99 },
  { key: 'backpack', label: 'Backpack', match: /backpack|sac [àa] dos/i, low: 34.99, typical: 49.99, high: 69.99 },
  { key: 'tote', label: 'Tote bag', match: /tote|sac en toile|shopping bag/i, low: 14.99, typical: 22.99, high: 29.99 },
  { key: 'phone_case', label: 'Phone case', match: /phone case|iphone|samsung|coque|tough case|snap case/i, low: 14.99, typical: 22.99, high: 29.99 },
  { key: 'mug', label: 'Mug', match: /\bmug\b|tasse|tumbler/i, low: 12.99, typical: 16.99, high: 22.99 },
  { key: 'canvas', label: 'Canvas', match: /canvas|toile/i, low: 34.99, typical: 54.99, high: 89.99 },
  { key: 'poster', label: 'Poster / print', match: /poster|affiche|art print|\bprint\b/i, low: 14.99, typical: 24.99, high: 39.99 },
  { key: 'sticker', label: 'Sticker', match: /sticker|autocollant/i, low: 2.99, typical: 4.99, high: 7.99 },
];

// Cherche le type de produit, du texte le plus fiable au moins fiable : le
// titre du modèle Printify (« Unisex Hooded Sweatshirt »…) d'abord, puis le
// nom / la catégorie, puis la description.
export function benchmarkFor(...texts: Array<string | null | undefined>): MarketRange | null {
  for (const t of texts) {
    const s = String(t || '').trim();
    if (!s) continue;
    const hit = MARKET_BENCHMARKS.find((b) => b.match.test(s));
    if (hit) {
      const { match: _m, ...range } = hit;
      return range;
    }
  }
  return null;
}

// ── Frais de port Printify ──────────────────────────────────────────────────
export interface ShippingProfile {
  variant_ids?: number[];
  first_item?: { cost?: number; currency?: string };
  additional_items?: { cost?: number; currency?: string };
  countries?: string[];
}

export interface ShippingQuote {
  /** Port du premier article, en centimes de `currency`. */
  firstItemCents: number;
  currency: string;
  /** Profil trouvé pour le pays exact, le reste du monde, ou le plus cher. */
  matched: 'country' | 'rest_of_world' | 'max';
}

// Port Printify d'UN article vers `country`, pour les variantes actives (le
// plus cher si plusieurs profils couvrent ces variantes). Pur.
export function shippingFromProfiles(
  profiles: ShippingProfile[] | null | undefined,
  country: string,
  variantIds?: number[],
): ShippingQuote | null {
  const list = Array.isArray(profiles) ? profiles.filter((p) => Number(p?.first_item?.cost) > 0) : [];
  if (!list.length) return null;
  const ids = new Set((variantIds || []).filter((n) => n > 0));
  const relevant = ids.size
    ? list.filter((p) => !Array.isArray(p.variant_ids) || p.variant_ids.some((id) => ids.has(id)))
    : list;
  const pool = relevant.length ? relevant : list;
  const cc = String(country || '').toUpperCase();
  const pick = (ps: ShippingProfile[], matched: ShippingQuote['matched']): ShippingQuote | null => {
    if (!ps.length) return null;
    const best = ps.reduce((a, b) => (Number(b.first_item?.cost) > Number(a.first_item?.cost) ? b : a));
    return { firstItemCents: Number(best.first_item?.cost) || 0, currency: String(best.first_item?.currency || 'USD').toUpperCase(), matched };
  };
  return (
    pick(pool.filter((p) => (p.countries || []).map((c) => String(c).toUpperCase()).includes(cc)), 'country')
    ?? pick(pool.filter((p) => (p.countries || []).includes('REST_OF_THE_WORLD')), 'rest_of_world')
    ?? pick(pool, 'max')
  );
}

// ── Analyse ─────────────────────────────────────────────────────────────────
export type PriceVerdict = 'too_low' | 'ok' | 'too_high' | 'unknown';

export interface PriceAnalysisInput {
  /** Coût de production (variante active la plus chère), en EUR. */
  productCost: number;
  /** Port payé par la boutique pour 1 article, en EUR (0 si inconnu). */
  shipping: number;
  /** Prix de vente actuel en EUR (null si aucun). */
  currentPrice: number | null;
  /** Fourchette du marché pour ce type de produit (null = inconnue). */
  market: MarketRange | null;
  /**
   * Prix minimal imposé par le garde-fou checkout (commerce-guard
   * minRetailFor sur le coût brut) : le prix recommandé ne descend jamais
   * en dessous, sinon le paiement serait bloqué.
   */
  guardFloor?: number;
}

export interface PriceAnalysis {
  landedCost: number;
  /** Prix minimal rentable (bénéfice net ≥ 25 % et ≥ 5 €). */
  floor: number;
  /** Prix cible pur coût : coût complet × 1,8 (au moins +10 €). */
  target: number;
  /** Fourchette « bon prix » : ce qui est à la fois rentable et vendable. */
  range: { low: number; high: number };
  market: MarketRange | null;
  recommended: number;
  verdict: PriceVerdict;
  current: { price: number | null; net: number | null; marginPct: number | null };
  next: { price: number; net: number; marginPct: number };
  /** Coût complet trop élevé pour les prix du marché de ce produit. */
  aboveMarket: boolean;
  /** Explication courte (français), affichable telle quelle. */
  reason: string;
}

const pct = (net: number, price: number) => (price > 0 ? Number(((net / price) * 100).toFixed(1)) : 0);

// Plus petit prix en .99 qui laisse au moins MIN_NET_* de bénéfice net.
export function profitableFloor(landedCost: number): number {
  if (!Number.isFinite(landedCost) || landedCost <= 0) return 0;
  // p − (p·rate + fixed) − landed ≥ max(p·MIN_NET_RATE, MIN_NET_ABS)
  const byRate = (landedCost + STRIPE_FEE_FIXED) / (1 - STRIPE_FEE_RATE - MIN_NET_RATE);
  const byAbs = (landedCost + STRIPE_FEE_FIXED + MIN_NET_ABS) / (1 - STRIPE_FEE_RATE);
  return ceilTo99(Math.max(byRate, byAbs));
}

export function analyzePrice(input: PriceAnalysisInput): PriceAnalysis {
  const productCost = Math.max(0, Number(input.productCost) || 0);
  const shipping = Math.max(0, Number(input.shipping) || 0);
  const landedCost = r2(productCost + shipping);
  const guardFloor = Math.max(0, Number(input.guardFloor) || 0);
  const floor = Math.max(profitableFloor(landedCost), guardFloor);
  const target = Math.max(ceilTo99(Math.max(landedCost * TARGET_MARKUP, landedCost + TARGET_PROFIT_MIN)), floor);
  const market = input.market;

  let low: number;
  let high: number;
  let aboveMarket = false;
  if (market) {
    if (floor > market.high) {
      // Même au prix maximum du marché, on ne gagnerait rien : on reste au
      // plancher rentable et on le signale (produit trop cher à produire).
      aboveMarket = true;
      low = floor;
      high = floor;
    } else {
      low = Math.max(floor, market.low);
      high = market.high;
    }
  } else {
    low = floor;
    high = Math.max(floor, floorTo99(landedCost * NO_MARKET_HIGH_MULTIPLE));
  }

  // Prix parfait : le prix cible (vraie marge) ramené dans la fourchette.
  let recommended = Math.min(Math.max(target, low), high);
  recommended = ceilTo99(recommended);
  if (recommended > high + 1e-9) recommended = floorTo99(high);
  if (recommended < low - 1e-9) recommended = ceilTo99(low);

  const cur = input.currentPrice != null && Number.isFinite(input.currentPrice) && input.currentPrice > 0 ? r2(input.currentPrice) : null;
  let verdict: PriceVerdict = 'unknown';
  if (cur != null && landedCost > 0) {
    if (cur < low - 0.005) verdict = 'too_low';
    else if (cur > high + 0.005) verdict = 'too_high';
    else verdict = 'ok';
  }

  const curNet = cur != null && landedCost > 0 ? netProfit(cur, landedCost) : null;
  const nextNet = netProfit(recommended, landedCost);
  const eur = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;
  let reason: string;
  if (landedCost <= 0) reason = 'Coût inconnu : impossible de juger le prix.';
  else if (aboveMarket) reason = `Coût complet ${eur(landedCost)} : même au prix haut du marché (${eur(market!.high)}) la marge serait trop faible. Prix minimal rentable : ${eur(floor)}.`;
  else if (verdict === 'too_low') reason = `Trop bas : à ${eur(cur!)} il reste ${eur(curNet!)} par vente après production, port et Stripe. Bonne fourchette : ${eur(low)} – ${eur(high)}.`;
  else if (verdict === 'too_high') reason = `Trop haut pour ce type de produit (marché ${eur(market ? market.low : low)} – ${eur(high)}) : risque de ne rien vendre.`;
  else if (verdict === 'ok') reason = `Dans la fourchette (${eur(low)} – ${eur(high)}). Prix optimal : ${eur(recommended)}.`;
  else reason = `Prix optimal : ${eur(recommended)} (fourchette ${eur(low)} – ${eur(high)}).`;

  return {
    landedCost,
    floor,
    target,
    range: { low: r2(low), high: r2(high) },
    market,
    recommended,
    verdict,
    current: { price: cur, net: curNet, marginPct: curNet != null && cur ? pct(curNet, cur) : null },
    next: { price: recommended, net: nextNet, marginPct: pct(nextNet, recommended) },
    aboveMarket,
    reason,
  };
}

// Réécrit le prix de TOUTES les variantes d'un champ `variants` (JSON en
// base) au prix exact donné — à la hausse comme à la baisse, contrairement à
// pricing.repriceVariantsJson qui ne fait que relever. Pur.
export function setVariantsPriceJson(raw: string | null | undefined, price: number): string | null {
  if (!raw) return raw ?? null;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  const fix = (list: any[]) => list.map((v) => (v && typeof v === 'object' ? { ...v, price } : v));
  if (Array.isArray(parsed)) return JSON.stringify(fix(parsed));
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.printifyVariants)) {
    return JSON.stringify({ ...parsed, printifyVariants: fix(parsed.printifyVariants) });
  }
  return raw;
}
