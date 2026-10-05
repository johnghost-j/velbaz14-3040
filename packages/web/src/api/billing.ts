// ─── Facturation Velbaz (abonnements + packs de crédits) via Stripe ──────────
//
// C'est le SYSTÈME DE PAIEMENT DE LA PLATEFORME : ce que l'utilisateur paie à
// Velbaz. À ne pas confondre avec :
//   • ./stripe-connect.ts       → marketplace (paiements acheteur → vendeur) ;
//   • /companies/:id/orders/*   → boutique d'un site généré (clé Stripe DU CLIENT).
//
// Principe : plus AUCUN plan ni crédit n'est accordé sans paiement confirmé.
//   1. POST /billing/checkout/plan|credits → crée une session Stripe Checkout
//      et renvoie son URL. Rien n'est accordé à ce stade.
//   2. L'utilisateur paie sur la page hébergée par Stripe.
//   3. Le plan/les crédits sont accordés UNIQUEMENT quand le paiement est
//      confirmé, par l'une des deux voies (les deux sont idempotentes) :
//        • POST /billing/webhook  → événement signé (voie normale, gère aussi
//          les renouvellements, échecs de paiement et résiliations) ;
//        • POST /billing/confirm  → au retour sur /plans, Velbaz relit la
//          session directement chez Stripe (serveur→serveur). Filet de
//          sécurité : le paiement fonctionne même si le webhook n'est pas
//          encore branché dans le dashboard Stripe.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QU'IL RESTE À FAIRE POUR ENCAISSER POUR DE VRAI (rien à coder) :
//   → Coller la clé secrète Stripe dans l'Admin Panel : STRIPE_SECRET_KEY
//     (sk_live_… en production, sk_test_… pour tester). C'est le SEUL élément
//     obligatoire : les prix sont envoyés en ligne (price_data) depuis
//     ./plans.ts, donc AUCUN produit ni prix n'est à créer chez Stripe.
//   → Optionnel mais recommandé : STRIPE_WEBHOOK_SECRET (whsec_…), obtenu en
//     créant un endpoint webhook Stripe vers  https://<domaine>/api/billing/webhook
//     avec les événements : checkout.session.completed, checkout.session.expired,
//     invoice.paid, invoice.payment_failed, customer.subscription.updated,
//     customer.subscription.deleted. Sans lui, les premiers paiements
//     fonctionnent (via /billing/confirm) mais les RENOUVELLEMENTS et
//     résiliations automatiques ne sont pas suivis.
// Tant que la clé est absente, tout le système répond proprement
// (503 + code `stripe_not_configured`) : rien ne plante, rien n'est offert.
// ─────────────────────────────────────────────────────────────────────────────
//
import type Stripe from 'stripe';
import type { Hono } from 'hono';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from './database/index';
import * as schema from './database/schema';
import { getSecret } from './secret-store';
import { getStripeClient, isStripeConfigured } from './stripe-connect';
import { applyMoneyRequestInvoice, applyMoneyRequestSession, isMoneyRequestSession } from './money-requests';
import { trackEvent as controlTrackEvent } from './velbaz-control/client';
import {
  CREDIT_PACKAGES,
  PLAN_CONFIG,
  PLAN_ORDER,
  YEARLY_FACTOR,
  addDays,
  addMonths,
  creditPackage,
  formatPlanDate,
  normalizeBillingCycle,
  normalizePlan,
  planCreditsForCycle,
  planPrice,
  planPriceCents,
  DEFAULT_DURATION_DAYS,
  featureGate,
  type BillingCycle,
  type PlanKey,
} from './plans';

const CURRENCY = 'eur';

/** Plans réellement payants (Free ne passe pas par Stripe). */
const PAID_PLANS: PlanKey[] = PLAN_ORDER.filter((p) => PLAN_CONFIG[p].monthlyPrice > 0);

export function isBillingConfigured(): boolean {
  return isStripeConfigured();
}

export function isBillingWebhookConfigured(): boolean {
  const s = getSecret('STRIPE_WEBHOOK_SECRET');
  return !!(s && s.trim());
}

/** Erreur JSON uniforme quand la clé Stripe n'est pas encore saisie. */
const NOT_CONFIGURED = {
  error: 'Payments are not configured yet. Add the Stripe secret key in the Admin Panel to enable checkout.',
  code: 'stripe_not_configured' as const,
};

