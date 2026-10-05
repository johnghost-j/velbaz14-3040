// ─── Prix intelligent : lecture des vrais coûts + application ───────────────
// Partie « réseau + base » de smart-pricing.ts (voir l'en-tête de ce fichier
// pour le pourquoi). Pour un produit :
//   • coût réel par variante  → API Printify (GET produit, lecture seule) ;
//   • port vers le pays de la boutique → API Printify (catalogue shipping) ;
//   • type de produit → titre du modèle Printify (catalogue blueprint) ;
//   • USD → EUR → taux BCE du jour (frankfurter), repli prudent 1:1.
// Puis analyse pure, et si demandé : nouveau prix en base (produit +
// variantes), poussé sur Printify, et catalogue du site resynchronisé via
// notifyPriceChanged → prix affiché = prix Stripe.

import { v4 as uuidv4 } from 'uuid';
import { db } from './database/index';
import * as schema from './database/schema';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import * as printify from './printify';
import { resolvePrintifyConfig } from './printify-config';
import { marginPercent } from './pricing';
import { minRetailFor, notifyPriceChanged } from './commerce-guard';
import {
  analyzePrice, benchmarkFor, setVariantsPriceJson, shippingFromProfiles,
  type PriceAnalysis, type ShippingProfile,
} from './smart-pricing';

// ── Taux USD → EUR (cache 6 h) ──────────────────────────────────────────────
// Repli 1:1 : traiter des dollars comme des euros SURESTIME le coût (1 $ <
// 1 €) → jamais un prix trop bas à cause d'un taux indisponible.
let fxCache: { rate: number; at: number; source: string } | null = null;
const FX_TTL = 6 * 3600 * 1000;
export async function usdToEur(): Promise<{ rate: number; source: string }> {
  if (fxCache && Date.now() - fxCache.at < FX_TTL) return fxCache;
  try {
    const ctl = AbortSignal.timeout(4000);
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', { signal: ctl });
    const j: any = await res.json();
    const rate = Number(j?.rates?.EUR);
    if (res.ok && rate > 0.5 && rate < 1.5) {
      fxCache = { rate, at: Date.now(), source: `BCE ${j?.date || ''}`.trim() };
      return fxCache;
    }
  } catch { /* repli ci-dessous */ }
  return { rate: 1, source: 'repli 1:1 (taux indisponible)' };
}

export function toEur(amount: number, currency: string, usdEur: number): number {
  const c = String(currency || 'USD').toUpperCase();
  if (c === 'EUR') return amount;
  if (c === 'USD') return amount * usdEur;
  return amount; // devise inattendue : on ne convertit pas (prudent)
}

// ── Caches catalogue Printify (titre du modèle, profils de port) ───────────
const blueprintTitleCache = new Map<number, string>();
const shippingCache = new Map<string, { profiles: ShippingProfile[]; at: number }>();

async function blueprintTitle(cfg: printify.PrintifyConfig, id: number | null | undefined): Promise<string | null> {
  if (!id) return null;
  if (blueprintTitleCache.has(id)) return blueprintTitleCache.get(id)!;
  try {
    const r = await printify.getBlueprint(cfg, id);
    const t = r.ok ? String((r.data as any)?.title || '') : '';
    if (t) blueprintTitleCache.set(id, t);
    return t || null;
  } catch { return null; }
}

async function shippingProfiles(cfg: printify.PrintifyConfig, bp: number, pp: number): Promise<ShippingProfile[]> {
  const key = `${bp}:${pp}`;
  const hit = shippingCache.get(key);
  if (hit && Date.now() - hit.at < FX_TTL) return hit.profiles;
  try {
    const r = await printify.getBlueprintShipping(cfg, bp, pp);
    const profiles: ShippingProfile[] = r.ok && Array.isArray((r.data as any)?.profiles) ? (r.data as any).profiles : [];
    if (profiles.length) shippingCache.set(key, { profiles, at: Date.now() });
    return profiles;
  } catch { return []; }
}

