// ─── PAIEMENTS PLATEFORME VELBAZ (marketplace) ──────────────────────────────
//
// Besoin : un site généré par l'IA doit pouvoir encaisser TOUT DE SUITE, même
// si son propriétaire n'a jamais connecté Stripe. L'encaissement passe par le
// compte Stripe de Velbaz (clé STRIPE_SECRET_KEY de l'Admin Panel) :
//
//   • propriétaire SANS compte Connect prêt → la vente est encaissée sur le
//     compte Velbaz. Velbaz garde sa commission, le reste (net) est STOCKÉ
//     (ligne `held`) jusqu'à ce que le propriétaire connecte son Stripe ;
//   • dès que son compte Connect a les virements actifs → chaque montant
//     stocké lui est transféré (stripe.transfers.create, idempotent) ;
//   • ventes suivantes → destination charge : Stripe envoie directement le net
//     au propriétaire et la commission (application_fee) reste à Velbaz.
//
// La commission s'applique TOUJOURS (avant comme après la connexion).
// Taux : secret VELBAZ_PLATFORM_FEE_PERCENT (Admin Panel), 10 % par défaut.
//
// COMMISSION SUR LA MARGE (pas sur la vente) :
//   marge      = prix payé − coût fournisseur (Printify : produit + port + TVA)
//                − frais Stripe estimés (1,5 % + 0,25 €)
//   commission = 10 % × marge
//   Velbaz garde commission + ce qu'il paie lui-même pour le propriétaire
//   (Printify facturé sur le compte Velbaz via le token global, frais Stripe).
//   Le propriétaire reçoit le reste = sa marge − commission.
// Exemple : coût 25 €, vendu 30 € (hors frais Stripe) → marge 5 €,
//   commission 0,50 €, propriétaire 4,50 €, Velbaz garde 25,50 € dont 25 €
//   repartent chez Printify.
//
// Le prix facturé vient du catalogue serveur (resolveCheckoutItems), jamais du
// navigateur. Aucune donnée de carte ne transite par Velbaz (Stripe Checkout).

import type Stripe from 'stripe';
import type { Hono } from 'hono';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from './database/index';
import * as schema from './database/schema';
import { getSecret } from './secret-store';
import { getStripeClient, isStripeConfigured, ensureConnectAccount, syncAccountStatus } from './stripe-connect';
import { resolvePrintifyConfig } from './printify-config';
import { STRIPE_FEE_RATE, STRIPE_FEE_FIXED } from './smart-pricing';

export const DEFAULT_PLATFORM_FEE_PERCENT = 10;
const MAX_FEE_PERCENT = 50;
const SHIPPING_COUNTRIES = ['US', 'CA', 'GB', 'FR', 'DE', 'IT', 'ES', 'NL', 'BE', 'PT', 'IE', 'AT', 'LU', 'CH', 'SE', 'DK', 'NO', 'FI', 'PL', 'CZ', 'GR', 'RO', 'HU'];

// ── Fonctions pures (testées) ───────────────────────────────────────────────

/** Taux de commission Velbaz en % (0–50). Valeur invalide → défaut. */
export function platformFeePercent(raw?: string | null): number {
  const v = raw ?? (getSecret('VELBAZ_PLATFORM_FEE_PERCENT') || process.env.VELBAZ_PLATFORM_FEE_PERCENT || '');
  const n = Number(String(v).replace(',', '.').replace('%', '').trim());
  if (!String(v).trim() || !Number.isFinite(n) || n < 0) return DEFAULT_PLATFORM_FEE_PERCENT;
  return Math.min(MAX_FEE_PERCENT, n);
}

/** Commission (centimes) et net propriétaire pour un montant brut. */
export function computeSplit(grossCents: number, feePercent: number): { gross: number; fee: number; net: number } {
  const gross = Math.max(0, Math.round(Number(grossCents) || 0));
  const fee = Math.min(gross, Math.max(0, Math.round((gross * feePercent) / 100)));
  return { gross, fee, net: gross - fee };
}

// TVA que Printify ajoute sur (production + port) pour une livraison UE.
// Constatée : 21 % pile sur les vraies commandes (adresse belge). Réglable :
// secret VELBAZ_SUPPLIER_VAT_PERCENT (0 si l'exploitant récupère la TVA).
export const DEFAULT_SUPPLIER_VAT_PERCENT = 21;
export function supplierVatPercent(raw?: string | null): number {
  const v = raw ?? (getSecret('VELBAZ_SUPPLIER_VAT_PERCENT') || process.env.VELBAZ_SUPPLIER_VAT_PERCENT || '');
  const n = Number(String(v).replace(',', '.').replace('%', '').trim());
  if (!String(v).trim() || !Number.isFinite(n) || n < 0) return DEFAULT_SUPPLIER_VAT_PERCENT;
  return Math.min(30, n);
}

/** Frais Stripe estimés (cartes UE : 1,5 % + 0,25), en centimes. */
export function stripeFeeEstimateCents(grossCents: number): number {
  const g = Math.max(0, Math.round(Number(grossCents) || 0));
  return g > 0 ? Math.round(g * STRIPE_FEE_RATE + STRIPE_FEE_FIXED * 100) : 0;
}

export interface MarginSplit {
  gross: number;   // payé par le client
  cost: number;    // coûts déduits avant de calculer la marge
  margin: number;  // gross − cost (jamais négatif)
  fee: number;     // commission Velbaz = feePercent × margin
  reserve: number; // gardé par Velbaz pour payer Printify / Stripe à la place du propriétaire
  net: number;     // versé au propriétaire = gross − fee − reserve
}

