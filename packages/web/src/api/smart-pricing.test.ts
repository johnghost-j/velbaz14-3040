import { describe, expect, test } from 'bun:test';
import {
  analyzePrice, benchmarkFor, floorTo99, netProfit, profitableFloor, setVariantsPriceJson,
  shippingFromProfiles, stripeFee,
} from './smart-pricing';

describe('floorTo99', () => {
  test('arrondit au .99 inférieur ou égal', () => {
    expect(floorTo99(65)).toBe(64.99);
    expect(floorTo99(64.99)).toBe(64.99);
    expect(floorTo99(64.5)).toBe(63.99);
    expect(floorTo99(0)).toBe(0);
  });
});

describe('frais et bénéfice', () => {
  test('Stripe 1,5 % + 0,25 €', () => {
    expect(stripeFee(100)).toBe(1.75);
    expect(netProfit(100, 50)).toBe(48.25);
  });
  test('plancher rentable : ≥ 25 % net et ≥ 5 €', () => {
    const f = profitableFloor(32.6);
    const net = netProfit(f, 32.6);
    expect(net).toBeGreaterThanOrEqual(5);
    expect(net / f).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(String(f)).toMatch(/\.99$/);
    // petit article : la règle des 5 € domine
    const small = profitableFloor(3);
    expect(netProfit(small, 3)).toBeGreaterThanOrEqual(5);
  });
});

describe('benchmarkFor', () => {
  test('reconnaît le type depuis le titre du modèle Printify', () => {
    expect(benchmarkFor('Single Jersey T-shirt')?.key).toBe('tshirt');
    expect(benchmarkFor('Unisex Hooded Sweatshirt')?.key).toBe('hoodie');
    expect(benchmarkFor('Unisex Zip Hoodie')?.key).toBe('zip_hoodie');
    expect(benchmarkFor("Men's Low-Top Leather Sneakers")?.key).toBe('sneakers');
    expect(benchmarkFor('Unisex Crewneck Sweatshirt')?.key).toBe('sweatshirt');
    expect(benchmarkFor('Unisex Long Sleeve Tee')?.key).toBe('long_sleeve');
    expect(benchmarkFor('Ceramic Mug 11oz')?.key).toBe('mug');
  });
  test('ordre de priorité : premier texte reconnu', () => {
    expect(benchmarkFor(null, 'Stride One General', 'Basket en cuir premium')?.key).toBe('sneakers');
    expect(benchmarkFor('', 'Stride One', '')).toBeNull();
  });
});

describe('shippingFromProfiles', () => {
  const profiles = [
    { variant_ids: [1, 2], first_item: { cost: 399, currency: 'USD' }, countries: ['DE'] },
    { variant_ids: [1, 2], first_item: { cost: 469, currency: 'USD' }, countries: ['FR', 'PL'] },
    { variant_ids: [3], first_item: { cost: 999, currency: 'USD' }, countries: ['FR'] },
    { variant_ids: [1, 2, 3], first_item: { cost: 1559, currency: 'USD' }, countries: ['REST_OF_THE_WORLD'] },
  ];
  test('profil du pays pour les variantes actives', () => {
    expect(shippingFromProfiles(profiles, 'fr', [1, 2])).toEqual({ firstItemCents: 469, currency: 'USD', matched: 'country' });
  });
  test('variante plus chère à expédier → le plus cher', () => {
    expect(shippingFromProfiles(profiles, 'FR', [1, 3])?.firstItemCents).toBe(999);
  });
  test('pays absent → reste du monde', () => {
    expect(shippingFromProfiles(profiles, 'JP', [1])).toEqual({ firstItemCents: 1559, currency: 'USD', matched: 'rest_of_world' });
  });
  test('aucun profil → null', () => {
    expect(shippingFromProfiles([], 'FR')).toBeNull();
    expect(shippingFromProfiles(null, 'FR')).toBeNull();
  });
});