// ── Origine publique de la requête (preview / prod / localhost) ──
function originOf(c: any): string {
  const proto = c.req.header('x-forwarded-proto');
  const host = c.req.header('x-forwarded-host') || c.req.header('host');
  if (proto && host) return `${proto}://${host}`;
  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

function centsToEuros(cents: number): number {
  return Math.round(cents) / 100;
}

/** Lecture tolérante d'une date de fin de période Stripe (API Basil ou avant). */
function periodEndOf(sub: any): Date | null {
  const raw = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
  const n = Number(raw);
  if (!n || Number.isNaN(n)) return null;
  return new Date(n * 1000);
}

/** Id d'abonnement porté par une facture (API Basil ou avant). */
function subscriptionIdOfInvoice(inv: any): string | null {
  const direct = inv?.subscription;
  if (typeof direct === 'string') return direct;
  if (direct?.id) return String(direct.id);
  const nested = inv?.parent?.subscription_details?.subscription;
  if (typeof nested === 'string') return nested;
  if (nested?.id) return String(nested.id);
  const line = inv?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription;
  if (typeof line === 'string') return line;
  return null;
}

function idOf(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.id ? String(v.id) : null;
}

/** Fin de cycle calculée localement, utilisée si Stripe ne la fournit pas. */
function fallbackPeriodEnd(billing: BillingCycle): Date {
  return billing === 'yearly' ? addMonths(new Date(), 12) : addDays(new Date(), DEFAULT_DURATION_DAYS.monthly);
}

// ─────────────────────────────────────────────────────────────────────────────
// Client Stripe de la plateforme (même clé que Connect : un seul compte Stripe
// Velbaz). Ne lève jamais : renvoie null si la clé n'est pas configurée.
// ─────────────────────────────────────────────────────────────────────────────
function stripeOrNull(): Stripe | null {
  if (!isStripeConfigured()) return null;
  try {
    return getStripeClient();
  } catch {
    return null;
  }
}

/** Crée (ou réutilise) le Customer Stripe du client Velbaz. */
async function ensureCustomer(stripe: Stripe, user: any): Promise<string> {
  const existing = user?.stripeCustomerId ? String(user.stripeCustomerId) : '';
  if (existing) {
    // Un Customer supprimé côté Stripe ne doit pas bloquer le paiement.
    try {
      const got: any = await stripe.customers.retrieve(existing);
      if (got && !got.deleted) return existing;
    } catch {
      /* on en recrée un juste en dessous */
    }
  }
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: { userId: String(user.id), app: 'velbaz' },
  });
  await db.update(schema.users).set({ stripeCustomerId: customer.id }).where(eq(schema.users.id, user.id)).catch(() => {});
  (user as any).stripeCustomerId = customer.id;
  return customer.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Application d'un paiement confirmé — IDEMPOTENT
// ─────────────────────────────────────────────────────────────────────────────

type ApplyResult =
  | { ok: true; already: boolean; kind: 'subscription'; plan: PlanKey; billing: BillingCycle; expiresAt: string | null; tokens: number; creditsGranted: number }
  | { ok: true; already: boolean; kind: 'credits'; tokens: number; creditsGranted: number }
  | { ok: false; error: string; code?: string };

/** Une session Checkout est-elle réellement payée ? */
function isSessionPaid(session: any): boolean {
  const ps = String(session?.payment_status || '');
  if (ps === 'paid' || ps === 'no_payment_required') return true;
  // Abonnement avec essai : pas de paiement immédiat mais session complète.
  return String(session?.status || '') === 'complete' && ps !== 'unpaid';
}

/**
 * Accorde le plan ou les crédits d'une session Checkout payée.
 * Appelable par le webhook ET par la page de retour : le verrou se fait par
 * un UPDATE conditionnel sur `applied_at` (une seule voie peut le poser).
 */