/**
 * Partage sur la MARGE. `costCents` = tous les coûts de la vente (fournisseur
 * + frais Stripe) ; `reserveCents` = la part de ces coûts que Velbaz paie
 * lui-même (Printify sur le compte Velbaz, Stripe) et garde donc.
 * Sans coût → identique à computeSplit (commission sur le brut).
 */
export function computeMarginSplit(grossCents: number, costCents: number, reserveCents: number, feePercent: number): MarginSplit {
  const gross = Math.max(0, Math.round(Number(grossCents) || 0));
  const cost = Math.max(0, Math.round(Number(costCents) || 0));
  const margin = Math.max(0, gross - cost);
  const fee = Math.min(margin, Math.max(0, Math.round((margin * feePercent) / 100)));
  const reserve = Math.min(gross - fee, Math.max(0, Math.round(Number(reserveCents) || 0)));
  return { gross, cost, margin, fee, reserve, net: gross - fee - reserve };
}

export interface CostProduct {
  id: string;
  printifyProductId?: string | null;
  supplierId?: string | null;
  costPrice?: number | null;    // USD (prix fournisseur brut)
  shippingCost?: number | null; // EUR
  landedCost?: number | null;   // EUR, produit + port
}

/**
 * Coûts d'un panier vérifié (centimes). Seuls les produits d'un FOURNISSEUR
 * comptent (Printify, dropshipping) : un coût saisi à la main par le
 * propriétaire ne réduit jamais la commission.
 *   • Printify : coût complet (landedCost, sinon costPrice converti + port)
 *     + TVA Printify. Gardé par Velbaz si c'est le compte Printify Velbaz qui
 *     est facturé (token global).
 *   • Autre fournisseur (CJ…) : payé par le propriétaire sur son compte →
 *     déduit de la marge mais pas gardé.
 *   • Frais Stripe : toujours payés par Velbaz → déduits ET gardés.
 */
export function checkoutCosts(
  items: Array<{ productId?: string | null; quantity?: number; unitAmountCents: number }>,
  products: CostProduct[],
  opts: { velbazPaysPrintify: boolean; vatPercent: number; usdEur: number; subscription?: boolean },
): { costCents: number; reserveCents: number; supplierCents: number; stripeCents: number } {
  const byId = new Map(products.map((p) => [p.id, p]));
  const gross = items.reduce((s, it) => s + Math.round(Number(it.unitAmountCents) || 0) * Math.max(1, Math.round(Number(it.quantity) || 1)), 0);
  // Abonnement : Stripe applique un pourcentage fixe (application_fee_percent),
  // pas de coût fournisseur → commission sur le montant, comme avant.
  if (opts.subscription) return { costCents: 0, reserveCents: 0, supplierCents: 0, stripeCents: 0 };
  let supplier = 0; let velbazSupplier = 0;
  for (const it of items) {
    const p = it.productId ? byId.get(String(it.productId)) : undefined;
    if (!p) continue;
    const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
    const landed = Number(p.landedCost) > 0 ? Number(p.landedCost)
      : Number(p.costPrice) > 0 ? Number(p.costPrice) * opts.usdEur + Math.max(0, Number(p.shippingCost) || 0) : 0;
    if (landed <= 0) continue;
    if (p.printifyProductId) {
      const c = Math.round(landed * (1 + opts.vatPercent / 100) * 100) * qty;
      supplier += c;
      if (opts.velbazPaysPrintify) velbazSupplier += c;
    } else if (p.supplierId) {
      supplier += Math.round(landed * 100) * qty;
    }
  }
  const stripeCents = stripeFeeEstimateCents(gross);
  return { costCents: supplier + stripeCents, reserveCents: velbazSupplier + stripeCents, supplierCents: supplier, stripeCents };
}

export type PayoutRoute = 'destination' | 'hold';

/** Compte Connect prêt à recevoir → destination charge ; sinon on stocke. */
export function choosePayoutRoute(owner: { stripeAccountId?: string | null; stripePayoutsEnabled?: boolean | null } | null | undefined): PayoutRoute {
  return owner?.stripeAccountId && owner?.stripePayoutsEnabled ? 'destination' : 'hold';
}

export interface PlatformLineItem {
  name: string; unitAmountCents: number; quantity?: number; currency?: string;
  productId?: string | null; vid?: string | null; interval?: string;
}