// Pays principal de la boutique (destination de port de référence). Les
// projets stockent souvent « XX » (inconnu) : on retombe alors sur la langue
// du site, puis la France.
const LANG_COUNTRY: Record<string, string> = { fr: 'FR', nl: 'NL', de: 'DE', es: 'ES', it: 'IT', pt: 'PT', pl: 'PL' };
export function shopCountry(country: string | null | undefined, languages?: string | null): string {
  const c = String(country || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'ZZ') return c;
  try {
    const first = String((JSON.parse(languages || '[]') as string[])[0] || '').slice(0, 2).toLowerCase();
    if (LANG_COUNTRY[first]) return LANG_COUNTRY[first];
  } catch { /* langues illisibles */ }
  return 'FR';
}

// ── Rapport par produit ─────────────────────────────────────────────────────
export interface ProductPriceReport {
  productId: string;
  name: string;
  printifyProductId: string | null;
  productType: string | null;
  country: string;
  costSource: 'printify_api' | 'stored' | 'unknown';
  /** Coût brut tel que Printify le facture (unité Printify, variante la plus chère). */
  rawCost: number | null;
  costCurrency: string;
  fx: { usdEur: number; source: string };
  productCostEur: number | null;
  shippingEur: number | null;
  shippingSource: 'printify_api' | 'stored' | 'none';
  analysis: PriceAnalysis | null;
  applied: boolean;
  pushedToPrintify: boolean;
  previousPrice: number | null;
  newPrice: number | null;
  error?: string;
}

interface LiveProduct {
  variants: Array<{ id: number; cost: number; price: number; is_enabled: boolean }>;
  blueprintId: number | null;
  providerId: number | null;
}

async function livePrintifyProduct(cfg: printify.PrintifyConfig | null, printifyProductId: string | null): Promise<LiveProduct | null> {
  if (!cfg || !printifyProductId) return null;
  try {
    const res = await printify.getProduct(cfg, printifyProductId);
    if (!res.ok || !res.data) return null;
    const d: any = res.data;
    const variants = (Array.isArray(d.variants) ? d.variants : [])
      .map((v: any) => ({ id: Number(v?.id) || 0, cost: Number(v?.cost) || 0, price: Number(v?.price) || 0, is_enabled: v?.is_enabled !== false }))
      .filter((v: any) => v.id > 0);
    return { variants, blueprintId: Number(d.blueprint_id) || null, providerId: Number(d.print_provider_id) || null };
  } catch { return null; }
}

async function configWithShop(companyId: string): Promise<printify.PrintifyConfig | null> {
  const cfg = await resolvePrintifyConfig(companyId);
  if (!cfg) return null;
  const shopId = cfg.shopId || (await printify.resolveShopId(cfg).catch(() => null));
  return shopId ? { ...cfg, shopId } : { ...cfg };
}

// Ce qui suffit pour chiffrer le prix parfait d'un produit Printify — une
// ligne `products`, ou un produit pas encore en base (aperçu du chat).
export interface PriceQuoteInput {
  name: string;
  category?: string | null;
  description?: string | null;
  printifyProductId: string | null;
  printifyBlueprintId?: number | null;
  printifyProviderId?: number | null;
  costPrice?: number | null;
  shippingCost?: number | null;
  retailPrice?: number | null;
}

type PriceQuote = Omit<ProductPriceReport, 'productId' | 'applied' | 'pushedToPrintify' | 'previousPrice' | 'newPrice'> & {
  live: LiveProduct | null;
};

