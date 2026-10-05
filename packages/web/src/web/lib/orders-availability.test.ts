import { describe, it, expect } from 'bun:test';
import {
  parseOrdersAvailability,
  ordersTabVisible,
  ordersTabReason,
  type OrdersAvailability,
} from './orders-availability';

const A = (o: Partial<OrdersAvailability> = {}): OrdersAvailability => ({
  orders: 0, sellable: 0, stripe: false, ...o,
});

describe('parseOrdersAvailability', () => {
  it('lit la réponse normale de /orders/availability', () => {
    expect(parseOrdersAvailability({
      available: true, orders: 3, sellable: 7, stripe: true, reason: 'has_orders', synced: 0,
    })).toEqual({ orders: 3, sellable: 7, stripe: true });
  });

  it('accepte un projet vitrine (tout à zéro) sans le confondre avec une erreur', () => {
    expect(parseOrdersAvailability({ available: false, orders: 0, sellable: 0, stripe: false }))
      .toEqual({ orders: 0, sellable: 0, stripe: false });
  });

  it('complète un champ manquant plutôt que de tout jeter', () => {
    expect(parseOrdersAvailability({ orders: 2 })).toEqual({ orders: 2, sellable: 0, stripe: false });
    expect(parseOrdersAvailability({ sellable: 5 })).toEqual({ orders: 0, sellable: 5, stripe: false });
  });

  it('normalise les nombres douteux (chaînes, négatifs, décimaux, NaN)', () => {
    expect(parseOrdersAvailability({ orders: '4', sellable: -2 }))
      .toEqual({ orders: 4, sellable: 0, stripe: false });
    expect(parseOrdersAvailability({ orders: 2.7, sellable: 'abc' }))
      .toEqual({ orders: 2, sellable: 0, stripe: false });
  });

  it('rend null sur une réponse inexploitable → l’appelant garde son dernier état', () => {
    expect(parseOrdersAvailability(null)).toBeNull();
    expect(parseOrdersAvailability(undefined)).toBeNull();
    expect(parseOrdersAvailability('boom')).toBeNull();
    expect(parseOrdersAvailability(42)).toBeNull();
    expect(parseOrdersAvailability({})).toBeNull();
    expect(parseOrdersAvailability({ error: 'Not found' })).toBeNull();
  });
});

describe('ordersTabVisible', () => {
  // La demande : pas de partie Commandes si le site ne propose rien à commander.
  it('masque l’onglet sur un site vitrine', () => {
    expect(ordersTabVisible(A())).toBe(false);
    expect(ordersTabVisible(A({ stripe: true }))).toBe(false);
  });

  it('affiche l’onglet dès qu’un produit est réellement vendable', () => {
    expect(ordersTabVisible(A({ sellable: 1 }))).toBe(true);
  });

  // « ça peut apparaître à n'importe quel moment du projet » : une commande
  // encaissée suffit, même si le catalogue a été vidé depuis.
  it('affiche l’onglet dès qu’une commande existe, catalogue vide ou non', () => {
    expect(ordersTabVisible(A({ orders: 1 }))).toBe(true);
    expect(ordersTabVisible(A({ orders: 1, sellable: 0, stripe: false }))).toBe(true);
  });

  it('reste masqué tant que l’état est inconnu', () => {
    expect(ordersTabVisible(null)).toBe(false);
    expect(ordersTabVisible(undefined)).toBe(false);
  });

  it('ne retire jamais l’onglet sous les doigts de l’utilisateur (section ouverte)', () => {
    expect(ordersTabVisible(A(), { sectionOpen: true })).toBe(true);
    expect(ordersTabVisible(null, { sectionOpen: true })).toBe(true);
  });

  it('les clés Stripe ne sont ni nécessaires ni suffisantes', () => {
    expect(ordersTabVisible(A({ stripe: true, sellable: 0, orders: 0 }))).toBe(false);
    expect(ordersTabVisible(A({ stripe: false, sellable: 3 }))).toBe(true);
  });
});

describe('ordersTabReason', () => {
  it('explique la décision pour le journal', () => {
    expect(ordersTabReason(A({ orders: 2, sellable: 5 }))).toBe('2 commande(s)');
    expect(ordersTabReason(A({ sellable: 5 }))).toBe('5 produit(s) vendable(s)');
    expect(ordersTabReason(A())).toBe('rien de commandable');
    expect(ordersTabReason(null)).toBe('inconnu');
  });
});
