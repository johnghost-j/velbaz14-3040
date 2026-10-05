// ─── Calcul pur des agrégats de revenu (testable sans base de données) ───────
// Isolé du ledger pour être couvert par des tests unitaires déterministes.

/** Types d'événements EXCLUS du chiffre d'affaires (informatifs / dérivés). */
export const NON_REVENUE_TYPES = ["dropship_margin", "supplier_cost", "cost"] as const;

export const MRR_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RevenueRow {
  amount: number | null;
  type: string | null;
  createdAt?: Date | number | string | null;
}

export interface RevenueTotals {
  totalRevenue: number;
  mrr: number;
  arr: number;
  events: number;
}

function ts(v: RevenueRow["createdAt"]): number {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // unixepoch (s) ou ms
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function isGrossRevenue(type: string | null | undefined): boolean {
  return !(NON_REVENUE_TYPES as readonly string[]).includes(String(type ?? ""));
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * totalRevenue = somme brute depuis toujours.
 * mrr          = somme brute sur les 30 derniers jours glissants (run-rate).
 * arr          = mrr × 12.
 * Les remboursements (montant négatif) sont soustraits ; le MRR ne descend
 * jamais sous 0.
 */
export function computeTotals(rows: RevenueRow[], now: number = Date.now()): RevenueTotals {
  const gross = rows.filter((r) => isGrossRevenue(r.type));
  const since = now - MRR_WINDOW_DAYS * DAY_MS;
  let total = 0;
  let recent = 0;
  for (const r of gross) {
    const amt = Number(r.amount || 0);
    if (!Number.isFinite(amt)) continue;
    total += amt;
    if (ts(r.createdAt) >= since) recent += amt;
  }
  const mrr = Math.max(0, round2(recent));
  return { totalRevenue: round2(total), mrr, arr: round2(mrr * 12), events: gross.length };
}
