/**
 * Verdict de portefeuille : keep / improve / kill.
 *
 * Logique pure (aucun accès DB) pour qu'elle soit testable et qu'on puisse la
 * raisonner sans lancer le boss. `evaluatePortfolio()` (money-maker.ts) ne fait
 * que lire la DB, appeler cette fonction, puis écrire les logs / le statut.
 *
 * Règle de fond : on décide sur le P&L RÉEL, pas sur le chiffre d'affaires.
 * Une boutique qui encaisse 100 € en brûlant 180 € de coûts n'est pas une
 * gagnante, c'est une fuite à corriger.
 */

export type PortfolioPnl = {
  /** Revenu brut encaissé sur la fenêtre (€). */
  revenue: number;
  /** Coût fournisseur sur la fenêtre (€). */
  supplierCost: number;
  /** Coût IA sur la fenêtre ($, traité ≈ € ici). */
  aiCostUsd: number;
  /** Dépense pub cumulée (€). */
  adsSpent: number;
  /** revenue − supplierCost − aiCostUsd − adsSpent. */
  profit: number;
  /** profit / revenue, 0 si pas de revenu. */
  margin: number;
};

export type VerdictInput = {
  /** MRR agrégé sur la fiche société (€). */
  mrr: number;
  /** Revenu cumulé depuis toujours sur la fiche société (€). */
  totalRevenue: number;
  /** Âge de la société en millisecondes. */
  ageMs: number;
  /** Seuil de kill en millisecondes (killAfterDays × 24 h). */
  killMs: number;
  /** P&L de la fenêtre courante, ou null si indisponible (erreur DB). */
  pnl: PortfolioPnl | null;
};

export type Verdict =
  /** Rentable : on double la mise sur la croissance. */
  | { action: 'keep'; reason: 'profitable' }
  /** Des ventes réelles mais une perte nette : corriger avant de scaler. */
  | { action: 'improve'; reason: 'unprofitable' }
  /** Pas encore de revenu, mi-parcours : pivot offre/pricing/canal. */
  | { action: 'improve'; reason: 'no_revenue_midway' }
  /** Pas de revenu après le seuil : kill (soft, réversible). */
  | { action: 'kill'; reason: 'no_revenue_timeout' }
  /** Trop tôt pour juger : on laisse tourner. */
  | { action: 'wait'; reason: 'too_early' };

export function portfolioVerdict(input: VerdictInput): Verdict {
  const { mrr, totalRevenue, ageMs, killMs, pnl } = input;
  const hasRevenue = mrr > 0 || totalRevenue > 0;

  if (hasRevenue) {
    // Le P&L ne tranche que s'il a vu du revenu sur la fenêtre. Sans revenu
    // récent (vente ancienne), un profit négatif ne veut rien dire : les coûts
    // IA courants ne sont pas imputables à une vente d'il y a trois mois.
    if (pnl && pnl.revenue > 0 && pnl.profit < 0) {
      return { action: 'improve', reason: 'unprofitable' };
    }
    return { action: 'keep', reason: 'profitable' };
  }

  if (ageMs >= killMs) return { action: 'kill', reason: 'no_revenue_timeout' };
  if (ageMs >= killMs / 2) return { action: 'improve', reason: 'no_revenue_midway' };
  return { action: 'wait', reason: 'too_early' };
}