async function applyPaidSession(
  session: any,
  addTokens: AddTokens,
): Promise<ApplyResult> {
  const sessionId = idOf(session);
  if (!sessionId) return { ok: false, error: 'Session Stripe invalide' };
  if (!isSessionPaid(session)) {
    await db.update(schema.billingCheckouts)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(schema.billingCheckouts.stripeSessionId, sessionId)).catch(() => {});
    return { ok: false, error: `Paiement non confirmé (${session?.payment_status || session?.status || 'inconnu'})`, code: 'not_paid' };
  }

  const meta = session?.metadata || {};
  let row = await db.select().from(schema.billingCheckouts)
    .where(eq(schema.billingCheckouts.stripeSessionId, sessionId)).get().catch(() => null);

  // Cas limite : webhook reçu alors que la ligne n'existe pas (base réinitialisée,
  // session créée hors Velbaz…). On la reconstruit depuis les métadonnées.
  if (!row) {
    const userId = String(meta.userId || session?.client_reference_id || '');
    if (!userId) return { ok: false, error: 'Session sans utilisateur identifiable' };
    const kind = meta.kind === 'credits' ? 'credits' : 'subscription';
    const pkg = creditPackage(meta.packageId);
    const plan = normalizePlan(meta.plan);
    const billing = normalizeBillingCycle(meta.billing);
    const insertId = String(meta.checkoutId || uuidv4());
    await db.insert(schema.billingCheckouts).values({
      id: insertId,
      userId,
      kind,
      plan: kind === 'subscription' ? plan : null,
      billing: kind === 'subscription' ? billing : null,
      packageId: kind === 'credits' ? (pkg?.id ?? null) : null,
      credits: kind === 'credits' ? (pkg?.tokens ?? 0) : planCreditsForCycle(plan, billing),
      amountCents: Number(session?.amount_total ?? 0),
      currency: String(session?.currency || CURRENCY),
      stripeSessionId: sessionId,
      status: 'pending',
    }).catch(() => {});
    row = await db.select().from(schema.billingCheckouts)
      .where(eq(schema.billingCheckouts.stripeSessionId, sessionId)).get().catch(() => null);
    if (!row) return { ok: false, error: 'Impossible d\'enregistrer le paiement' };
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).get().catch(() => null);
  if (!user) return { ok: false, error: 'Utilisateur introuvable' };

  const subscriptionId = idOf(session?.subscription);
  const paymentIntentId = idOf(session?.payment_intent);

  // ── VERROU d'idempotence : seul le premier appel passe `applied_at`. ──
  const claim: any = await db.update(schema.billingCheckouts)
    .set({
      status: 'paid',
      appliedAt: new Date(),
      updatedAt: new Date(),
      stripeSubscriptionId: subscriptionId ?? row.stripeSubscriptionId ?? null,
      stripePaymentIntentId: paymentIntentId ?? row.stripePaymentIntentId ?? null,
      amountCents: Number(session?.amount_total ?? row.amountCents ?? 0),
    })
    .where(and(eq(schema.billingCheckouts.id, row.id), isNull(schema.billingCheckouts.appliedAt)));
  const claimed = Number(claim?.rowsAffected ?? claim?.changes ?? 0) > 0;

  if (row.kind === 'credits') {
    const pkg = creditPackage(row.packageId) || null;
    const credits = row.credits || pkg?.tokens || 0;
    if (!claimed) {
      return { ok: true, already: true, kind: 'credits', tokens: user.tokens, creditsGranted: 0 };
    }
    const tokens = credits > 0
      ? await addTokens(user.id, credits, 'purchase',
          `Achat de crédits — ${pkg?.label || `${credits} crédits`} (${centsToEuros(Number(session?.amount_total ?? row.amountCents ?? 0)).toFixed(2)} €)`)
      : user.tokens;
    console.log(`[billing] ${user.email}: +${credits} crédits (session ${sessionId})`);
    controlTrackEvent('purchase', {
      userId: user.id,
      source: 'app',
      value: centsToEuros(Number(session?.amount_total ?? row.amountCents ?? 0)),
      props: { kind: 'credits', credits, packageId: row.packageId ?? null },
    });
    return { ok: true, already: false, kind: 'credits', tokens, creditsGranted: credits };
  }

  // ── Abonnement ──
  const plan = normalizePlan(row.plan);
  const billing = normalizeBillingCycle(row.billing);
  const current = normalizePlan(user.plan);

  // Fin de période : on préfère la vérité de Stripe.
  let expiresAt: Date | null = null;
  if (subscriptionId) {
    const stripe = stripeOrNull();
    if (stripe) {
      try {
        const sub: any = await stripe.subscriptions.retrieve(subscriptionId);
        expiresAt = periodEndOf(sub);
      } catch { /* on retombe sur le calcul local */ }
    }
  }
  if (!expiresAt) expiresAt = fallbackPeriodEnd(billing);

  if (!claimed) {
    return {
      ok: true, already: true, kind: 'subscription', plan, billing,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      tokens: user.tokens, creditsGranted: 0,
    };
  }

  await db.update(schema.users).set({
    plan,
    planExpiresAt: expiresAt,
    stripeSubscriptionId: subscriptionId ?? user.stripeSubscriptionId ?? null,
    stripeCustomerId: idOf(session?.customer) ?? user.stripeCustomerId ?? null,
    billingCycle: billing,
    billingStatus: 'active',
  }).where(eq(schema.users.id, user.id));

  // Crédits inclus : offerts à la souscription / montée de plan (même règle
  // qu'avant Stripe), puis à chaque renouvellement (voir invoice.paid).
  let tokens = user.tokens;
  let creditsGranted = 0;
  const upgrading = PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(current);
  const grant = planCreditsForCycle(plan, billing);
  if (upgrading && grant > 0) {
    tokens = await addTokens(user.id, grant, 'subscription',
      `Abonnement ${PLAN_CONFIG[plan].name} (${billing === 'yearly' ? 'annuel' : 'mensuel'}) — crédits inclus`);
    creditsGranted = tokens - user.tokens;
  }

  console.log(`[billing] ${user.email}: ${current} → ${plan} (${billing}, payé, jusqu'au ${formatPlanDate(expiresAt)})`);
  controlTrackEvent('purchase', {
    userId: user.id,
    source: 'app',
    value: centsToEuros(Number(session?.amount_total ?? row.amountCents ?? 0)),
    props: { kind: 'subscription', plan, billing },
  });
  return {
    ok: true, already: false, kind: 'subscription', plan, billing,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    tokens, creditsGranted,
  };
}

