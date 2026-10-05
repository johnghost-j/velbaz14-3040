import { describe, expect, it } from "bun:test";
import { computeTotals, isGrossRevenue } from "./compute";

const NOW = new Date("2026-09-17T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

describe("computeTotals", () => {
  it("sans événement → tout à zéro", () => {
    expect(computeTotals([], NOW)).toEqual({ totalRevenue: 0, mrr: 0, arr: 0, events: 0 });
  });

  it("un paiement récent compte dans totalRevenue ET dans le MRR", () => {
    const t = computeTotals([{ amount: 49.9, type: "order_payment", createdAt: new Date(NOW - 2 * DAY) }], NOW);
    expect(t.totalRevenue).toBe(49.9);
    expect(t.mrr).toBe(49.9);
    expect(t.arr).toBe(598.8);
    expect(t.events).toBe(1);
  });

  it("un paiement ancien reste dans totalRevenue mais sort du MRR", () => {
    const t = computeTotals([{ amount: 120, type: "order_payment", createdAt: new Date(NOW - 90 * DAY) }], NOW);
    expect(t.totalRevenue).toBe(120);
    expect(t.mrr).toBe(0);
    expect(t.arr).toBe(0);
  });

  it("la marge dropshipping est exclue — pas de double comptage du brut", () => {
    const t = computeTotals(
      [
        { amount: 100, type: "order_payment", createdAt: new Date(NOW - DAY) },
        { amount: 38, type: "dropship_margin", createdAt: new Date(NOW - DAY) },
      ],
      NOW,
    );
    expect(t.totalRevenue).toBe(100);
    expect(t.mrr).toBe(100);
    expect(t.events).toBe(1);
  });

  it("un remboursement est soustrait", () => {
    const t = computeTotals(
      [
        { amount: 200, type: "order_payment", createdAt: new Date(NOW - 3 * DAY) },
        { amount: -50, type: "refund", createdAt: new Date(NOW - DAY) },
      ],
      NOW,
    );
    expect(t.totalRevenue).toBe(150);
    expect(t.mrr).toBe(150);
  });

  it("le MRR ne descend jamais sous zéro", () => {
    const t = computeTotals(
      [
        { amount: 80, type: "order_payment", createdAt: new Date(NOW - 200 * DAY) },
        { amount: -80, type: "refund", createdAt: new Date(NOW - DAY) },
      ],
      NOW,
    );
    expect(t.totalRevenue).toBe(0);
    expect(t.mrr).toBe(0);
  });

  it("accepte les timestamps unixepoch en secondes et en millisecondes", () => {
    const t = computeTotals(
      [
        { amount: 10, type: "order_payment", createdAt: Math.floor((NOW - DAY) / 1000) },
        { amount: 10, type: "order_payment", createdAt: NOW - DAY },
      ],
      NOW,
    );
    expect(t.mrr).toBe(20);
  });

  it("ignore un montant non numérique sans casser le total", () => {
    const t = computeTotals(
      [
        { amount: 25, type: "order_payment", createdAt: new Date(NOW) },
        { amount: null, type: "order_payment", createdAt: new Date(NOW) },
      ],
      NOW,
    );
    expect(t.totalRevenue).toBe(25);
  });

  it("isGrossRevenue classe les types informatifs", () => {
    expect(isGrossRevenue("order_payment")).toBe(true);
    expect(isGrossRevenue("subscription_payment")).toBe(true);
    expect(isGrossRevenue("dropship_margin")).toBe(false);
    expect(isGrossRevenue("supplier_cost")).toBe(false);
  });
});
