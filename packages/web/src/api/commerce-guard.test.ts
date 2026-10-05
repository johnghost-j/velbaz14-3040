import { describe, expect, it } from 'bun:test';
import {
  MIN_MARGIN_ABS,
  clientPriceMatches,
  coversCost,
  costFromPrintifyProduct,
  minRetailFor,
  resolveItemsAgainstCatalog,
  type GuardProduct,
} from './commerce-guard';

function product(p: Partial<GuardProduct> = {}): GuardProduct {
  return {
    id: 'p1',
    name: 'T-shirt Velbaz',
    status: 'active',
    retailPrice: 29.99,
    costPrice: 11.5,
    printifyProductId: null,
    variants: [],
    ...p,
  };
}

describe('minRetailFor', () => {
  it('renvoie 0 pour un coût inconnu ou absurde', () => {
    expect(minRetailFor(0)).toBe(0);
    expect(minRetailFor(-5)).toBe(0);
    expect(minRetailFor(Number.NaN)).toBe(0);
  });

  it('reste strictement au-dessus du coût, même pour un coût minuscule', () => {
    for (const cost of [0.01, 0.5, 1, 1.99, 2, 4.99, 11.5, 100, 999.5]) {
      const min = minRetailFor(cost);
      expect(min).toBeGreaterThan(cost);
      expect(min).toBeGreaterThanOrEqual(cost + MIN_MARGIN_ABS - 1);
    }
  });

  it('applique la marge de 40 % sur les prix élevés', () => {
    expect(minRetailFor(100)).toBe(140.99);
  });

  it('applique la marge absolue sur les petits prix', () => {
    expect(minRetailFor(1)).toBe(3.99);
  });

  it('termine toujours en .99', () => {
    for (const cost of [0.01, 3, 7.4, 62.3]) {
      expect(Math.round((minRetailFor(cost) % 1) * 100)).toBe(99);
    }
  });
});

describe('coversCost', () => {
  it('considère un coût inconnu comme non comparable', () => {
    expect(coversCost(10, null)).toBe(true);
    expect(coversCost(10, 0)).toBe(true);
    expect(coversCost(null, null)).toBe(true);
  });

  it('refuse un prix absent face à un coût connu', () => {
    expect(coversCost(null, 5)).toBe(false);
  });

  it('exige une marge strictement positive', () => {
    expect(coversCost(5, 5)).toBe(false);
    expect(coversCost(5.01, 5)).toBe(true);
    expect(coversCost(4.99, 5)).toBe(false);
  });
});