/** Paramètres de la session Checkout plateforme (pur → testable sans Stripe). */
export function buildPlatformSessionParams(input: {
  companyId: string;
  items: PlatformLineItem[];
  mode?: string;
  physical?: boolean;
  origin: string;
  feePercent: number;
  route: PayoutRoute;
  destination?: string | null;
  /** Coûts de la vente (cf. checkoutCosts). Absent → commission sur le brut. */
  costCents?: number;
  reserveCents?: number;
}): { params: Stripe.Checkout.SessionCreateParams; split: { gross: number; fee: number; net: number }; margin: MarginSplit; currency: string } {
  const subscription = input.mode === 'subscription';
  const items = input.items.map((it) => ({
    name: String(it.name || 'Article').slice(0, 250),
    amount: Math.round(Number(it.unitAmountCents) || 0),
    quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
    currency: String(it.currency || 'eur').toLowerCase(),
    productId: it.productId || null,
    vid: it.vid || null,
    interval: it.interval,
  }));
  const currency = items[0]?.currency || 'eur';
  const gross = items.reduce((s, it) => s + it.amount * it.quantity, 0);
  const margin = computeMarginSplit(gross, input.costCents || 0, input.reserveCents || 0, input.feePercent);
  const split = { gross: margin.gross, fee: margin.fee, net: margin.net };
  const physical = input.physical === true || items.some((it) => it.productId || it.vid);
  const itemsMeta = JSON.stringify(items.map((it) => ({ p: it.productId, v: it.vid, q: it.quantity }))).slice(0, 490);
  const destination = input.route === 'destination' && input.destination ? input.destination : null;
  const route: PayoutRoute = destination ? 'destination' : 'hold';
  const meta = {
    companyId: input.companyId,
    velbazPlatform: '1',
    vzRoute: route,
    vzFeePct: String(input.feePercent),
    vzCost: String(margin.cost),
    vzReserve: String(margin.reserve),
  };
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: subscription ? 'subscription' : 'payment',
    line_items: items.map((it) => ({
      price_data: {
        currency: it.currency,
        product_data: { name: it.name },
        unit_amount: it.amount,
        ...(subscription ? { recurring: { interval: (it.interval || 'month') as any } } : {}),
      },
      quantity: it.quantity,
    })),
    ...(physical ? { shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES as any }, phone_number_collection: { enabled: true } } : {}),
    // Prix payé = prix affiché sur le site : pas de conversion automatique de
    // devise par Stripe (Adaptive Pricing ajoute ~4 % et change la monnaie).
    adaptive_pricing: { enabled: false },
    metadata: { ...meta, items: itemsMeta },
    success_url: input.origin + '/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: input.origin + '/cancel',
  };
  if (subscription) {
    params.subscription_data = {
      metadata: meta,
      ...(destination ? { application_fee_percent: input.feePercent, transfer_data: { destination } } : {}),
    };
  } else {
    params.payment_intent_data = {
      metadata: meta,
      transfer_group: `vz_${input.companyId}`,
      // Destination : Stripe garde pour Velbaz commission + coûts payés par Velbaz.
      ...(destination ? { application_fee_amount: margin.fee + margin.reserve, transfer_data: { destination } } : {}),
    };
  }
  return { params, split, margin, currency };
}

/** Origine http(s) propre, sinon null (pas de redirection vers n'importe quoi). */
export function safeOrigin(raw: unknown): string | null {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch { return null; }
}

/** Chemin public sous lequel Velbaz sert le site généré (aperçu ET site publié). */
export function sitePreviewPath(companyId: string): string {
  return `/api/companies/${encodeURIComponent(companyId)}/preview`;
}

/**
 * Base de retour Stripe = URL RÉELLE du site généré.
 * Le navigateur n'envoie que l'origine (sans chemin) alors que le site vit
 * sous `/api/companies/<id>/preview/` (aperçu, /s/<sous-domaine> et domaine
 * personnalisé finissent tous là) : `origine + /success` tombait sur une page
 * 404 de Velbaz après le paiement. On ajoute donc ce chemin s'il manque, et on
 * coupe tout ce qui suit s'il est déjà présent (base envoyée par les sites
 * récents). null si l'origine n'est pas en http(s).
 */
export function checkoutReturnBase(companyId: string, raw: unknown): string | null {
  const o = safeOrigin(raw);
  if (!o) return null;
  const u = new URL(o);
  const base = sitePreviewPath(companyId);
  const at = u.pathname.indexOf(base);
  return u.origin + (at >= 0 ? u.pathname.slice(0, at + base.length) : base);
}

/** Identifiant de session Stripe Checkout plausible (rien d'autre n'est accepté). */
export function isCheckoutSessionId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(raw);
}

/** Montant net après remboursement (partiel ou total). */
// Les coûts déjà engagés (Printify fabriqué, frais Stripe non rendus) restent
// dus : un remboursement partiel réduit d'abord la marge du propriétaire.
export function splitAfterRefund(amountCents: number, refundedCents: number, feePercent: number, costCents = 0, reserveCents = 0) {
  const remaining = Math.max(0, amountCents - refundedCents);
  if (remaining <= 0) return { gross: 0, fee: 0, net: 0, cost: 0, reserve: 0 };
  const m = computeMarginSplit(remaining, costCents, reserveCents, feePercent);
  return { gross: m.gross, fee: m.fee, net: m.net, cost: m.cost, reserve: m.reserve };
}

// ── Dépendances fournies par index.ts (évite un import circulaire) ──────────
type Deps = {
  getUser: (c: any) => Promise<any>;
  requireCompanyOwner: (c: any) => Promise<{ ok: true; user: any; company: any } | { ok: false; res: Response }>;
  resolveCheckoutItems: (companyId: string, items: any[], opts: { mode?: string; currency?: string }) => Promise<any>;
  recordOrderFromStripeSession: (companyId: string, session: any) => Promise<{ orderId: string; created: boolean } | { error: string }>;
};
let deps: Deps | null = null;

// Client Stripe injectable pour les tests (jamais de vrai appel en test).
let stripeFactory: () => Stripe = () => getStripeClient();
export function __setStripeForTests(f: (() => Stripe) | null) { stripeFactory = f || (() => getStripeClient()); }
export function __setDepsForTests(d: Partial<Deps>) { deps = { ...(deps || {} as Deps), ...d }; }