// Coût réel Printify + port vers le pays de la boutique + prix marché →
// analyse. Lecture seule : n'écrit rien, nulle part.
async function quoteFor(companyId: string, item: PriceQuoteInput, cfg: printify.PrintifyConfig | null): Promise<PriceQuote> {
  const company = await db.select({ country: schema.companies.country, languages: schema.companies.languages }).from(schema.companies)
    .where(eq(schema.companies.id, companyId)).get();
  const country = shopCountry(company?.country, company?.languages);
  const fx = await usdToEur();
  const base: PriceQuote = {
    name: item.name || '', printifyProductId: item.printifyProductId ?? null, productType: null,
    country, costSource: 'unknown', rawCost: null, costCurrency: 'USD', fx: { usdEur: fx.rate, source: fx.source },
    productCostEur: null, shippingEur: null, shippingSource: 'none', analysis: null,
    live: null,
  };
  const live = await livePrintifyProduct(cfg, item.printifyProductId ?? null);

  // Coût : variante ACTIVE la plus chère (prix unique pour toutes les tailles,
  // il doit couvrir la plus chère à produire).
  let rawCost: number | null = null;
  let costSource: ProductPriceReport['costSource'] = 'unknown';
  const enabled = live ? live.variants.filter((v) => v.is_enabled && v.cost > 0) : [];
  const costPool = enabled.length ? enabled : (live?.variants.filter((v) => v.cost > 0) ?? []);
  if (costPool.length) {
    rawCost = Math.max(...costPool.map((v) => v.cost)) / 100;
    costSource = 'printify_api';
  } else if (item.costPrice != null && item.costPrice > 0) {
    rawCost = item.costPrice;
    costSource = 'stored';
  }
  if (rawCost == null) return { ...base, live, error: 'cost_unknown' };
  // Coût Printify en USD ; un coût stocké à la main est déjà en EUR.
  const costCurrency = costSource === 'printify_api' ? 'USD' : 'EUR';
  const productCostEur = Number(toEur(rawCost, costCurrency, fx.rate).toFixed(2));

  // Port Printify vers le pays de la boutique (le site offre la livraison).
  const bp = live?.blueprintId ?? item.printifyBlueprintId ?? null;
  const pp = live?.providerId ?? item.printifyProviderId ?? null;
  let shippingEur: number | null = null;
  let shippingSource: ProductPriceReport['shippingSource'] = 'none';
  if (cfg && bp && pp) {
    const quote = shippingFromProfiles(await shippingProfiles(cfg, bp, pp), country, (enabled.length ? enabled : costPool).map((v) => v.id));
    if (quote) {
      shippingEur = Number(toEur(quote.firstItemCents / 100, quote.currency, fx.rate).toFixed(2));
      shippingSource = 'printify_api';
    }
  }
  if (shippingEur == null && item.shippingCost != null && item.shippingCost > 0) {
    shippingEur = item.shippingCost;
    shippingSource = 'stored';
  }

  const bpTitle = cfg && bp ? await blueprintTitle(cfg, bp) : null;
  const market = benchmarkFor(bpTitle, `${item.name} ${item.category || ''}`, item.description);
  const analysis = analyzePrice({
    productCost: productCostEur,
    shipping: shippingEur ?? 0,
    currentPrice: item.retailPrice ?? null,
    market,
    // Le garde-fou checkout compare le prix au coût BRUT stocké.
    guardFloor: minRetailFor(rawCost),
  });
  return {
    ...base, productType: market?.label ?? bpTitle ?? null, costSource, rawCost, costCurrency,
    productCostEur, shippingEur, shippingSource, analysis, live,
  };
}

// Prix parfait d'un produit Printify PAS ENCORE en base (aperçu du chat) :
// exactement le calcul que optimizeProductPrice appliquera à la validation,
// pour que le prix montré dans l'aperçu soit celui affiché sur le site.
export async function quotePrintifyPrice(companyId: string, item: PriceQuoteInput): Promise<{ price: number; cost: number | null } | null> {
  try {
    const q = await quoteFor(companyId, item, await configWithShop(companyId));
    return q.analysis ? { price: q.analysis.recommended, cost: q.productCostEur } : null;
  } catch (e: any) {
    console.warn(`[smart-pricing] devis ${companyId} :`, e?.message || e);
    return null;
  }
}

