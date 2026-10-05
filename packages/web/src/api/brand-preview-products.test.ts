import { describe, it, expect } from 'bun:test';
import { parseProductSelection, productSelectionPrompt, productRetryPrompt, describeDropped } from './brand-preview-products';

describe('parseProductSelection', () => {
  it('garde « pants » (type désormais fabricable) — cas Denimora', () => {
    const raw = '```json\n{"businessType":"clothing","products":[{"name":"Denim Line","productType":"pants","design":"minimal logo"},{"name":"Chino","productType":"trousers","design":"stripe"}]}\n```';
    const sel = parseProductSelection(raw, 'pants');
    expect(sel.businessType).toBe('clothing');
    expect(sel.products.map((p) => p.productType)).toEqual(['pants', 'pants']);
    expect(sel.dropped).toEqual([]);
  });
  it('trace chaque produit écarté au lieu de le perdre en silence', () => {
    const raw = JSON.stringify({ businessType: 'physical_product', products: [
      { name: 'Runner', productType: 'shoe', design: 'x' },
      { name: 'Sofa', productType: 'sofa', design: 'x' },
      { name: 'Cargo', productType: 'pants', design: '' },
    ] });
    const sel = parseProductSelection(raw, 'pants');
    expect(sel.products).toEqual([]);
    expect(sel.dropped.map((d) => d.reason)).toEqual(['wrong_type', 'unknown_type', 'no_design']);
    expect(describeDropped(sel.dropped)).toContain('Sofa');
  });
  it('sans type imposé, accepte tout type du catalogue, max 2', () => {
    const raw = JSON.stringify({ products: [
      { name: 'A', productType: 'dress', design: 'a' },
      { name: 'B', productType: 'socks', design: 'b' },
      { name: 'C', productType: 'mug', design: 'c' },
    ] });
    expect(parseProductSelection(raw, null).products.map((p) => p.productType)).toEqual(['dress', 'socks']);
  });
  it('réponse illisible → aucun produit, aucune exception', () => {
    expect(parseProductSelection('désolé', null)).toEqual({ businessType: null, products: [], dropped: [] });
  });
});

describe('prompts de sélection', () => {
  const input = { name: 'Denimora', idea: 'cret une mark de pentalon', industry: 'Fashion', description: 'Marque de pantalons.' };
  it('listent le catalogue réel et la description corrigée', () => {
    const p = productSelectionPrompt(input);
    for (const t of ['"pants"', '"joggers"', '"dress"', '"shoe"', '"mug"']) expect(p).toContain(t);
    expect(p).toContain('Marque de pantalons.');
  });
  it('le 2ᵉ essai impose le type connu et rappelle la réponse rejetée', () => {
    const p = productRetryPrompt(input, 'pants', [{ name: 'X', rawType: 'shoe', reason: 'wrong_type' }]);
    expect(p).toContain('"productType":"pants"');
    expect(p).toContain('"shoe"');
  });
});