function idOf(x: any): string | null {
  if (!x) return null;
  if (typeof x === 'string') return x;
  return x.id ? String(x.id) : null;
}

const T = schema.platformPayments;

async function ownerOf(companyId: string) {
  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
  if (!company) return { company: null, owner: null };
  const owner = await db.select().from(schema.users).where(eq(schema.users.id, company.userId)).get();
  return { company, owner: owner || null };
}

// Coûts réels du panier (produits en base + qui paie Printify).
async function cartCosts(companyId: string, items: PlatformLineItem[], subscription: boolean) {
  const ids = Array.from(new Set(items.map((i) => (i.productId ? String(i.productId) : '')).filter(Boolean)));
  if (subscription || !ids.length) return checkoutCosts(items, [], { velbazPaysPrintify: false, vatPercent: 0, usdEur: 1, subscription });
  const rows = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), inArray(schema.products.id, ids)));
  const hasPrintify = rows.some((r) => r.printifyProductId);
  const cfg = hasPrintify ? await resolvePrintifyConfig(companyId).catch(() => null) : null;
  // Taux USD→EUR seulement si un coût n'est connu qu'en USD (repli 1:1 = prudent).
  let usdEur = 1;
  if (rows.some((r) => !(Number(r.landedCost) > 0) && Number(r.costPrice) > 0)) {
    usdEur = await import('./smart-pricing-service').then((m) => m.usdToEur()).then((r) => r.rate).catch(() => 1);
  }
  return checkoutCosts(items, rows, {
    // Sans token propre à l'entreprise, Printify facture le compte Velbaz.
    velbazPaysPrintify: !cfg || cfg.source === 'global',
    vatPercent: supplierVatPercent(),
    usdEur,
  });
}

// ── Création de la session Checkout plateforme ──────────────────────────────
export async function createPlatformCheckout(companyId: string, body: any): Promise<
  { ok: true; url: string | null; id: string; route: PayoutRoute }
  | { ok: false; status: number; code: string; message: string; rejected?: any[] }
> {
  if (!isStripeConfigured()) {
    return { ok: false, status: 503, code: 'platform_unavailable', message: 'Paiement plateforme indisponible.' };
  }
  if (!deps) return { ok: false, status: 503, code: 'platform_unavailable', message: 'Paiement plateforme indisponible.' };
  const { company, owner } = await ownerOf(companyId);
  if (!company) return { ok: false, status: 404, code: 'company_not_found', message: 'Boutique inconnue.' };
  const origin = checkoutReturnBase(companyId, body?.returnUrl || body?.origin);
  if (!origin) return { ok: false, status: 400, code: 'bad_origin', message: 'Origine du site invalide.' };
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (!rawItems.length) return { ok: false, status: 400, code: 'no_items', message: 'Panier vide.' };

  // Prix AUTORITAIRES : le catalogue serveur, jamais le navigateur.
  const verified = await deps.resolveCheckoutItems(companyId, rawItems, { mode: body?.mode, currency: body?.currency });
  if (!verified?.ok) {
    return { ok: false, status: 409, code: verified?.code || 'cart_rejected', message: verified?.message || 'Panier refusé.', rejected: verified?.rejected };
  }
  const feePercent = platformFeePercent();
  const route = choosePayoutRoute(owner);
  const costs = await cartCosts(companyId, verified.items || [], body?.mode === 'subscription');
  const { params, split, margin, currency } = buildPlatformSessionParams({
    companyId, items: verified.items || [], mode: body?.mode, physical: body?.physical === true,
    origin, feePercent, route, destination: owner?.stripeAccountId || null,
    costCents: costs.costCents, reserveCents: costs.reserveCents,
  });
  if (split.gross <= 0) return { ok: false, status: 409, code: 'cart_rejected', message: 'Montant invalide.' };

  const stripe = stripeFactory();
  const session = await stripe.checkout.sessions.create(params);
  await db.insert(T).values({
    id: crypto.randomUUID(),
    companyId,
    ownerUserId: company.userId,
    sourceRef: session.id,
    kind: 'checkout',
    stripeSessionId: session.id,
    route: (params.metadata as any)?.vzRoute || route,
    grossCents: split.gross,
    feeCents: split.fee,
    netCents: split.net,
    costCents: margin.cost,
    reservedCents: margin.reserve,
    feePercent,
    currency,
    status: 'pending',
    destinationAccount: (params.metadata as any)?.vzRoute === 'destination' ? owner?.stripeAccountId || null : null,
  }).catch((e) => console.error('[platform-pay] insert pending:', e?.message));
  return { ok: true, url: session.url, id: session.id, route };
}

// ── Confirmation (page de succès, webhook, réconciliation) — IDEMPOTENT ─────
export type ConfirmedSession = {
  ok: true; status: string; amount: number | null; recorded: boolean;
  currency?: string | null; email?: string | null; orderRef?: string | null;
};

export async function confirmPlatformSession(companyId: string, sessionId: string): Promise<
  ConfirmedSession
  | { ok: false; code: string; message: string }
