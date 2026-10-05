import { describe, expect, test } from 'bun:test';
import {
  platformFeePercent, computeSplit, choosePayoutRoute, buildPlatformSessionParams,
  safeOrigin, splitAfterRefund, isPlatformEvent, invoicePlatformMeta, DEFAULT_PLATFORM_FEE_PERCENT,
  checkoutReturnBase, isCheckoutSessionId, orderRefOf, sitePreviewPath,
  computeMarginSplit, checkoutCosts, stripeFeeEstimateCents, supplierVatPercent, DEFAULT_SUPPLIER_VAT_PERCENT,
} from './platform-payments';
import { printifyBilledUsd, printifyOnHoldTooLong } from './dropship/fulfillment';
import { SERVER_STRIPE } from './builder/scaffold';

describe('commission plateforme', () => {
  test('taux : défaut, virgule, %, bornes', () => {
    expect(platformFeePercent('')).toBe(DEFAULT_PLATFORM_FEE_PERCENT);
    expect(platformFeePercent('abc')).toBe(DEFAULT_PLATFORM_FEE_PERCENT);
    expect(platformFeePercent('-3')).toBe(DEFAULT_PLATFORM_FEE_PERCENT);
    expect(platformFeePercent('7,5')).toBe(7.5);
    expect(platformFeePercent('15%')).toBe(15);
    expect(platformFeePercent('0')).toBe(0);
    expect(platformFeePercent('90')).toBe(50);
  });

  test('split : fee + net = brut, arrondi au centime', () => {
    expect(computeSplit(2999, 10)).toEqual({ gross: 2999, fee: 300, net: 2699 });
    expect(computeSplit(100, 0)).toEqual({ gross: 100, fee: 0, net: 100 });
    expect(computeSplit(-5, 10)).toEqual({ gross: 0, fee: 0, net: 0 });
    for (const g of [1, 99, 1234, 99999]) {
      const s = computeSplit(g, 12.5);
      expect(s.fee + s.net).toBe(g);
      expect(s.fee).toBeGreaterThanOrEqual(0);
    }
  });

  test('remboursement partiel recalcule le net', () => {
    expect(splitAfterRefund(5000, 2000, 10)).toMatchObject({ gross: 3000, fee: 300, net: 2700 });
    expect(splitAfterRefund(5000, 9000, 10)).toMatchObject({ gross: 0, fee: 0, net: 0 });
  });
});

