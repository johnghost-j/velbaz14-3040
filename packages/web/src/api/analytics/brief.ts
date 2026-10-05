/**
 * Agrégats de mesure : types, résumé pour les prompts, diagnostic de fuite.
 *
 * Aucun accès base de données ici — c'est volontaire : ces fonctions sont ce
 * que lisent les agents pour décider, elles doivent donc être testables et
 * déterministes. `store.ts` s'occupe des lectures SQL et les ré-exporte.
 */

export type ChannelRow = { channel: string; visits: number; sessions: number; purchases: number; revenue: number };
export type PathRow = { path: string; views: number };
export type DayRow = { day: string; visits: number; sessions: number };

export type SiteAnalytics = {
  windowDays: number;
  /** Total pageviews sur la fenêtre. */
  pageviews: number;
  /** Sessions distinctes (visiteurs approximés). */
  visitors: number;
  funnel: { pageview: number; lead: number; checkout_start: number; purchase: number };
  /** purchase / visiteurs, 0 si aucun visiteur. */
  conversionRate: number;
  /** leads / visiteurs. */
  leadRate: number;
  revenue: number;
  channels: ChannelRow[];
  topPaths: PathRow[];
  daily: DayRow[];
  devices: { device: string; sessions: number }[];
};


/**
 * Résumé compact destiné aux prompts des agents (Strategist, Analytics).
 * Texte court et factuel : l'agent doit pouvoir décider avec, sans re-agréger.
 */
export function analyticsBrief(a: SiteAnalytics): string {
  if (a.pageviews === 0 && a.funnel.purchase === 0 && a.funnel.lead === 0) {
    return `Trafic réel sur ${a.windowDays} j : AUCUNE visite mesurée. `
      + `Le site ne reçoit personne — le problème n°1 est l'acquisition, pas le produit ni le pricing.`;
  }
  const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
  const chan = a.channels.length
    ? a.channels.slice(0, 5).map((c) => `${c.channel} ${c.visits} vues/${c.sessions} sessions${c.purchases ? ` → ${c.purchases} ventes` : ''}`).join(' · ')
    : 'aucun canal identifié';
  const paths = a.topPaths.length ? a.topPaths.slice(0, 5).map((p) => `${p.path} (${p.views})`).join(' · ') : '—';
  const devices = a.devices.length ? a.devices.map((d) => `${d.device} ${d.sessions}`).join(' · ') : '—';
  return [
    `Trafic réel sur ${a.windowDays} j : ${a.pageviews} pages vues, ${a.visitors} visiteurs uniques.`,
    `Tunnel : ${a.funnel.pageview} vues → ${a.funnel.lead} leads (${pct(a.leadRate)}) → ${a.funnel.checkout_start} checkouts ouverts → ${a.funnel.purchase} achats (${pct(a.conversionRate)}), ${a.revenue.toFixed(2)} € encaissés.`,
    `Canaux : ${chan}.`,
    `Pages les plus vues : ${paths}.`,
    `Appareils : ${devices}.`,
  ].join('\n');
}

/** Où le tunnel fuit le plus, en clair. Null si pas assez de données. */
export function biggestLeak(a: SiteAnalytics): { step: string; advice: string } | null {
  if (a.visitors === 0) {
    return { step: 'acquisition', advice: 'Zéro visiteur : tout effort sur le site est inutile avant d’avoir un canal de trafic qui fonctionne.' };
  }
  if (a.funnel.lead === 0 && a.funnel.purchase === 0) {
    return { step: 'activation', advice: `${a.visitors} visiteurs, 0 lead et 0 achat : la page ne convertit pas du tout. Revoir la proposition de valeur au-dessus de la ligne de flottaison et l’appel à l’action.` };
  }
  if (a.funnel.checkout_start > 0 && a.funnel.purchase === 0) {
    return { step: 'paiement', advice: `${a.funnel.checkout_start} checkouts ouverts et 0 paiement : friction ou blocage au paiement. Vérifier Stripe, les frais de port et les moyens de paiement.` };
  }
  if (a.visitors >= 30 && a.conversionRate < 0.005) {
    return { step: 'conversion', advice: `Taux de conversion ${(a.conversionRate * 100).toFixed(2)} % sous le plancher du e-commerce (~1 %). Tester prix, preuve sociale et clarté de l’offre avant d’acheter plus de trafic.` };
  }
  return null;
}
