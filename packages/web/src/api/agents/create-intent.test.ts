import { describe, expect, test } from 'bun:test';
import { isCreationRequest, normalizeTokens } from './create-intent';
import { classifyIntent } from './orchestrator';

// Messages réels ou variantes de fautes que les utilisateurs tapent.
const CREATION = [
  'cret moi une mark de chaussure ', // message exact de l'utilisateur (2026-10-04)
  'cret moi une mark de chaussure',
  'crée moi une marque de chaussures',
  'créer une marque de baskets',
  'cree moi une marqe de sneakers',
  'crer une mrque de vetement',
  'fais moi une boutique de bijoux',
  'fé moi une marque de parfum',
  'je veux créer ma propre marque de chaussures',
  'je voudrais une marque de streetwear',
  'monte moi une boîte de t-shirts',
  'lance une marque de casquettes',
  'crée-moi des chaussures',
  'une mark de chaussure',
  'une marque de sneakers durables',
  'create a shoe brand',
  'make me a sneakers brand',
  'genere moi une entreprise de maillots',
  'construi moi un site pour ma marque',
];

const NOT_CREATION = [
  'comment créer une marque de chaussures ?',
  'comment créer une marque de chaussures',
  'combien coûte une marque de chaussures',
  'je veux savoir combien coûte une marque',
  'tu peux me créer une marque ?', // « ? » final : le classifieur IA tranche
  "j'ai une marque de vêtements et je veux plus de ventes",
  'ne crée pas de marque',
  'salut ça va',
  'quel temps fait-il à Bruxelles',
  'c est quoi une marque de chaussures',
  'explique moi le dropshipping',
  'merci beaucoup',
  'cree',
  '',
];

describe('isCreationRequest — demande de création tolérante aux fautes', () => {
  for (const m of CREATION) {
    test(`création : ${JSON.stringify(m)}`, () => {
      expect(isCreationRequest(m)).toBe(true);
    });
  }
  for (const m of NOT_CREATION) {
    test(`pas une création : ${JSON.stringify(m)}`, () => {
      expect(isCreationRequest(m)).toBe(false);
    });
  }

  test('normalise accents, apostrophes et t-shirt', () => {
    expect(normalizeTokens("Crée-moi une boîte d'T-Shirts")).toEqual(['cree', 'moi', 'une', 'boite', 'd', 'tshirts']);
  });
});

describe("classifyIntent (repli quand le classifieur IA ne répond pas à temps)", () => {
  // Avant : QUESTION → l'orchestrateur inventait une marque en texte
  // (« Voici PASO… ») au lieu de créer l'entreprise.
  test('le message exact de l’utilisateur est une idée à construire', () => {
    expect(classifyIntent('cret moi une mark de chaussure ', false, false)).toBe('BUSINESS_IDEA');
  });
  test('une vraie question reste une question', () => {
    expect(classifyIntent('explique moi le dropshipping', false, false)).toBe('QUESTION');
  });
  test('une salutation reste une salutation', () => {
    expect(classifyIntent('salut', false, false)).toBe('GREETING');
  });
});