// Analyse (et applique si `apply`) le prix parfait d'un produit.
export async function optimizeProductPrice(
  companyId: string,
  productId: string,
  opts?: {
    apply?: boolean; cfg?: printify.PrintifyConfig | null; pushToPrintify?: boolean; log?: boolean; why?: string;
    /** N'applique que si le prix actuel est hors fourchette (trop bas / trop haut)
     *  ou absent : un prix déjà « bon » n'est pas retouché. */
    onlyIfOff?: boolean;
  },
): Promise<ProductPriceReport> {
  const apply = opts?.apply !== false;
  const row = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), eq(schema.products.id, productId))).get();
  if (!row) {
    const company = await db.select({ country: schema.companies.country, languages: schema.companies.languages }).from(schema.companies)
      .where(eq(schema.companies.id, companyId)).get();
    const fx = await usdToEur();
    return {
      productId, name: '', printifyProductId: null, productType: null,
      country: shopCountry(company?.country, company?.languages), costSource: 'unknown', rawCost: null, costCurrency: 'USD',
      fx: { usdEur: fx.rate, source: fx.source }, productCostEur: null, shippingEur: null, shippingSource: 'none', analysis: null,
      applied: false, pushedToPrintify: false, previousPrice: null, newPrice: null, error: 'product_not_found',
    };
  }

  const cfg = opts?.cfg !== undefined ? opts.cfg : await configWithShop(companyId);
  const { live, ...quote } = await quoteFor(companyId, {
    name: row.name, category: row.category, description: row.description,
    printifyProductId: row.printifyProductId ?? null,
    printifyBlueprintId: row.printifyBlueprintId ?? null, printifyProviderId: row.printifyProviderId ?? null,
    costPrice: row.costPrice ?? null, shippingCost: row.shippingCost ?? null, retailPrice: row.retailPrice ?? null,
  }, cfg);
  const report: ProductPriceReport = {
    ...quote, productId, applied: false, pushedToPrintify: false, previousPrice: row.retailPrice ?? null, newPrice: null,
  };
  if (report.error) return report;
  const analysis = quote.analysis!;
  const rawCost = quote.rawCost!;
  const shippingEur = quote.shippingEur;
  if (!apply) return report;
  if (opts?.onlyIfOff && row.retailPrice != null && row.retailPrice > 0 && analysis.verdict !== 'too_low' && analysis.verdict !== 'too_high') {
    return report;
  }

  const newPrice = analysis.recommended;
  const changed = row.retailPrice == null || Math.abs(row.retailPrice - newPrice) > 0.005;
  await db.update(schema.products).set({
    retailPrice: newPrice,
    costPrice: rawCost,
    margin: marginPercent(newPrice, rawCost),
    shippingCost: shippingEur,
    landedCost: analysis.landedCost,
    variants: setVariantsPriceJson(row.variants, newPrice),
    updatedAt: new Date(),
  }).where(eq(schema.products.id, row.id));

  // Boutique Printify alignée (la synchro Printify relit ce prix).
  let pushedToPrintify = false;
  if (changed && opts?.pushToPrintify !== false && cfg && row.printifyProductId && live?.variants.length) {
    try {
      const res = await printify.updateProduct(cfg, row.printifyProductId, {
        variants: live.variants.map((v) => ({ id: v.id, price: Math.round(newPrice * 100), is_enabled: v.is_enabled })),
      });
      pushedToPrintify = !!res.ok;
    } catch { /* prix Velbaz déjà enregistré */ }
  }

  if (changed) {
    notifyPriceChanged(companyId, opts?.why || 'smart-pricing');
    if (opts?.log !== false) {
      const eur = (n: number | null) => (n == null ? '?' : `${n.toFixed(2).replace('.', ',')} €`);
      await db.insert(schema.agentActivity).values({
        id: uuidv4(), companyId, agentRole: 'operations', action: 'completed',
        message: `💰 Prix optimisé de "${row.name}" : ${eur(row.retailPrice ?? null)} → ${eur(newPrice)} (coût complet ${eur(analysis.landedCost)} avec port, ${eur(analysis.next.net)} gagnés par vente, ${analysis.next.marginPct} %)`,
        metadata: JSON.stringify({ kind: 'smart-pricing', verdictBefore: analysis.verdict, range: analysis.range }),
      }).catch(() => {});
    }
  }
  return { ...report, applied: true, pushedToPrintify, newPrice };
}

