/**
 * Visibilité de la section « Commandes » du dashboard projet.
 *
 * [2026-09-25] Demande utilisateur : la partie Commandes ne doit PAS être
 * disponible quand le site généré ne propose rien de commandable/achetable —
 * et elle doit pouvoir apparaître À N'IMPORTE QUEL MOMENT du projet (dès que
 * le site devient vendable, ou dès qu'une vraie commande tombe).
 *
 * C'est donc une décision RECALCULÉE en continu (sondage de
 * GET /companies/:id/orders/availability), jamais figée à la génération : un
 * projet qui devient une boutique en cours de route voit l'onglet apparaître
 * tout seul, et un projet vitrine ne l'a jamais.
 *
 * Règle (volontairement simple et vérifiable) :
 *   visible = une commande existe déjà  OU  le catalogue réel a au moins un
 *             produit vendable (c'est exactement ce qui rend un paiement
 *             possible : le garde-fou /checkout/validate refuse tout article
 *             absent du catalogue, donc « pas de catalogue » = « rien
 *             d'achetable »).
 *
 * Les clés Stripe N'ENTRENT PAS dans la règle : un catalogue réel signifie que
 * le site propose quelque chose à commander (il ne manque qu'un branchement de
 * clés), et une commande déjà encaissée doit rester consultable même si les
 * clés ont été retirées depuis.
 */

export interface OrdersAvailability {
  /** Commandes déjà enregistrées côté Velbaz (table orders). */
  orders: number;
  /** Produits RÉELLEMENT vendables au catalogue (prix réel couvrant le coût). */
  sellable: number;
  /** Clés Stripe de l'entreprise branchées (info seulement, pas un critère). */
  stripe: boolean;
}

/**
 * Normalise la réponse de l'API. Rend `null` quand la réponse est inexploitable
 * (erreur réseau, route absente, payload vide) → l'appelant reste sur
 * « inconnu » et n'affiche pas l'onglet par défaut.
 */
export function parseOrdersAvailability(raw: any): OrdersAvailability | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = (v: any) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
  };
  const hasOrders = raw.orders !== undefined && raw.orders !== null;
  const hasSellable = raw.sellable !== undefined && raw.sellable !== null;
  if (!hasOrders && !hasSellable) return null;
  return { orders: n(raw.orders), sellable: n(raw.sellable), stripe: !!raw.stripe };
}

/**
 * L'onglet « Commandes » doit-il être affiché ?
 *
 * @param a            dernier état connu (null = pas encore connu → masqué)
 * @param opts.sectionOpen  la section est OUVERTE en ce moment : on ne retire
 *                          jamais un onglet sous les doigts de l'utilisateur.
 */
export function ordersTabVisible(
  a: OrdersAvailability | null | undefined,
  opts: { sectionOpen?: boolean } = {},
): boolean {
  if (opts.sectionOpen) return true;
  if (!a) return false;
  return a.orders > 0 || a.sellable > 0;
}

/** Raison lisible (journal/debug, jamais affichée telle quelle à l'utilisateur). */
export function ordersTabReason(a: OrdersAvailability | null | undefined): string {
  if (!a) return 'inconnu';
  if (a.orders > 0) return `${a.orders} commande(s)`;
  if (a.sellable > 0) return `${a.sellable} produit(s) vendable(s)`;
  return 'rien de commandable';
}