describe('aiguillage connecté / stocké', () => {
  test('pas de compte, ou virements inactifs → hold', () => {
    expect(choosePayoutRoute(null)).toBe('hold');
    expect(choosePayoutRoute({ stripeAccountId: null, stripePayoutsEnabled: true })).toBe('hold');
    expect(choosePayoutRoute({ stripeAccountId: 'acct_1', stripePayoutsEnabled: false })).toBe('hold');
    expect(choosePayoutRoute({ stripeAccountId: 'acct_1', stripePayoutsEnabled: true })).toBe('destination');
  });

  const items = [
    { name: 'T-shirt', unitAmountCents: 2500, quantity: 2, currency: 'eur', productId: 'p1', vid: 'v1' },
    { name: 'Mug', unitAmountCents: 1000, quantity: 1, currency: 'eur', productId: 'p2' },
  ];

  test('hold : encaissé sur Velbaz, AUCUN transfert ni application_fee', () => {
    const { params, split } = buildPlatformSessionParams({
      companyId: 'c1', items, origin: 'https://shop.test', feePercent: 10, route: 'hold',
    });
    expect(split).toEqual({ gross: 6000, fee: 600, net: 5400 });
    expect(params.mode).toBe('payment');
    expect(params.payment_intent_data?.transfer_data).toBeUndefined();
    expect(params.payment_intent_data?.application_fee_amount).toBeUndefined();
    expect(params.metadata?.velbazPlatform).toBe('1');
    expect(params.metadata?.vzRoute).toBe('hold');
    expect(params.metadata?.companyId).toBe('c1');
    expect(JSON.parse(String(params.metadata?.items))).toEqual([{ p: 'p1', v: 'v1', q: 2 }, { p: 'p2', v: null, q: 1 }]);
    expect(params.shipping_address_collection).toBeDefined();
    expect((params as any).adaptive_pricing).toEqual({ enabled: false });
    expect(params.success_url).toBe('https://shop.test/success?session_id={CHECKOUT_SESSION_ID}');
  });

  test('destination : commission toujours prélevée + net envoyé au propriétaire', () => {
    const { params } = buildPlatformSessionParams({
      companyId: 'c1', items, origin: 'https://shop.test', feePercent: 10, route: 'destination', destination: 'acct_9',
    });
    expect(params.payment_intent_data?.application_fee_amount).toBe(600);
    expect(params.payment_intent_data?.transfer_data?.destination).toBe('acct_9');
    expect(params.metadata?.vzRoute).toBe('destination');
  });

  test('destination sans compte → retombe en hold', () => {
    const { params } = buildPlatformSessionParams({
      companyId: 'c1', items, origin: 'https://shop.test', feePercent: 10, route: 'destination', destination: null,
    });
    expect(params.metadata?.vzRoute).toBe('hold');
    expect(params.payment_intent_data?.transfer_data).toBeUndefined();
  });

  test('abonnement : application_fee_percent + metadata sur la souscription', () => {
    const sub = [{ name: 'Pro', unitAmountCents: 900, quantity: 1, interval: 'month' }];
    const d = buildPlatformSessionParams({ companyId: 'c1', items: sub, mode: 'subscription', origin: 'https://x.test', feePercent: 12, route: 'destination', destination: 'acct_9' });
    expect(d.params.mode).toBe('subscription');
    expect(d.params.subscription_data?.application_fee_percent).toBe(12);
    expect(d.params.subscription_data?.transfer_data?.destination).toBe('acct_9');
    expect(d.params.subscription_data?.metadata?.velbazPlatform).toBe('1');
    expect(d.params.payment_intent_data).toBeUndefined();
    const h = buildPlatformSessionParams({ companyId: 'c1', items: sub, mode: 'subscription', origin: 'https://x.test', feePercent: 12, route: 'hold' });
    expect(h.params.subscription_data?.application_fee_percent).toBeUndefined();
    expect(h.params.subscription_data?.metadata?.vzRoute).toBe('hold');
  });
});

describe('sécurité / webhooks', () => {
  test('origine : http(s) uniquement', () => {
    expect(safeOrigin('https://a.test/api/companies/x/preview/')).toBe('https://a.test/api/companies/x/preview');
    expect(safeOrigin('javascript:alert(1)')).toBeNull();
    expect(safeOrigin('')).toBeNull();
  });

  test('isPlatformEvent ne capte que les sessions Velbaz', () => {
    expect(isPlatformEvent({ type: 'checkout.session.completed', data: { object: { metadata: { velbazPlatform: '1' } } } })).toBe(true);
    expect(isPlatformEvent({ type: 'checkout.session.completed', data: { object: { metadata: { userId: 'u' } } } })).toBe(false);
    expect(isPlatformEvent({ type: 'customer.subscription.updated', data: { object: {} } })).toBe(false);
    const inv = { parent: { subscription_details: { metadata: { velbazPlatform: '1', companyId: 'c1' } } } };
    expect(isPlatformEvent({ type: 'invoice.paid', data: { object: inv } })).toBe(true);
    expect(invoicePlatformMeta({ subscription_details: { metadata: { velbazPlatform: '1', companyId: 'c2' } } })?.companyId).toBe('c2');
    expect(isPlatformEvent({ type: 'invoice.paid', data: { object: { billing_reason: 'subscription_cycle' } } })).toBe(false);
  });
});

describe('site généré', () => {
  test('checkout passe d\'abord par le Stripe Velbaz, plus de « Connecte tes clés »', () => {
    expect(SERVER_STRIPE).toContain('/checkout/platform-session');
    expect(SERVER_STRIPE).toContain('/checkout/platform-confirm');
    expect(SERVER_STRIPE).toContain('platformPayments === true');
    expect(SERVER_STRIPE).not.toContain('Connecte tes clés Stripe');
    expect(SERVER_STRIPE).toContain('adaptive_pricing: { enabled: false }');
    // La voie plateforme est tentée AVANT la clé propre.
    const post = SERVER_STRIPE.slice(SERVER_STRIPE.indexOf('checkoutRoute.post("/checkout"'));
    expect(post.indexOf('platformCheckout(')).toBeLessThan(post.indexOf('getStripe()'));
  });
});