// Tous les produits vendables de l'entreprise (hors archivés).
export async function optimizeCompanyPrices(
  companyId: string,
  opts?: { apply?: boolean; onlyIfOff?: boolean; printifyOnly?: boolean; why?: string },
): Promise<ProductPriceReport[]> {
  const rows = await db.select({ id: schema.products.id }).from(schema.products)
    .where(and(
      eq(schema.products.companyId, companyId), ne(schema.products.status, 'archived'),
      ...(opts?.printifyOnly ? [isNotNull(schema.products.printifyProductId)] : []),
    ));
  if (!rows.length) return [];
  const cfg = await configWithShop(companyId);
  const out: ProductPriceReport[] = [];
  for (const r of rows) {
    try {
      out.push(await optimizeProductPrice(companyId, r.id, { apply: opts?.apply, cfg, onlyIfOff: opts?.onlyIfOff, why: opts?.why }));
    } catch (e: any) {
      out.push({
        productId: r.id, name: '', printifyProductId: null, productType: null, country: 'FR', costSource: 'unknown',
        rawCost: null, costCurrency: 'USD', fx: { usdEur: 1, source: '' }, productCostEur: null, shippingEur: null,
        shippingSource: 'none', analysis: null, applied: false, pushedToPrintify: false, previousPrice: null, newPrice: null,
        error: e?.message || 'error',
      });
    }
  }
  return out;
}

// Prix parfait appliqué automatiquement quand l'IA crée / reconstruit un
// produit Printify. Ne lève jamais : un échec laisse le prix déjà calculé
// (coût × 1,8) en place.
export async function autoSmartPrice(companyId: string, productId: string, why = 'auto'): Promise<ProductPriceReport | null> {
  try {
    const r = await optimizeProductPrice(companyId, productId, { why: `smart-pricing:${why}` });
    if (r.error) console.warn(`[smart-pricing] ${companyId}/${productId} (${why}) : ${r.error}`);
    return r;
  } catch (e: any) {
    console.warn(`[smart-pricing] ${companyId}/${productId} (${why}) :`, e?.message || e);
    return null;
  }
}

// ─── Prix parfait AUTOMATIQUE, par défaut, pour toute la boutique ───────────
// [2026-10-02] Demande : « supprime la page Prix du dashboard et fais que ça
// soit automatique de base ». Plus de bouton « Appliquer » : chaque produit
// Printify est vérifié automatiquement (coût réel + port + marché) et un prix
// trop bas ou trop haut est corrigé tout seul — en base, sur Printify et dans
// le catalogue du site. Un prix déjà dans la bonne fourchette n'est pas
// retouché (onlyIfOff). Relancé au plus une fois toutes les 12 h par boutique,
// pour suivre les changements de coût Printify sans marteler son API.
const AUTO_REPRICE_EVERY_MS = 12 * 3600 * 1000;
const autoRepriceState: Map<string, { at: number; running: boolean }> =
  ((globalThis as any).__velbaz_auto_reprice ??= new Map());

export function autoRepriceCompany(companyId: string, why = 'auto'): Promise<ProductPriceReport[] | null> {
  const st = autoRepriceState.get(companyId);
  if (st && (st.running || Date.now() - st.at < AUTO_REPRICE_EVERY_MS)) return Promise.resolve(null);
  autoRepriceState.set(companyId, { at: Date.now(), running: true });
  return optimizeCompanyPrices(companyId, { apply: true, onlyIfOff: true, printifyOnly: true, why: `smart-pricing:${why}` })
    .then((results) => {
      const changed = results.filter((r) => r.applied && r.previousPrice !== r.newPrice);
      if (changed.length) console.log(`[smart-pricing] ${companyId} : ${changed.length}/${results.length} prix corrigé(s) automatiquement (${why})`);
      return results;
    })
    .catch((e: any) => {
      console.warn(`[smart-pricing] ${companyId} (${why}) :`, e?.message || e);
      return null;
    })
    .finally(() => autoRepriceState.set(companyId, { at: Date.now(), running: false }));
}
