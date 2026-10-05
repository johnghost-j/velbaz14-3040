// ─── Grand livre des revenus (source de vérité) ──────────────────────────────
// PROBLÈME RÉSOLU : `companies.mrr` / `arr` / `totalRevenue` n'étaient JAMAIS
// écrits — seulement lus. Résultat : un paiement Stripe réel n'apparaissait
// nulle part en agrégat, et `evaluatePortfolio()` (money-maker) tuait TOUTES
// les entreprises puisque leur MRR restait bloqué à 0 à vie.
//
// Ce module est le SEUL endroit qui écrit les revenus agrégés d'une entreprise.
// Règle : `revenueEvents` est la source de vérité ; les colonnes de `companies`
// ne sont qu'un cache recalculé (jamais incrémenté en place → pas de dérive).
//
// SÉMANTIQUE ASSUMÉE (décision explicite, pas une supposition) :
//   • totalRevenue = somme de TOUS les revenus bruts encaissés, depuis toujours.
//   • mrr          = revenu brut encaissé sur les 30 derniers jours glissants
//                    ("monthly revenue run-rate"). Pour un abonnement, les
//                    paiements récurrents tombent chaque mois → c'est bien le
//                    MRR. Pour du one-shot (e-commerce, dropshipping), c'est le
//                    revenu réellement réalisé sur le mois — ce qui est la
//                    bonne base de décision keep/improve/kill.
//   • arr          = mrr × 12.
//
// ANTI-DOUBLE-COMPTAGE : le revenu brut est enregistré UNE SEULE FOIS, au
// moment du paiement (`order_payment`). Les événements de type informatif
// (marge dropshipping, coût fournisseur) sont exclus de l'agrégat via
// NON_REVENUE_TYPES — ils servent à l'audit, pas au chiffre d'affaires.

import { db } from "../database/index";
import * as schema from "../database/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { computeTotals, isGrossRevenue, MRR_WINDOW_DAYS, NON_REVENUE_TYPES } from "./compute";

export { MRR_WINDOW_DAYS, NON_REVENUE_TYPES };

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecordRevenueInput {
  companyId: string;
  /** ex. 'order_payment' | 'subscription_payment' | 'refund' | 'manual' */
  type: string;
  /** Montant brut encaissé, dans la devise indiquée. Négatif pour un remboursement. */
  amount: number;
  currency?: string | null;
  source?: string | null;
  customerEmail?: string | null;
  description?: string | null;
  /** 1 = paiement récurrent (abonnement), 0 = one-shot. */
  recurring?: boolean;
  /**
   * Clé de déduplication stable (ex. l'id de commande). Deux appels avec la même
   * clé n'écrivent qu'une seule ligne — indispensable car le webhook Stripe ET
   * la page de succès appellent le même chemin.
   */
  dedupeKey?: string;
}

export interface CompanyRevenueTotals {
  totalRevenue: number;
  mrr: number;
  arr: number;
  events: number;
}

function sumWhere(rows: Array<{ amount: number | null }>): number {
  let t = 0;
  for (const r of rows) t += Number(r.amount || 0);
  return Number(t.toFixed(2));
}

/**
 * Recalcule totalRevenue / mrr / arr depuis `revenueEvents` et les persiste sur
 * `companies`. Recalcul complet (et non incrément) → idempotent et sans dérive.
 * Ne lève jamais : un échec de cache ne doit pas casser un encaissement.
 */
export async function recomputeCompanyRevenue(companyId: string): Promise<CompanyRevenueTotals> {
  const zero: CompanyRevenueTotals = { totalRevenue: 0, mrr: 0, arr: 0, events: 0 };
  try {
    const all = await db
      .select({ amount: schema.revenueEvents.amount, type: schema.revenueEvents.type, createdAt: schema.revenueEvents.createdAt })
      .from(schema.revenueEvents)
      .where(eq(schema.revenueEvents.companyId, companyId))
      .all();

    const { totalRevenue, mrr, arr, events } = computeTotals(all as any);

    await db
      .update(schema.companies)
      .set({ totalRevenue, mrr, arr, updatedAt: new Date() })
      .where(eq(schema.companies.id, companyId));

    return { totalRevenue, mrr, arr, events };
  } catch (e: any) {
    console.error(`[revenue] recompute ${companyId}:`, e?.message || e);
    return zero;
  }
}

/**
 * Enregistre un revenu réel puis rafraîchit les agrégats de l'entreprise.
 * Idempotent quand `dedupeKey` est fourni. Ne lève jamais.
 */