> {
  if (!isStripeConfigured() || !deps) return { ok: false, code: 'platform_unavailable', message: 'Paiement plateforme indisponible.' };
  const stripe = stripeFactory();
  let session: any;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent', 'payment_intent.latest_charge'] });
  } catch {
    return { ok: false, code: 'not_platform', message: 'Session inconnue sur le compte Velbaz.' };
  }
  if (session?.metadata?.velbazPlatform !== '1' || String(session?.metadata?.companyId || '') !== companyId) {
    return { ok: false, code: 'not_platform', message: 'Session non émise par Velbaz pour ce site.' };
  }
  const pi: any = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const charge: any = pi?.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  // receipt_url : reçu officiel Stripe, joint à l'e-mail de confirmation acheteur.
  const normalized = { ...session, payment_intent: idOf(session.payment_intent), __receiptUrl: charge?.receipt_url || null };
  const extra = {
    currency: session.currency ? String(session.currency).toLowerCase() : null,
    email: session.customer_details?.email || null,
  };

  if (session.status === 'expired') {
    await db.update(T).set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(T.sourceRef, session.id), eq(T.status, 'pending'))).catch(() => {});
  }
  if (session.payment_status !== 'paid') {
    return { ok: true, status: String(session.payment_status || 'unpaid'), amount: session.amount_total ?? null, recorded: false, ...extra, orderRef: null };
  }

  const order = await deps.recordOrderFromStripeSession(companyId, normalized);
  await settleLedgerFromSession(companyId, session, pi);
  // Propriétaire connecté entre-temps → on lui verse tout de suite.
  const { company } = await ownerOf(companyId);
  if (company) await releaseHeldForUser(company.userId).catch((e) => console.error('[platform-pay] release:', e?.message));
  const orderRef = 'orderId' in order ? orderRefOf(order.orderId) : null;
  return { ok: true, status: 'paid', amount: session.amount_total ?? null, recorded: !('error' in order), ...extra, orderRef };
}

/** Référence de commande lisible par l'acheteur (e-mail, page de remerciement). */
export function orderRefOf(orderId: string): string {
  return 'CMD-' + String(orderId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
}

async function settleLedgerFromSession(companyId: string, session: any, pi: any) {
  const route: PayoutRoute = session.metadata?.vzRoute === 'destination' ? 'destination' : 'hold';
  const feePercent = platformFeePercent(session.metadata?.vzFeePct ?? null);
  const gross = Number(session.amount_total ?? 0);
  const m = computeMarginSplit(gross, Number(session.metadata?.vzCost || 0), Number(session.metadata?.vzReserve || 0), feePercent);
  let split = { gross: m.gross, fee: m.fee, net: m.net, cost: m.cost, reserve: m.reserve };
  if (route === 'destination' && pi?.application_fee_amount != null) {
    // Montant réellement retenu par Stripe = commission + réserve.
    const appFee = Number(pi.application_fee_amount);
    const reserve = Math.min(appFee, m.reserve);
    split = { gross, fee: appFee - reserve, net: gross - appFee, cost: m.cost, reserve };
  }
  const chargeId = idOf(pi?.latest_charge);
  const values = {
    stripePaymentIntentId: idOf(session.payment_intent),
    stripeChargeId: chargeId,
    stripeSubscriptionId: idOf(session.subscription),
    grossCents: split.gross, feeCents: split.fee, netCents: split.net, feePercent,
    costCents: split.cost, reservedCents: split.reserve,
    currency: String(session.currency || 'eur').toLowerCase(),
    route,
    destinationAccount: route === 'destination' ? idOf(pi?.transfer_data?.destination) : null,
    status: route === 'destination' ? 'transferred' : 'held',
    updatedAt: new Date(),
  };
  const existing = await db.select().from(T).where(eq(T.sourceRef, String(session.id))).get();
  if (!existing) {
    const { company } = await ownerOf(companyId);
    await db.insert(T).values({
      id: crypto.randomUUID(), companyId, ownerUserId: company?.userId || null,
      sourceRef: String(session.id), kind: 'checkout', stripeSessionId: String(session.id), ...values,
    }).onConflictDoNothing();
    return;
  }
  // Seule la transition pending → held/transferred est permise (jamais de retour arrière).
  await db.update(T).set(values).where(and(eq(T.id, existing.id), eq(T.status, 'pending')));
}

// ── Renouvellement d'abonnement plateforme (invoice.paid) ───────────────────
export function invoicePlatformMeta(inv: any): Record<string, string> | null {
  const m = inv?.parent?.subscription_details?.metadata || inv?.subscription_details?.metadata || null;
  return m && m.velbazPlatform === '1' && m.companyId ? m : null;
}

async function recordPlatformInvoice(inv: any) {
  const meta = invoicePlatformMeta(inv);
  if (!meta) return;
  // La 1ʳᵉ facture est déjà comptée via checkout.session.completed.
  if (String(inv?.billing_reason || '') === 'subscription_create') return;
  const companyId = meta.companyId;
  const route: PayoutRoute = meta.vzRoute === 'destination' ? 'destination' : 'hold';
  const feePercent = platformFeePercent(meta.vzFeePct ?? null);
  const split = computeSplit(Number(inv.amount_paid ?? 0), feePercent);
  if (split.gross <= 0) return;
  const { company } = await ownerOf(companyId);
  await db.insert(T).values({
    id: crypto.randomUUID(), companyId, ownerUserId: company?.userId || null,
    sourceRef: String(inv.id), kind: 'invoice',
    stripeSubscriptionId: idOf(inv.parent?.subscription_details?.subscription) || idOf(inv.subscription),
    stripeChargeId: idOf(inv.charge),
    route, grossCents: split.gross, feeCents: split.fee, netCents: split.net, feePercent,
    currency: String(inv.currency || 'eur').toLowerCase(),
    status: route === 'destination' ? 'transferred' : 'held',
  }).onConflictDoNothing();
  if (company && route === 'hold') await releaseHeldForUser(company.userId).catch(() => {});
}

// ── Versement des montants stockés au propriétaire ──────────────────────────
export async function releaseHeldForUser(userId: string): Promise<{ released: number; failed: number; skipped?: string }> {
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.stripeAccountId || !user.stripePayoutsEnabled) return { released: 0, failed: 0, skipped: 'not_connected' };
  if (!isStripeConfigured()) return { released: 0, failed: 0, skipped: 'platform_unavailable' };
  const rows = await db.select().from(T).where(and(eq(T.ownerUserId, userId), eq(T.status, 'held'))).limit(200);
  let released = 0; let failed = 0;
  const stripe = stripeFactory();
  for (const row of rows) {
    if (row.netCents <= 0) {
      await db.update(T).set({ status: 'released', releasedAt: new Date(), updatedAt: new Date() }).where(eq(T.id, row.id));
      continue;
    }
    // Verrou : une seule exécution peut passer held → releasing.
    const claim = await db.update(T).set({ status: 'releasing', updatedAt: new Date() })
      .where(and(eq(T.id, row.id), eq(T.status, 'held')));
    const claimed = Number((claim as any)?.rowsAffected ?? (claim as any)?.changes ?? 0) > 0;
    if (!claimed) continue;
    try {
      const transfer = await stripe.transfers.create({
        amount: row.netCents,
        currency: row.currency || 'eur',
        destination: user.stripeAccountId,
        transfer_group: `vz_${row.companyId}`,
        ...(row.stripeChargeId ? { source_transaction: row.stripeChargeId } : {}),
        metadata: { velbazPlatform: '1', companyId: row.companyId, ledgerId: row.id, sourceRef: row.sourceRef },
      }, { idempotencyKey: `vz-release-${row.id}` });
      await db.update(T).set({
        status: 'released', transferId: transfer.id, destinationAccount: user.stripeAccountId,
        releasedAt: new Date(), lastError: null, updatedAt: new Date(),
      }).where(eq(T.id, row.id));
      released++;
    } catch (e: any) {
      failed++;
      await db.update(T).set({ status: 'held', lastError: String(e?.message || e).slice(0, 300), updatedAt: new Date() })
        .where(eq(T.id, row.id));
    }
  }
  if (released > 0) {
    await db.insert(schema.agentActivity).values({
      id: crypto.randomUUID(), companyId: rows[0].companyId, agentRole: 'operations', action: 'completed',
      message: `💸 ${released} paiement(s) en attente versé(s) sur ton compte Stripe (commission Velbaz déduite)`,
    }).catch(() => {});
  }
  return { released, failed };
}