describe('analyzePrice', () => {
  const sneakers = { key: 'sneakers', label: 'Sneakers', low: 59.99, typical: 79.99, high: 109.99 };
  const tee = { key: 'tshirt', label: 'T-shirt', low: 19.99, typical: 27.99, high: 34.99 };
  const hoodie = { key: 'hoodie', label: 'Hoodie', low: 44.99, typical: 54.99, high: 69.99 };

  test('chaussure à 35,99 € avec 15 € de port : trop bas, remontée dans le marché', () => {
    const a = analyzePrice({ productCost: 17.47, shipping: 15.13, currentPrice: 35.99, market: sneakers, guardFloor: 27.99 });
    expect(a.landedCost).toBe(32.6);
    expect(a.verdict).toBe('too_low');
    expect(a.recommended).toBe(59.99);
    expect(a.next.net).toBeGreaterThan(20);
    expect(a.current.net!).toBeLessThan(5);
    expect(a.reason).toContain('Trop bas');
  });

  test('prix dans la fourchette : verdict ok, prix optimal = cible', () => {
    const a = analyzePrice({ productCost: 11.64, shipping: 4.15, currentPrice: 25, market: tee });
    expect(a.verdict).toBe('ok');
    expect(a.recommended).toBe(28.99);
    expect(a.recommended).toBeGreaterThanOrEqual(a.range.low);
    expect(a.recommended).toBeLessThanOrEqual(a.range.high);
  });

  test('cible au-dessus du marché : plafonnée au prix haut du marché', () => {
    const a = analyzePrice({ productCost: 22.99, shipping: 16.37, currentPrice: 46.99, market: hoodie });
    expect(a.target).toBeGreaterThan(69.99);
    expect(a.recommended).toBe(69.99);
    expect(a.verdict).toBe('too_low');
  });

  test('trop cher pour le marché : verdict trop haut, baisse vers le prix optimal', () => {
    const a = analyzePrice({ productCost: 11.64, shipping: 4.15, currentPrice: 49.99, market: tee });
    expect(a.verdict).toBe('too_high');
    expect(a.recommended).toBeLessThan(49.99);
    expect(a.reason).toContain('Trop haut');
  });

  test('coût trop élevé pour le marché : plancher rentable, signalé', () => {
    const a = analyzePrice({ productCost: 30, shipping: 10, currentPrice: 34.99, market: tee });
    expect(a.aboveMarket).toBe(true);
    expect(a.recommended).toBe(a.floor);
    expect(a.next.net).toBeGreaterThanOrEqual(5);
  });

  test('sans repère de marché : entre plancher et 3× le coût', () => {
    const a = analyzePrice({ productCost: 10, shipping: 5, currentPrice: null, market: null });
    expect(a.verdict).toBe('unknown');
    expect(a.recommended).toBeGreaterThanOrEqual(a.floor);
    expect(a.recommended).toBeLessThanOrEqual(45);
    expect(String(a.recommended)).toMatch(/\.99$/);
  });

  test('jamais sous le plancher du garde-fou checkout', () => {
    const a = analyzePrice({ productCost: 2, shipping: 0, currentPrice: 3, market: { key: 'sticker', label: 'Sticker', low: 2.99, typical: 4.99, high: 7.99 }, guardFloor: 9.99 });
    expect(a.recommended).toBeGreaterThanOrEqual(9.99);
  });
});

describe('setVariantsPriceJson', () => {
  test('tableau [{vid,label,price}] : prix exact, même à la baisse', () => {
    const raw = JSON.stringify([{ vid: 1, label: 'S', price: 80 }, { vid: 2, label: 'M', price: 20 }]);
    expect(JSON.parse(setVariantsPriceJson(raw, 59.99)!)).toEqual([{ vid: 1, label: 'S', price: 59.99 }, { vid: 2, label: 'M', price: 59.99 }]);
  });
  test('objet { printifyVariants }', () => {
    const raw = JSON.stringify({ colors: ['Black'], printifyVariants: [{ vid: 1, price: 25 }] });
    const out = JSON.parse(setVariantsPriceJson(raw, 28.99)!);
    expect(out.colors).toEqual(['Black']);
    expect(out.printifyVariants[0].price).toBe(28.99);
  });
  test('vide ou illisible : inchangé', () => {
    expect(setVariantsPriceJson(null, 10)).toBeNull();
    expect(setVariantsPriceJson('pas du json', 10)).toBe('pas du json');
  });
});