describe('resolveItemsAgainstCatalog — règle 1 (pas de produit, pas de paiement)', () => {
  it('refuse un panier vide', () => {
    const r = resolveItemsAgainstCatalog([product()], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_items');
  });

  it('accepte une ligne adossée à un vrai produit et impose le prix du catalogue', () => {
    const r = resolveItemsAgainstCatalog(
      [product()],
      [{ productId: 'p1', quantity: 2, name: 'Hacké', amount: 2999 }],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(1);
      expect(r.items[0].unitAmountCents).toBe(2999);
      expect(r.items[0].name).toBe('T-shirt Velbaz');
      expect(r.totalCents).toBe(5998);
    }
  });

  it('refuse un produit inexistant', () => {
    const r = resolveItemsAgainstCatalog([product()], [{ productId: 'fantome', quantity: 1 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('product_not_found');
      expect(r.rejected[0].index).toBe(0);
    }
  });

  it('refuse une ligne sans référence produit en mode paiement', () => {
    const r = resolveItemsAgainstCatalog([product()], [{ name: 'Produit inventé', amount: 4900 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_product_reference');
  });

  it('refuse un produit encore à l’état de concept', () => {
    const r = resolveItemsAgainstCatalog([product({ status: 'concept' })], [{ productId: 'p1' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('product_not_published');
  });

  it('refuse un produit sans prix de vente', () => {
    const r = resolveItemsAgainstCatalog([product({ retailPrice: null })], [{ productId: 'p1' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('product_without_price');
  });

  it('refuse une variante inconnue', () => {
    const p = product({ variants: [{ vid: 'v1', label: 'M', price: 34.99 }] });
    const r = resolveItemsAgainstCatalog([p], [{ productId: 'p1', vid: 'v-nope' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('variant_not_found');
  });

  it('facture le prix de la variante demandée', () => {
    const p = product({ variants: [{ vid: 'v1', label: 'M', price: 34.99 }] });
    const r = resolveItemsAgainstCatalog([p], [{ productId: 'p1', vid: 'v1' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0].unitAmountCents).toBe(3499);
      expect(r.items[0].name).toBe('T-shirt Velbaz — M');
    }
  });

  it('vraie personnalisation obligatoire : refuse un produit à plusieurs variantes sans vid choisi (jamais de fallback silencieux)', () => {
    const p = product({
      variants: [
        { vid: 'v1', label: 'Rouge / M', price: 34.99 },
        { vid: 'v2', label: 'Rouge / L', price: 34.99 },
      ],
    });
    const r = resolveItemsAgainstCatalog([p], [{ productId: 'p1', quantity: 1 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('variant_required');
  });

  it('auto-sélectionne l’unique variante réelle d’un produit sans ambiguïté et propage bien son vid', () => {
    const p = product({ variants: [{ vid: 'v1', label: 'Taille unique', price: 24.99 }] });
    const r = resolveItemsAgainstCatalog([p], [{ productId: 'p1', quantity: 1 }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0].vid).toBe('v1');
      expect(r.items[0].unitAmountCents).toBe(2499);
    }
  });

  it('bloque une ligne à perte (règle 2 en dernier rempart)', () => {
    const r = resolveItemsAgainstCatalog(
      [product({ retailPrice: 9, costPrice: 11.5 })],
      [{ productId: 'p1' }],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('price_below_supplier_cost');
      expect(r.rejected[0].minPriceCents).toBe(Math.round(minRetailFor(11.5) * 100));
    }
  });

  it('fait échouer tout le panier si une seule ligne est douteuse', () => {
    const r = resolveItemsAgainstCatalog(
      [product()],
      [{ productId: 'p1' }, { productId: 'fantome' }],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('cart_has_unknown_items');
      expect(r.rejected).toHaveLength(1);
    }
  });

  it('borne les quantités farfelues', () => {
    const r = resolveItemsAgainstCatalog([product()], [{ productId: 'p1', quantity: 100000 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].quantity).toBe(100);
  });

  it('remet une quantité invalide à 1', () => {
    const r = resolveItemsAgainstCatalog([product()], [{ productId: 'p1', quantity: -3 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].quantity).toBe(1);
  });

  it('autorise un abonnement sans productId', () => {
    const r = resolveItemsAgainstCatalog([], [{ name: 'Plan Pro', amount: 2900, interval: 'month' }], {
      mode: 'subscription',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0].productId).toBeNull();
      expect(r.items[0].unitAmountCents).toBe(2900);
      expect(r.items[0].interval).toBe('month');
    }
  });

  it('refuse un abonnement sans montant', () => {
    const r = resolveItemsAgainstCatalog([], [{ name: 'Plan Pro', amount: 0 }], { mode: 'subscription' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('plan_without_price');
  });
});

describe('costFromPrintifyProduct — coût de production réel', () => {
  it('prend le coût le plus élevé parmi les variantes actives', () => {
    const info = costFromPrintifyProduct({
      variants: [
        { id: 1, price: 2000, cost: 900, is_enabled: true },
        { id: 2, price: 2000, cost: 1250, is_enabled: true },
        { id: 3, price: 2000, cost: 4000, is_enabled: false },
      ],
    });
    expect(info.costPrice).toBe(12.5);
    expect(info.source).toBe('printify_api');
    expect(info.variants).toHaveLength(3);
  });

  it('retombe sur les variantes désactivées si aucune active n’a de coût', () => {
    const info = costFromPrintifyProduct({
      variants: [{ id: 1, price: 2000, cost: 1500, is_enabled: false }],
    });
    expect(info.costPrice).toBe(15);
  });

  it('n’invente aucun coût quand la réponse est vide ou inutilisable', () => {
    expect(costFromPrintifyProduct(null).costPrice).toBeNull();
    expect(costFromPrintifyProduct({ variants: [] }).costPrice).toBeNull();
    expect(costFromPrintifyProduct({ variants: [{ id: 1, price: 2000, cost: 0 }] }).costPrice).toBeNull();
    expect(costFromPrintifyProduct({ variants: 'nope' }).source).toBe('unknown');
  });

  it('un prix corrigé depuis le coût Printify est toujours rentable', () => {
    const info = costFromPrintifyProduct({ variants: [{ id: 1, price: 500, cost: 1250, is_enabled: true }] });
    const min = minRetailFor(info.costPrice as number);
    expect(min).toBeGreaterThan(info.costPrice as number);
    expect(coversCost(min, info.costPrice)).toBe(true);
    expect(coversCost(5, info.costPrice)).toBe(false); // prix Printify d'origine : à perte
  });
});

describe('resolveItemsAgainstCatalog — prix affiché = prix payé', () => {
  it('refuse le paiement si le site affichait un autre prix', () => {
    const r = resolveItemsAgainstCatalog([product()], [{ productId: 'p1', quantity: 1, amount: 2500 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('price_changed');
      expect(r.rejected[0].currentPriceCents).toBe(2999);
      expect(r.rejected[0].message).toContain('29,99 €');
      expect(r.rejected[0].message).toContain('25,00 €');
    }
  });

  it('refuse un prix bidouillé (1 centime) au lieu de le facturer', () => {
    const r = resolveItemsAgainstCatalog([product()], [{ productId: 'p1', amount: 1 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('price_changed');
  });

  it('compare au prix de la variante choisie', () => {
    const p = product({ variants: [{ vid: 'v1', label: 'M', price: 34.99 }] });
    expect(resolveItemsAgainstCatalog([p], [{ productId: 'p1', vid: 'v1', amount: 3499 }]).ok).toBe(true);
    const bad = resolveItemsAgainstCatalog([p], [{ productId: 'p1', vid: 'v1', amount: 2999 }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.rejected[0].currentPriceCents).toBe(3499);
  });

  it('accepte un panier sans montant (le serveur fixe le prix)', () => {
    expect(resolveItemsAgainstCatalog([product()], [{ productId: 'p1' }]).ok).toBe(true);
  });
});

describe('clientPriceMatches', () => {
  it('tolère montant absent, ±1 centime, euros et total de ligne', () => {
    expect(clientPriceMatches(undefined, 2999)).toBe(true);
    expect(clientPriceMatches(null, 2999)).toBe(true);
    expect(clientPriceMatches(2999, 2999)).toBe(true);
    expect(clientPriceMatches(3000, 2999)).toBe(true);
    expect(clientPriceMatches(29.99, 2999)).toBe(true);
    expect(clientPriceMatches(5998, 2999, 2)).toBe(true);
  });
  it('détecte un prix différent', () => {
    expect(clientPriceMatches(2500, 2999)).toBe(false);
    expect(clientPriceMatches(25, 2999)).toBe(false);
    expect(clientPriceMatches(5998, 2999, 1)).toBe(false);
  });
});
