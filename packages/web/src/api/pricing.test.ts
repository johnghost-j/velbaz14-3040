import { describe, expect, test } from "bun:test";
import {
  ceilTo99, targetRetailFor, marginPercent, priceVariantsFromCost, repriceVariantsJson,
  TARGET_MARKUP, TARGET_PROFIT_MIN,
} from "./pricing";
import { pricingFromProductData } from "./printify-auto";

describe("ceilTo99", () => {
  test("arrondit au .99 supérieur ou égal", () => {
    expect(ceilTo99(35.53)).toBe(35.99);
    expect(ceilTo99(35.99)).toBe(35.99);
    expect(ceilTo99(36)).toBe(36.99);
    expect(ceilTo99(0)).toBe(0);
  });
});

describe("targetRetailFor", () => {
  test("chaussure Printify à 19,74 € → 35,99 € (et plus 25 €)", () => {
    expect(targetRetailFor(19.74)).toBe(35.99);
  });
  test("petit article : au moins +10 € de marge", () => {
    const p = targetRetailFor(5);
    expect(p).toBeGreaterThanOrEqual(5 + TARGET_PROFIT_MIN);
    expect(p).toBe(15.99);
  });
  test("toujours ≥ coût × markup et strictement au-dessus du coût", () => {
    for (const c of [1, 3.2, 9.99, 12.5, 19.74, 33, 80, 140.1]) {
      const p = targetRetailFor(c);
      expect(p).toBeGreaterThanOrEqual(c * TARGET_MARKUP - 1e-9);
      expect(p).toBeGreaterThan(c);
      expect(Math.round((p % 1) * 100)).toBe(99);
    }
  });
  test("coût inconnu → 0", () => {
    expect(targetRetailFor(0)).toBe(0);
    expect(targetRetailFor(NaN)).toBe(0);
  });
});

describe("marginPercent", () => {
  test("calcule la marge sur le prix de vente", () => {
    expect(marginPercent(35.99, 19.74)).toBe(45.2);
    expect(marginPercent(null, 10)).toBeNull();
  });
});

describe("priceVariantsFromCost", () => {
  test("prix par variante au-dessus du coût, prix demandé trop bas relevé", () => {
    const r = priceVariantsFromCost([
      { id: 1, cost: 1974, is_enabled: true },
      { id: 2, cost: 1974, is_enabled: true },
    ], 2500)!;
    expect(r.costPrice).toBe(19.74);
    expect(r.retailPrice).toBe(35.99);
    expect(r.priceCents.get(1)).toBe(3599);
    expect(r.priceCents.get(2)).toBe(3599);
    expect(r.margin).toBe(45.2);
  });
  test("un prix demandé plus haut est conservé", () => {
    const r = priceVariantsFromCost([{ id: 1, cost: 1000, is_enabled: true }], 4999)!;
    expect(r.priceCents.get(1)).toBe(4999);
    expect(r.retailPrice).toBe(49.99);
  });
  test("tailles plus chères : chaque variante couvre le coût max", () => {
    const r = priceVariantsFromCost([
      { id: 1, cost: 1000, is_enabled: true },
      { id: 2, cost: 1600, is_enabled: true },
    ], 0)!;
    expect(r.costPrice).toBe(16);
    for (const cents of r.priceCents.values()) expect(cents / 100).toBeGreaterThan(16 * TARGET_MARKUP - 0.01);
  });
  test("aucun coût connu → null (on n'invente rien)", () => {
    expect(priceVariantsFromCost([{ id: 1, cost: 0, is_enabled: true }], 2500)).toBeNull();
    expect(priceVariantsFromCost([], 2500)).toBeNull();
  });
});

describe("repriceVariantsJson", () => {
  test("tableau [{vid,label,price}]", () => {
    const raw = JSON.stringify([{ vid: 1, label: "Black / EU 40", price: 25 }, { vid: 2, label: "x", price: 25 }]);
    const out = JSON.parse(repriceVariantsJson(raw, new Map([[1, 3599]]), 35.99)!);
    expect(out[0].price).toBe(35.99);
    expect(out[1].price).toBe(35.99);
    expect(out[0].label).toBe("Black / EU 40");
  });
  test("objet { printifyVariants }", () => {
    const raw = JSON.stringify({ foo: 1, printifyVariants: [{ vid: 7, label: "M", price: 20 }] });
    const out = JSON.parse(repriceVariantsJson(raw, new Map([[7, 3199]]), 31.99)!);
    expect(out.foo).toBe(1);
    expect(out.printifyVariants[0].price).toBe(31.99);
  });
  test("ne baisse jamais un prix plus élevé", () => {
    const raw = JSON.stringify([{ vid: 1, label: "a", price: 60 }]);
    expect(JSON.parse(repriceVariantsJson(raw, new Map([[1, 3599]]), 35.99)!)[0].price).toBe(60);
  });
  test("JSON invalide ou vide → inchangé", () => {
    expect(repriceVariantsJson("nope", null, 10)).toBe("nope");
    expect(repriceVariantsJson(null, null, 10)).toBeNull();
  });
});

describe("pricingFromProductData (réponse createProduct Printify)", () => {
  test("lit le coût réel des variantes retenues", () => {
    const data = { variants: [
      { id: 149563, cost: 1974, price: 2500 },
      { id: 149564, cost: 1974, price: 2500 },
      { id: 999, cost: 9000, price: 2500 }, // variante non retenue : ignorée
    ] };
    const r = pricingFromProductData(data, [149563, 149564], 2500)!;
    expect(r.costPrice).toBe(19.74);
    expect(r.retailPrice).toBe(35.99);
    expect(r.priceCents.has(999)).toBe(false);
  });
  test("sans coût → null", () => {
    expect(pricingFromProductData({ variants: [{ id: 1, price: 2500 }] }, [1], 2500)).toBeNull();
  });
});