// ── Remboursements / litiges ────────────────────────────────────────────────
async function applyChargeRefund(charge: any) {
  const chargeId = idOf(charge);
  const piId = idOf(charge?.payment_intent);
  const conds = [chargeId ? eq(T.stripeChargeId, chargeId) : null, piId ? eq(T.stripePaymentIntentId, piId) : null].filter(Boolean) as any[];
  if (!conds.length) return;
  const row = await db.select().from(T).where(conds.length > 1 ? sql`(${conds[0]} OR ${conds[1]})` : conds[0]).get();
  if (!row) return;
  const full = !!charge.refunded || Number(charge.amount_refunded || 0) >= Number(charge.amount || 0);
  const split = splitAfterRefund(Number(charge.amount || row.grossCents), Number(charge.amount_refunded || 0), row.feePercent ?? platformFeePercent(), row.costCents || 0, row.reservedCents || 0);
  if (row.status === 'held' || row.status === 'pending' || row.status === 'disputed') {
    await db.update(T).set({
      status: full ? 'refunded' : row.status, grossCents: split.gross, feeCents: split.fee, netCents: split.net, reservedCents: split.reserve, updatedAt: new Date(),
    }).where(eq(T.id, row.id));
    return;
  }
  if (row.status === 'released' && row.transferId) {
    // Déjà versé : on reprend au propriétaire la part remboursée (jamais plus que versé).
    const reverse = Math.min(row.netCents, Math.max(0, row.netCents - split.net));
    if (reverse > 0) {
      try {
        await stripeFactory().transfers.createReversal(row.transferId, { amount: reverse }, { idempotencyKey: `vz-reverse-${row.id}-${split.gross}` });
      } catch (e: any) {
        await db.update(T).set({ lastError: `reversal: ${String(e?.message || e).slice(0, 250)}` }).where(eq(T.id, row.id));
      }
    }
    await db.update(T).set({ status: full ? 'refunded' : 'released', grossCents: split.gross, feeCents: split.fee, netCents: split.net, reservedCents: split.reserve, updatedAt: new Date() })
      .where(eq(T.id, row.id));
    return;
  }
  if (full) await db.update(T).set({ status: 'refunded', updatedAt: new Date() }).where(eq(T.id, row.id));
}

async function applyDispute(dispute: any, closed: boolean) {
  const chargeId = idOf(dispute?.charge);
  if (!chargeId) return;
  const row = await db.select().from(T).where(eq(T.stripeChargeId, chargeId)).get();
  if (!row) return;
  if (!closed && row.status === 'held') {
    await db.update(T).set({ status: 'disputed', updatedAt: new Date() }).where(eq(T.id, row.id));
  } else if (closed && row.status === 'disputed') {
    await db.update(T).set({ status: dispute?.status === 'lost' ? 'refunded' : 'held', updatedAt: new Date() }).where(eq(T.id, row.id));
  }
}