describe('retour Stripe vers le VRAI site (plus de 404 Velbaz)', () => {
  const id = '18540b27-e90e-415d-936e-83a17d90ea4c';
  const pre = `/api/companies/${id}/preview`;
  test('origine nue → préfixe de l\'aperçu ajouté', () => {
    expect(sitePreviewPath(id)).toBe(pre);
    expect(checkoutReturnBase(id, 'https://velbaz.com')).toBe('https://velbaz.com' + pre);
    expect(checkoutReturnBase(id, 'https://velbaz.com/')).toBe('https://velbaz.com' + pre);
  });
  test('base déjà préfixée (sites récents) : conservée, suffixe coupé', () => {
    expect(checkoutReturnBase(id, 'https://velbaz.com' + pre)).toBe('https://velbaz.com' + pre);
    expect(checkoutReturnBase(id, 'https://velbaz.com' + pre + '/panier?x=1')).toBe('https://velbaz.com' + pre);
  });
  test('protocole invalide → null', () => {
    expect(checkoutReturnBase(id, 'javascript:alert(1)')).toBeNull();
    expect(checkoutReturnBase(id, '')).toBeNull();
    expect(checkoutReturnBase(id, 'ftp://x.y')).toBeNull();
  });
  test('id de session Stripe', () => {
    expect(isCheckoutSessionId('cs_test_a1B2c3D4e5F6g7H8')).toBe(true);
    expect(isCheckoutSessionId('cs_live_a1B2c3D4e5F6g7H8')).toBe(true);
    expect(isCheckoutSessionId('cs_test_../../etc')).toBe(false);
    expect(isCheckoutSessionId('pi_123')).toBe(false);
    expect(isCheckoutSessionId(undefined)).toBe(false);
  });
  test('n° de commande lisible', () => {
    expect(orderRefOf('3f9a-2b7c-11aa-ffee')).toBe('CMD-3F9A2B7C');
  });
});