/** Renouvellement payé : prolonge la période et re-crédite les crédits inclus. */
async function applyRenewal(invoice: any, addTokens: AddTokens): Promise<void> {
  const subId = subscriptionIdOfInvoice(invoice);
  if (!subId) return;
  const user = await db.select().from(schema.users)
    .where(eq(schema.users.stripeSubscriptionId, subId)).get().catch(() => null);
  if (!user) return;

  const plan = normalizePlan(user.plan);
  if (plan === 'free') return; // résilié entre-temps
  const billing = normalizeBillingCycle(user.billingCycle);

  let expiresAt: Date | null = null;
  const stripe = stripeOrNull();
  if (stripe) {
    try {
      const sub: any = await stripe.subscriptions.retrieve(subId);
      expiresAt = periodEndOf(sub);
    } catch { /* calcul local */ }
  }
  if (!expiresAt) expiresAt = fallbackPeriodEnd(billing);

  await db.update(schema.users).set({ planExpiresAt: expiresAt, billingStatus: 'active' })
    .where(eq(schema.users.id, user.id)).catch(() => {});

  const grant = planCreditsForCycle(plan, billing);
  if (grant > 0) {
    await addTokens(user.id, grant, 'subscription',
      `Renouvellement ${PLAN_CONFIG[plan].name} (${billing === 'yearly' ? 'annuel' : 'mensuel'}) — crédits inclus`);
  }
  console.log(`[billing] ${user.email}: renouvellement ${plan} jusqu'au ${formatPlanDate(expiresAt)}`);
}

/** Abonnement terminé côté Stripe → retour en Free. */
async function applySubscriptionEnded(sub: any): Promise<void> {
  const subId = idOf(sub);
  if (!subId) return;
  const user = await db.select().from(schema.users)
    .where(eq(schema.users.stripeSubscriptionId, subId)).get().catch(() => null);
  if (!user) return;
  await db.update(schema.users).set({
    plan: 'free', planExpiresAt: null, stripeSubscriptionId: null,
    billingCycle: null, billingStatus: 'canceled',
  }).where(eq(schema.users.id, user.id)).catch(() => {});
  console.log(`[billing] ${user.email}: abonnement résilié → free`);
}