// ── Aiguillage webhook (appelé par /stripe/webhook ET /billing/webhook) ─────
/** True si l'événement concerne un paiement plateforme Velbaz. */
export function isPlatformEvent(event: { type: string; data?: { object?: any } }): boolean {
  const obj: any = event?.data?.object || {};
  if (event.type.startsWith('checkout.session.')) return obj?.metadata?.velbazPlatform === '1';
  if (event.type.startsWith('invoice.')) return !!invoicePlatformMeta(obj);
  if (event.type === 'charge.refunded' || event.type.startsWith('charge.dispute.')) return true; // filtré par la table
  return false;
}

export async function handlePlatformEvent(event: { type: string; data?: { object?: any } }): Promise<void> {
  const obj: any = event?.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (obj?.metadata?.companyId) await confirmPlatformSession(String(obj.metadata.companyId), String(obj.id));
      break;
    case 'checkout.session.expired':
      await db.update(T).set({ status: 'expired', updatedAt: new Date() })
        .where(and(eq(T.sourceRef, String(obj.id)), eq(T.status, 'pending')));
      break;
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await recordPlatformInvoice(obj);
      break;
    case 'charge.refunded':
      await applyChargeRefund(obj);
      break;
    case 'charge.dispute.created':
      await applyDispute(obj, false);
      break;
    case 'charge.dispute.closed':
      await applyDispute(obj, true);
      break;
    default:
      break;
  }
}

// ── Réconciliation : sessions restées « pending » (client parti trop tôt) ───
const lastReconcile = new Map<string, number>();
export async function reconcilePlatformPending(companyId: string, opts: { force?: boolean } = {}): Promise<number> {
  if (!isStripeConfigured() || !deps) return 0;
  const now = Date.now();
  if (!opts.force && now - (lastReconcile.get(companyId) || 0) < 20_000) return 0;
  lastReconcile.set(companyId, now);
  const since = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const rows = await db.select().from(T)
    .where(and(eq(T.companyId, companyId), eq(T.status, 'pending'), eq(T.kind, 'checkout'), gte(T.createdAt, since)))
    // Les plus récentes d'abord : des paniers abandonnés (sessions encore
    // ouvertes) ne doivent jamais masquer une commande payée à l'instant.
    .orderBy(desc(T.createdAt))
    .limit(25);
  let done = 0;
  for (const r of rows) {
    const res = await confirmPlatformSession(companyId, r.sourceRef).catch(() => null);
    if (res && res.ok && res.status === 'paid') done++;
  }
  return done;
}

// ── Site émetteur d'une session Checkout (retour de paiement égaré) ─────────
export async function companyForSession(sessionId: string): Promise<string | null> {
  const row = await db.select({ companyId: T.companyId }).from(T).where(eq(T.stripeSessionId, sessionId)).get();
  if (row?.companyId) return row.companyId;
  const order = await db.select({ companyId: schema.orders.companyId }).from(schema.orders)
    .where(eq(schema.orders.stripeSessionId, sessionId)).get();
  if (order?.companyId) return order.companyId;
  if (!isStripeConfigured()) return null;
  try {
    const session: any = await stripeFactory().checkout.sessions.retrieve(sessionId);
    const id = String(session?.metadata?.companyId || '');
    if (!id) return null;
    const company = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, id)).get();
    return company?.id || null;
  } catch { return null; }
}

// ── Résumé pour le dashboard du propriétaire ────────────────────────────────
export async function payoutSummary(companyId: string) {
  const rows = await db.select().from(T).where(and(
    eq(T.companyId, companyId),
    inArray(T.status, ['held', 'releasing', 'disputed', 'released', 'transferred']),
  )).limit(2000);
  const byCur: Record<string, { held: number; paidOut: number; fees: number; gross: number; costs: number; heldCount: number }> = {};
  for (const r of rows) {
    const cur = (r.currency || 'eur').toLowerCase();
    const b = byCur[cur] ||= { held: 0, paidOut: 0, fees: 0, gross: 0, costs: 0, heldCount: 0 };
    b.gross += r.grossCents; b.fees += r.feeCents; b.costs += r.reservedCents || 0;
    if (r.status === 'held' || r.status === 'releasing' || r.status === 'disputed') { b.held += r.netCents; b.heldCount++; }
    else b.paidOut += r.netCents;
  }
  const lastError = rows.find((r) => r.status === 'held' && r.lastError)?.lastError || null;
  return { currencies: byCur, sales: rows.length, lastError };
}