describe('commission sur la MARGE (pas sur la vente)', () => {
  test("exemple : coût 25, vendu 30 → marge 5, Velbaz 0,50, propriétaire 4,50", () => {
    const m = computeMarginSplit(3000, 2500, 2500, 10);
    expect(m).toEqual({ gross: 3000, cost: 2500, margin: 500, fee: 50, reserve: 2500, net: 450 });
    // Velbaz garde commission + coût Printify qu'il paie lui-même.
    expect(m.fee + m.reserve).toBe(2550);
    expect(m.fee + m.reserve + m.net).toBe(3000);
  });

  test('sans coût → identique à l\'ancienne commission sur le brut', () => {
    expect(computeMarginSplit(6000, 0, 0, 10)).toMatchObject(computeSplit(6000, 10));
  });

  test('coût ≥ prix → aucune commission, jamais de net négatif', () => {
    const m = computeMarginSplit(2000, 2600, 2600, 10);
    expect(m.margin).toBe(0); expect(m.fee).toBe(0);
    expect(m.reserve).toBe(2000); expect(m.net).toBe(0);
  });

  test('coût payé par le propriétaire (CJ) : déduit de la marge, pas gardé', () => {
    const m = computeMarginSplit(3000, 2500, 0, 10);
    expect(m.fee).toBe(50); expect(m.reserve).toBe(0); expect(m.net).toBe(2950);
  });

  test('frais Stripe estimés 1,5 % + 0,25 €', () => {
    expect(stripeFeeEstimateCents(3000)).toBe(70);
    expect(stripeFeeEstimateCents(0)).toBe(0);
  });

  test('TVA fournisseur : défaut 21 %, réglable', () => {
    expect(supplierVatPercent('')).toBe(DEFAULT_SUPPLIER_VAT_PERCENT);
    expect(supplierVatPercent('0')).toBe(0);
    expect(supplierVatPercent('20,5')).toBe(20.5);
  });

  const products = [
    { id: 'tee', printifyProductId: 'pf1', costPrice: 13.15, shippingCost: 4.69, landedCost: 15.79 },
    { id: 'cj', supplierId: 's1', costPrice: 10, shippingCost: 2, landedCost: null },
    { id: 'own', costPrice: 8 }, // coût saisi à la main : ne réduit pas la commission
  ];

  test('Printify payé par Velbaz : coût complet + TVA gardé, + Stripe', () => {
    const c = checkoutCosts([{ productId: 'tee', quantity: 2, unitAmountCents: 2899 }], products, { velbazPaysPrintify: true, vatPercent: 21, usdEur: 0.9 });
    expect(c.supplierCents).toBe(Math.round(15.79 * 1.21 * 100) * 2);
    expect(c.stripeCents).toBe(stripeFeeEstimateCents(5798));
    expect(c.costCents).toBe(c.supplierCents + c.stripeCents);
    expect(c.reserveCents).toBe(c.costCents);
  });

  test('token Printify du propriétaire : coût déduit mais pas gardé', () => {
    const c = checkoutCosts([{ productId: 'tee', quantity: 1, unitAmountCents: 2899 }], products, { velbazPaysPrintify: false, vatPercent: 21, usdEur: 0.9 });
    expect(c.reserveCents).toBe(c.stripeCents);
    expect(c.costCents).toBeGreaterThan(c.reserveCents);
  });

  test('CJ converti USD→EUR, produit maison sans coût fournisseur', () => {
    const c = checkoutCosts([
      { productId: 'cj', quantity: 1, unitAmountCents: 3000 },
      { productId: 'own', quantity: 1, unitAmountCents: 2000 },
    ], products, { velbazPaysPrintify: true, vatPercent: 21, usdEur: 0.9 });
    expect(c.supplierCents).toBe(1100); // 10 $ × 0,9 + 2 € de port
    expect(c.reserveCents).toBe(c.stripeCents);
  });

  test('abonnement : pas de coûts (commission sur le montant)', () => {
    const c = checkoutCosts([{ productId: 'tee', quantity: 1, unitAmountCents: 900 }], products, { velbazPaysPrintify: true, vatPercent: 21, usdEur: 1, subscription: true });
    expect(c).toEqual({ costCents: 0, reserveCents: 0, supplierCents: 0, stripeCents: 0 });
  });

  test('session : destination → application_fee = commission + coûts gardés ; metadata', () => {
    const items = [{ name: 'Tee', unitAmountCents: 3000, quantity: 1, currency: 'eur', productId: 'tee', vid: '1' }];
    const d = buildPlatformSessionParams({ companyId: 'c1', items, origin: 'https://x.test', feePercent: 10, route: 'destination', destination: 'acct_9', costCents: 2500, reserveCents: 2500 });
    expect(d.params.payment_intent_data?.application_fee_amount).toBe(2550);
    expect(d.split).toEqual({ gross: 3000, fee: 50, net: 450 });
    expect(d.params.metadata?.vzCost).toBe('2500');
    expect(d.params.metadata?.vzReserve).toBe('2500');
    const h = buildPlatformSessionParams({ companyId: 'c1', items, origin: 'https://x.test', feePercent: 10, route: 'hold', costCents: 2500, reserveCents: 2500 });
    expect(h.split.net).toBe(450);
    expect(h.params.payment_intent_data?.application_fee_amount).toBeUndefined();
  });

  test('remboursement partiel : les coûts engagés restent dus', () => {
    expect(splitAfterRefund(3000, 300, 10, 2500, 2500)).toEqual({ gross: 2700, fee: 20, net: 180, cost: 2500, reserve: 2500 });
    expect(splitAfterRefund(3000, 3000, 10, 2500, 2500)).toEqual({ gross: 0, fee: 0, net: 0, cost: 0, reserve: 0 });
  });
});

describe('Printify : coût réel et commandes bloquées', () => {
  test('coût facturé = production + port + taxe (USD)', () => {
    expect(printifyBilledUsd({ total_price: 1315, total_shipping: 469, total_tax: 374 })).toBe(21.58);
    expect(printifyBilledUsd({ total_price: 0 })).toBeNull();
  });
  test('on-hold > 26 h → alerte', () => {
    const now = Date.parse('2026-10-03T00:00:00Z');
    expect(printifyOnHoldTooLong({ status: 'on-hold', created_at: '2026-10-01 18:47:33+00:00' }, now)).toBe(true);
    expect(printifyOnHoldTooLong({ status: 'on-hold', created_at: '2026-10-02 18:47:33' }, now)).toBe(false);
    expect(printifyOnHoldTooLong({ status: 'in-production', created_at: '2026-10-01 18:47:33' }, now)).toBe(false);
  });
});