type AddTokens = (userId: string, amount: number, type: string, note?: string) => Promise<number>;

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────
export function registerBillingRoutes(
  app: Hono<any>,
  deps: {
    getUser: (c: any) => Promise<any>;
    addTokens: AddTokens;
  },
) {
  const { getUser, addTokens } = deps;

  // ── État du système de paiement (lu par la page /plans) ──
  app.get('/billing/config', async (c) => {
    const configured = isBillingConfigured();
    return c.json({
      configured,
      webhookConfigured: isBillingWebhookConfigured(),
      currency: CURRENCY,
      yearlyFactor: YEARLY_FACTOR,
      plans: Object.fromEntries(PAID_PLANS.map((p) => [p, {
        name: PLAN_CONFIG[p].name,
        monthly: planPrice(p, 'monthly'),
        yearly: planPrice(p, 'yearly'),
        credits: PLAN_CONFIG[p].monthlyCredits,
      }])),
      packages: CREDIT_PACKAGES,
      // Ce qu'il manque pour encaisser (affiché à l'admin, jamais bloquant).
      missing: configured ? (isBillingWebhookConfigured() ? [] : ['STRIPE_WEBHOOK_SECRET']) : ['STRIPE_SECRET_KEY'],
    });
  });

  // ── Session Checkout : ABONNEMENT ──────────────────────────────────────────
  // POST /billing/checkout/plan { plan: 'business'|'enterprise', billing }
  app.post('/billing/checkout/plan', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (String(user.plan || '').toLowerCase() === 'banned') {
      return c.json({ error: 'Ce compte est suspendu. Contacte le support.' }, 403);
    }
    const body = await c.req.json().catch(() => ({} as any));
    const raw = String(body?.plan || '').trim().toLowerCase();
    const plan = normalizePlan(raw);
    if (!PAID_PLANS.includes(plan) || plan !== (raw === 'pro' ? 'business' : raw)) {
      return c.json({ error: `Plan invalide. Valeurs payantes : ${PAID_PLANS.join(', ')}` }, 400);
    }
    const billing = normalizeBillingCycle(body?.billing);

    const stripe = stripeOrNull();
    if (!stripe) return c.json(NOT_CONFIGURED, 503);

    const cfg = PLAN_CONFIG[plan];
    const amount = planPriceCents(plan, billing);
    const checkoutId = uuidv4();
    const origin = String(body?.origin || originOf(c) || '').replace(/\/+$/, '');

    try {
      const customerId = await ensureCustomer(stripe, user);
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: String(user.id),
        line_items: [{
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: amount,
            recurring: { interval: billing === 'yearly' ? 'year' : 'month' },
            product_data: {
              name: `Velbaz ${cfg.name}`,
              description: `${cfg.monthlyCredits.toLocaleString('fr-FR')} crédits/mois · ${cfg.maxProjects < 0 ? 'projets illimités' : `${cfg.maxProjects} projets`}`,
            },
          },
        }],
        allow_promotion_codes: true,
        success_url: `${origin}/plans?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/plans?checkout=cancel`,
        metadata: { app: 'velbaz', kind: 'subscription', userId: String(user.id), plan, billing, checkoutId },
        subscription_data: {
          metadata: { app: 'velbaz', kind: 'subscription', userId: String(user.id), plan, billing, checkoutId },
        },
      });

      await db.insert(schema.billingCheckouts).values({
        id: checkoutId,
        userId: String(user.id),
        kind: 'subscription',
        plan,
        billing,
        credits: planCreditsForCycle(plan, billing),
        amountCents: amount,
        currency: CURRENCY,
        stripeSessionId: session.id,
        status: 'pending',
      }).catch(() => {});

      return c.json({
        ok: true, url: session.url, sessionId: session.id,
        plan, billing, amount: centsToEuros(amount), currency: CURRENCY,
      });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 300);
      console.error('[billing] checkout plan échoué:', msg);
      return c.json({ error: `Stripe: ${msg}`, code: 'stripe_error' }, 502);
    }
  });

  // ── Session Checkout : PACK DE CRÉDITS (paiement unique) ───────────────────
  app.post('/billing/checkout/credits', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (String(user.plan || '').toLowerCase() === 'banned') {
      return c.json({ error: 'Ce compte est suspendu. Contacte le support.' }, 403);
    }
    // Même règle produit que l'ancien /tokens/purchase : les packs de crédits
    // sont réservés aux plans payants.
    const buyGate = featureGate(user.plan, 'buyCredits');
    if (buyGate) return c.json(buyGate, 403);
    const body = await c.req.json().catch(() => ({} as any));
    const pkg = creditPackage(body?.packageId);
    if (!pkg) return c.json({ error: 'Invalid package' }, 400);

    const stripe = stripeOrNull();
    if (!stripe) return c.json(NOT_CONFIGURED, 503);

    const amount = Math.round(pkg.price * 100);
    const checkoutId = uuidv4();
    const origin = String(body?.origin || originOf(c) || '').replace(/\/+$/, '');

    try {
      const customerId = await ensureCustomer(stripe, user);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        client_reference_id: String(user.id),
        line_items: [{
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: amount,
            product_data: {
              name: `Velbaz — ${pkg.tokens.toLocaleString('fr-FR')} crédits`,
              description: 'Crédits Velbaz, sans expiration.',
            },
          },
        }],
        allow_promotion_codes: true,
        success_url: `${origin}/plans?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/plans?checkout=cancel`,
        metadata: { app: 'velbaz', kind: 'credits', userId: String(user.id), packageId: pkg.id, credits: String(pkg.tokens), checkoutId },
        payment_intent_data: {
          metadata: { app: 'velbaz', kind: 'credits', userId: String(user.id), packageId: pkg.id, checkoutId },
        },
      });

      await db.insert(schema.billingCheckouts).values({
        id: checkoutId,
        userId: String(user.id),
        kind: 'credits',
        packageId: pkg.id,
        credits: pkg.tokens,
        amountCents: amount,
        currency: CURRENCY,
        stripeSessionId: session.id,
        status: 'pending',
      }).catch(() => {});

      return c.json({
        ok: true, url: session.url, sessionId: session.id,
        packageId: pkg.id, credits: pkg.tokens, amount: pkg.price, currency: CURRENCY,
      });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 300);
      console.error('[billing] checkout crédits échoué:', msg);
      return c.json({ error: `Stripe: ${msg}`, code: 'stripe_error' }, 502);
    }
  });

  // ── Retour de Checkout : on relit la session chez Stripe et on applique ────
  // POST /billing/confirm { sessionId }
  // Idempotent, et volontairement indépendant du webhook : le premier paiement
  // est crédité même si aucun endpoint webhook n'est encore configuré.
  app.post('/billing/confirm', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({} as any));
    const sessionId = String(body?.sessionId || '').trim();
    if (!sessionId.startsWith('cs_')) return c.json({ error: 'sessionId invalide' }, 400);

    const stripe = stripeOrNull();
    if (!stripe) return c.json(NOT_CONFIGURED, 503);

    let session: any;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (e: any) {
      return c.json({ error: `Stripe: ${String(e?.message || e).slice(0, 200)}`, code: 'stripe_error' }, 502);
    }

    // La session doit appartenir à l'appelant (sinon on créditerait autrui).
    const owner = String(session?.metadata?.userId || session?.client_reference_id || '');

    // Garde-fou : une session de demande d'argent ne passe JAMAIS par ici
    // (elle créditerait un plan au lieu du budget de l'entreprise).
    if (isMoneyRequestSession(session)) {
      if (owner && owner !== String(user.id)) return c.json({ error: 'Session d\'un autre compte' }, 403);
      const mr = await applyMoneyRequestSession(session);
      if (!mr.ok) return c.json(mr, mr.code === 'not_paid' ? 402 : 400);
      return c.json({ ok: true, kind: 'money_request', ...mr });
    }
    if (owner && owner !== String(user.id)) return c.json({ error: 'Session d\'un autre compte' }, 403);
    if (!owner) {
      const row = await db.select().from(schema.billingCheckouts)
        .where(eq(schema.billingCheckouts.stripeSessionId, sessionId)).get().catch(() => null);
      if (!row || row.userId !== String(user.id)) return c.json({ error: 'Session inconnue' }, 404);
    }

    const res = await applyPaidSession(session, addTokens);
    if (!res.ok) return c.json(res, res.code === 'not_paid' ? 402 : 400);
    const fresh = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get().catch(() => null);
    return c.json({
      ...res,
      plan: normalizePlan(fresh?.plan ?? user.plan),
      tokens: fresh?.tokens ?? (res as any).tokens,
      expiresAt: fresh?.planExpiresAt ? new Date(fresh.planExpiresAt).toISOString() : null,
      expiresAtLabel: fresh?.planExpiresAt ? formatPlanDate(fresh.planExpiresAt) : null,
    });
  });

  // ── Résiliation : fin à l'échéance, pas de perte du temps déjà payé ────────
  app.post('/billing/cancel', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const subId = user.stripeSubscriptionId ? String(user.stripeSubscriptionId) : '';
    if (!subId) {
      // Aucun abonnement Stripe : on repasse simplement en Free.
      await db.update(schema.users).set({ plan: 'free', planExpiresAt: null, billingCycle: null, billingStatus: 'canceled' })
        .where(eq(schema.users.id, user.id)).catch(() => {});
      return c.json({ ok: true, plan: 'free', canceledImmediately: true });
    }
    const stripe = stripeOrNull();
    if (!stripe) return c.json(NOT_CONFIGURED, 503);
    try {
      const sub: any = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
      const end = periodEndOf(sub);
      await db.update(schema.users).set({ billingStatus: 'canceling' }).where(eq(schema.users.id, user.id)).catch(() => {});
      return c.json({
        ok: true, cancelAtPeriodEnd: true,
        plan: normalizePlan(user.plan),
        endsAt: end ? end.toISOString() : null,
        endsAtLabel: end ? formatPlanDate(end) : null,
      });
    } catch (e: any) {
      return c.json({ error: `Stripe: ${String(e?.message || e).slice(0, 200)}`, code: 'stripe_error' }, 502);
    }
  });

  // ── Portail client Stripe (factures, moyen de paiement) — optionnel ────────
  app.post('/billing/portal', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const stripe = stripeOrNull();
    if (!stripe) return c.json(NOT_CONFIGURED, 503);
    if (!user.stripeCustomerId) return c.json({ error: 'Aucun paiement enregistré sur ce compte.', code: 'no_customer' }, 400);
    const origin = String(originOf(c) || '').replace(/\/+$/, '');
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: String(user.stripeCustomerId),
        return_url: `${origin}/plans`,
      });
      return c.json({ ok: true, url: portal.url });
    } catch (e: any) {
      // Le portail exige une configuration activée dans le dashboard Stripe :
      // son absence ne doit pas casser la page (la résiliation reste possible).
      return c.json({ error: `Stripe: ${String(e?.message || e).slice(0, 200)}`, code: 'portal_unavailable' }, 502);
    }
  });

  // ── Historique des paiements de l'utilisateur ──────────────────────────────
  app.get('/billing/history', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const rows = await db.select().from(schema.billingCheckouts)
      .where(eq(schema.billingCheckouts.userId, String(user.id)))
      .orderBy(desc(schema.billingCheckouts.createdAt))
      .limit(50).catch(() => []);
    return c.json({
      payments: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        plan: r.plan,
        billing: r.billing,
        packageId: r.packageId,
        credits: r.credits,
        amount: centsToEuros(Number(r.amountCents || 0)),
        currency: r.currency,
        status: r.status,
        paidAt: r.appliedAt ? new Date(r.appliedAt).toISOString() : null,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      })),
    });
  });

  // ── Webhook Stripe (signé) ────────────────────────────────────────────────
  // POST /billing/webhook  — à déclarer dans le dashboard Stripe.
  app.post('/billing/webhook', async (c) => {
    const stripe = stripeOrNull();
    if (!stripe) return c.json(NOT_CONFIGURED, 503);
    const whSecret = getSecret('STRIPE_WEBHOOK_SECRET');
    if (!whSecret || !whSecret.trim()) {
      return c.json({
        error: 'Webhook non configuré : ajoute STRIPE_WEBHOOK_SECRET dans l\'Admin Panel.',
        code: 'webhook_not_configured',
      }, 503);
    }
    const signature = c.req.header('stripe-signature') || '';
    if (!signature) return c.json({ error: 'Signature manquante' }, 400);

    // Corps BRUT obligatoire : la signature porte sur les octets envoyés.
    const payload = await c.req.text();
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(payload, signature, whSecret.trim());
    } catch (e: any) {
      console.warn('[billing] webhook signature invalide:', String(e?.message || e).slice(0, 200));
      return c.json({ error: 'Signature invalide' }, 400);
    }

    // Idempotence : Stripe rejoue ses événements. L'insertion sert de verrou.
    const obj: any = (event as any).data?.object || {};
    try {
      await db.insert(schema.billingEvents).values({
        id: String(event.id), type: String(event.type), payloadId: idOf(obj),
      });
    } catch {
      return c.json({ received: true, duplicate: true });
    }

    try {
      // Vente d'un site généré encaissée par le Stripe Velbaz : ni plan, ni
      // crédits → module dédié (commission + solde en attente).
      const pp = await import('./platform-payments');
      if (pp.isPlatformEvent(event as any)) {
        await pp.handlePlatformEvent(event as any);
        return c.json({ received: true, type: event.type, platform: true });
      }
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          // AIGUILLAGE : une demande d'argent de l'IA n'est NI un plan NI des
          // crédits. On l'envoie à son propre module, sinon applyPaidSession
          // la reconstruirait en « abonnement » et créditerait le mauvais poste.
          if (isMoneyRequestSession(obj)) {
            const mr = await applyMoneyRequestSession(obj);
            if (!mr.ok) console.warn('[billing] webhook demande d\'argent non appliquée:', mr.error);
            break;
          }
          const res = await applyPaidSession(obj, addTokens);
          if (!res.ok) console.warn('[billing] webhook session non appliquée:', res.error);
          break;
        }
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed': {
          const sid = idOf(obj);
          if (sid) {
            await db.update(schema.billingCheckouts)
              .set({ status: event.type === 'checkout.session.expired' ? 'expired' : 'failed', updatedAt: new Date() })
              .where(and(eq(schema.billingCheckouts.stripeSessionId, sid), isNull(schema.billingCheckouts.appliedAt)))
              .catch(() => {});
          }
          break;
        }
        case 'invoice.paid':
        case 'invoice.payment_succeeded': {
          // Seuls les RENOUVELLEMENTS passent ici : la première facture est
          // déjà traitée par checkout.session.completed.
          const reason = String(obj?.billing_reason || '');
          if (reason === 'subscription_cycle' || reason === 'subscription_update') {
            // Un abonnement issu d'une demande d'argent recrédite le budget de
            // l'entreprise, pas le plan de l'utilisateur. applyMoneyRequestInvoice
            // renvoie not_found si la facture ne concerne aucune demande, et
            // dans ce cas seulement on traite le renouvellement de plan.
            const mr = await applyMoneyRequestInvoice(obj);
            if (!mr.ok && mr.code === 'not_found') await applyRenewal(obj, addTokens);
            else if (!mr.ok && mr.code !== 'no_subscription') {
              console.warn('[billing] renouvellement demande d\'argent non appliqué:', mr.error);
            }
          }
          break;
        }
        case 'invoice.payment_failed': {
          const subId = subscriptionIdOfInvoice(obj);
          if (subId) {
            await db.update(schema.users).set({ billingStatus: 'past_due' })
              .where(eq(schema.users.stripeSubscriptionId, subId)).catch(() => {});
          }
          break;
        }
        case 'customer.subscription.updated': {
          const subId = idOf(obj);
          const status = String(obj?.status || '');
          if (subId) {
            if (status === 'canceled' || status === 'incomplete_expired') {
              await applySubscriptionEnded(obj);
            } else {
              const end = periodEndOf(obj);
              await db.update(schema.users).set({
                billingStatus: obj?.cancel_at_period_end ? 'canceling' : (status || 'active'),
                ...(end ? { planExpiresAt: end } : {}),
              }).where(eq(schema.users.stripeSubscriptionId, subId)).catch(() => {});
            }
          }
          break;
        }
        case 'customer.subscription.deleted': {
          await applySubscriptionEnded(obj);
          break;
        }
        default:
          break;
      }
    } catch (e: any) {
      // On répond 500 pour que Stripe réessaie, mais on libère le verrou
      // d'idempotence afin que le rejeu puisse réellement retraiter.
      console.error('[billing] webhook erreur:', String(e?.message || e).slice(0, 300));
      await db.delete(schema.billingEvents).where(eq(schema.billingEvents.id, String(event.id))).catch(() => {});
      return c.json({ error: 'Traitement échoué' }, 500);
    }

    return c.json({ received: true, type: event.type });
  });
}