export async function recordRevenue(
  input: RecordRevenueInput,
): Promise<{ recorded: boolean; eventId: string | null; totals: CompanyRevenueTotals | null }> {
  const amount = Number(input.amount);
  if (!input.companyId || !Number.isFinite(amount) || amount === 0) {
    return { recorded: false, eventId: null, totals: null };
  }
  const eventId = input.dedupeKey ? `rev_${input.dedupeKey}`.slice(0, 120) : uuidv4();
  try {
    if (input.dedupeKey) {
      const existing = await db
        .select({ id: schema.revenueEvents.id })
        .from(schema.revenueEvents)
        .where(eq(schema.revenueEvents.id, eventId))
        .get();
      if (existing) return { recorded: false, eventId, totals: null };
    }
    await db.insert(schema.revenueEvents).values({
      id: eventId,
      companyId: input.companyId,
      type: input.type,
      amount: Number(amount.toFixed(2)),
      currency: (input.currency || "EUR").toUpperCase(),
      source: input.source ?? null,
      customerEmail: input.customerEmail ?? null,
      description: input.description ?? null,
      recurring: input.recurring ? 1 : 0,
    });
    const totals = await recomputeCompanyRevenue(input.companyId);
    return { recorded: true, eventId, totals };
  } catch (e: any) {
    // Course entre le webhook et la page de succès → clé déjà prise : pas une erreur.
    const msg = String(e?.message || e);
    if (/UNIQUE|constraint/i.test(msg)) return { recorded: false, eventId, totals: null };
    console.error(`[revenue] record ${input.companyId}:`, msg);
    return { recorded: false, eventId: null, totals: null };
  }
}

// ─── P&L par entreprise (revenu réel − coût IA réel) ─────────────────────────
// Une entreprise peut encaisser 40 € et avoir brûlé 90 € d'IA : au chiffre
// d'affaires brut elle ressemble à une gagnante, en réalité elle perd de
// l'argent. C'est cette vue-là que le Stratège doit voir.

export interface CompanyPnl {
  windowDays: number;
  revenue: number;      // revenu brut sur la fenêtre
  supplierCost: number; // payé aux fournisseurs (dropshipping / POD) sur la fenêtre
  aiCostUsd: number;    // coût des appels IA attribués à cette entreprise
  adsSpent: number;     // dépense publicitaire enregistrée (cumulée)
  profit: number;       // revenue − supplierCost − aiCostUsd − adsSpent
  margin: number;       // profit / revenue (0 si pas de revenu)
  totalRevenue: number; // cumul depuis la création
  mrr: number;
}

export async function getCompanyPnl(companyId: string, windowDays = 30): Promise<CompanyPnl> {
  const since = new Date(Date.now() - windowDays * DAY_MS);

  const events = await db
    .select({ amount: schema.revenueEvents.amount, type: schema.revenueEvents.type })
    .from(schema.revenueEvents)
    .where(and(eq(schema.revenueEvents.companyId, companyId), gte(schema.revenueEvents.createdAt, since)))
    .all()
    .catch(() => [] as Array<{ amount: number | null; type: string }>);
  const revenue = sumWhere(events.filter((e) => isGrossRevenue(e.type)));

  // Coût fournisseur réel (CJ / Printify) : sans lui, une boutique qui vend
  // 100 € de produits achetés 85 € passerait pour rentable.
  const sup = await db
    .select({ total: sql<number>`coalesce(sum(${schema.orders.supplierCost}), 0)` })
    .from(schema.orders)
    .where(and(eq(schema.orders.companyId, companyId), gte(schema.orders.createdAt, since)))
    .get()
    .catch(() => ({ total: 0 }));
  const supplierCost = Number(Number(sup?.total || 0).toFixed(2));

  const cost = await db
    .select({ total: sql<number>`coalesce(sum(${schema.aiUsageEvents.costUsd}), 0)` })
    .from(schema.aiUsageEvents)
    .where(and(eq(schema.aiUsageEvents.companyId, companyId), gte(schema.aiUsageEvents.startedAt, since)))
    .get()
    .catch(() => ({ total: 0 }));
  const aiCostUsd = Number(Number(cost?.total || 0).toFixed(4));

  const co = await db
    .select({ adsSpent: schema.companies.adsSpent, totalRevenue: schema.companies.totalRevenue, mrr: schema.companies.mrr })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .get()
    .catch(() => null);

  const adsSpent = Number(co?.adsSpent || 0);
  const profit = Number((revenue - supplierCost - aiCostUsd - adsSpent).toFixed(2));
  return {
    windowDays,
    revenue,
    supplierCost,
    aiCostUsd,
    adsSpent,
    profit,
    margin: revenue > 0 ? Number((profit / revenue).toFixed(3)) : 0,
    totalRevenue: Number(co?.totalRevenue || 0),
    mrr: Number(co?.mrr || 0),
  };
}