// ── Routes HTTP ─────────────────────────────────────────────────────────────
export function registerPlatformPaymentRoutes(app: Hono<any>, d: Deps) {
  deps = d;

  // Appelé par le serveur du site généré (aucune clé côté propriétaire).
  app.post('/companies/:id/checkout/platform-session', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const r = await createPlatformCheckout(c.req.param('id'), body);
      if (!r.ok) return c.json({ ok: false, error: r.code, code: r.code, message: r.message, rejected: r.rejected }, r.status as any);
      return c.json({ ok: true, url: r.url, id: r.id }, 200);
    } catch (e: any) {
      console.error('[platform-pay] session:', e?.message);
      return c.json({ ok: false, error: 'stripe_error', code: 'stripe_error', message: 'Paiement momentanément indisponible.' }, 502);
    }
  });

  // Page de succès du site → re-vérifie chez Stripe avec la clé Velbaz.
  app.post('/companies/:id/checkout/platform-confirm', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = String(body?.sessionId || '').trim();
    if (!sessionId.startsWith('cs_')) return c.json({ ok: false, error: 'sessionId invalide' }, 400);
    try {
      const r = await confirmPlatformSession(c.req.param('id'), sessionId);
      if (!r.ok) return c.json({ ok: false, error: r.code, message: r.message }, r.code === 'not_platform' ? 404 : 503);
      return c.json(r, 200);
    } catch (e: any) {
      console.error('[platform-pay] confirm:', e?.message);
      return c.json({ ok: false, error: 'stripe_error' }, 502);
    }
  });

  // Filet de sécurité « retour de paiement » : un acheteur renvoyé sur
  // <hôte Velbaz>/success?session_id=cs_… (sessions créées avant le correctif
  // de l'URL de retour, ou site qui n'envoie pas sa base) est redirigé vers la
  // page de succès DU SITE qui a émis la session, au lieu d'un 404 Velbaz.
  // Public (redirection navigateur) : ne révèle que l'identifiant du site,
  // déjà présent dans l'URL publique de celui-ci.
  app.get('/checkout/return', async (c) => {
    const sessionId = c.req.query('session_id');
    if (!isCheckoutSessionId(sessionId)) return c.redirect('/', 302);
    const companyId = await companyForSession(sessionId).catch(() => null);
    if (!companyId) return c.redirect('/', 302);
    return c.redirect(`${sitePreviewPath(companyId)}/success?session_id=${encodeURIComponent(sessionId)}`, 302);
  });

  // Dashboard propriétaire : solde en attente + statut Stripe.
  app.get('/companies/:id/payouts', async (c) => {
    const auth = await d.requireCompanyOwner(c);
    if (!auth.ok) return auth.res;
    const companyId = auth.company.id;
    await reconcilePlatformPending(companyId).catch(() => 0);
    const owner = await db.select().from(schema.users).where(eq(schema.users.id, auth.company.userId)).get();
    if (owner?.stripePayoutsEnabled) await releaseHeldForUser(owner.id).catch(() => null);
    const summary = await payoutSummary(companyId);
    return c.json({
      platformReady: isStripeConfigured(),
      feePercent: platformFeePercent(),
      feeBasis: 'margin',
      stripe: {
        accountId: owner?.stripeAccountId ? `…${owner.stripeAccountId.slice(-6)}` : null,
        onboardingCompleted: !!owner?.stripeOnboardingCompleted,
        payoutsEnabled: !!owner?.stripePayoutsEnabled,
      },
      ...summary,
    }, 200);
  });

  // Bouton « Connecter mon Stripe » → onboarding Stripe Express.
  app.post('/companies/:id/payouts/connect', async (c) => {
    const auth = await d.requireCompanyOwner(c);
    if (!auth.ok) return auth.res;
    if (!isStripeConfigured()) return c.json({ error: 'Stripe Velbaz non configuré (Admin Panel).' }, 503);
    const owner = await db.select().from(schema.users).where(eq(schema.users.id, auth.company.userId)).get();
    if (!owner) return c.json({ error: 'Propriétaire introuvable' }, 404);
    if (owner.id !== auth.user.id) return c.json({ error: 'Seul le propriétaire peut connecter son Stripe.' }, 403);
    try {
      const accountId = await ensureConnectAccount(owner);
      const origin = safeOrigin(new URL(c.req.url).origin) || '';
      const proto = c.req.header('x-forwarded-proto'); const host = c.req.header('x-forwarded-host') || c.req.header('host');
      const base = proto && host ? `${proto}://${host}` : origin;
      const link = await stripeFactory().accountLinks.create({
        account: accountId,
        refresh_url: `${base}/api/companies/${auth.company.id}/payouts/return?refresh=1`,
        return_url: `${base}/api/companies/${auth.company.id}/payouts/return`,
        type: 'account_onboarding',
      });
      return c.json({ ok: true, url: link.url }, 200);
    } catch (e: any) {
      console.error('[platform-pay] connect:', e?.message);
      return c.json({ error: e?.message || 'Erreur Stripe' }, 502);
    }
  });

  // Retour de l'onboarding Stripe : resynchronise, verse le stocké, redirige.
  // Pas d'auth (redirection navigateur) : ne lit que le statut du compte du
  // PROPRIÉTAIRE de l'entreprise et ne verse qu'à lui — rien d'exploitable.
  app.get('/companies/:id/payouts/return', async (c) => {
    const companyId = c.req.param('id');
    const { company, owner } = await ownerOf(companyId);
    if (company && owner?.stripeAccountId) {
      await syncAccountStatus(owner).catch(() => null);
      await releaseHeldForUser(owner.id).catch(() => null);
    }
    const refresh = c.req.query('refresh') ? '&stripe=refresh' : '&stripe=return';
    return c.redirect(`/chat/${encodeURIComponent(companyId)}?dash=orders${refresh}`, 302);
  });

  // Relance manuelle du versement.
  app.post('/companies/:id/payouts/release', async (c) => {
    const auth = await d.requireCompanyOwner(c);
    if (!auth.ok) return auth.res;
    const owner = await db.select().from(schema.users).where(eq(schema.users.id, auth.company.userId)).get();
    if (owner?.stripeAccountId) await syncAccountStatus(owner).catch(() => null);
    const r = await releaseHeldForUser(auth.company.userId);
    return c.json({ ok: true, ...r }, 200);
  });
}
