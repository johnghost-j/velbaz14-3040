// ─── Sélection des produits Printify de l'aperçu de marque ──────────────────
// [2026-10-03] Bug signalé : « des fois quand je crée un projet ça n'utilise
// pas Printify alors que c'est une company qui a besoin de produits ».
// Mesuré en direct sur le projet « mark de pentalon » (Denimora) : l'IA de
// sélection renvoyait « pants » (2 fois sur 3) — type absent du garde-fou, donc
// jeté en silence → 0 produit ; la 3ᵉ fois elle renvoyait « shoe » pour une
// marque de PANTALONS, parce que le prompt ne citait que des exemples
// t-shirt/mug/chaussure. Trois corrections vivent ici :
//  1. le prompt liste le catalogue RÉEL des types fabricables (pod-guard), et
//     donne la description propre du projet en plus de l'idée (souvent tapée
//     avec des fautes) ;
//  2. le parsing garde la trace de CHAQUE produit écarté et pourquoi (type
//     inconnu, type différent de l'objet vendu) au lieu de les perdre ;
//  3. un 2ᵉ appel, contraint au catalogue, est fait quand aucun produit n'a
//     survécu alors que l'activité vend des objets imprimables.
// Aucun produit n'est jamais substitué : un type inconnu reste écarté.

import { normalizePodProductType, podCatalogTypes, POD_TYPE_LABELS_FR } from './pod-guard';

export interface SelectedProduct {
  name: string;
  productType: string;
  design: string;
}

export interface DroppedProduct {
  name: string;
  /** Type brut renvoyé par l'IA. */
  rawType: string;
  reason: 'unknown_type' | 'wrong_type' | 'no_design';
}

export interface ProductSelection {
  businessType: 'clothing' | 'physical_product' | 'service_digital' | null;
  products: SelectedProduct[];
  dropped: DroppedProduct[];
}

/** Liste lisible du catalogue fabricable, injectée dans le prompt. */
export function catalogTypesForPrompt(): string {
  return podCatalogTypes()
    .map((t) => `"${t}" (${POD_TYPE_LABELS_FR[t] || t})`)
    .join(', ');
}

/** Extrait le 1er objet JSON d'une réponse IA (avec ou sans bloc ```). */
function extractJson(raw: string): any | null {
  let s = String(raw || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  const st = s.indexOf('{');
  const en = s.lastIndexOf('}');
  if (st < 0 || en <= st) return null;
  try {
    return JSON.parse(s.slice(st, en + 1));
  } catch {
    return null;
  }
}

/**
 * Lit la réponse de l'IA de sélection produit. Chaque type est ramené au
 * catalogue Printify réel (normalizePodProductType) ; si `forcedType` est
 * fixé (l'objet vendu est connu), tout autre type est écarté.
 */
export function parseProductSelection(raw: string, forcedType: string | null, max = 2): ProductSelection {
  const obj = extractJson(raw);
  const bt = String(obj?.businessType || '').toLowerCase();
  const businessType =
    bt === 'clothing' || bt === 'physical_product' || bt === 'service_digital' ? bt : null;
  const products: SelectedProduct[] = [];
  const dropped: DroppedProduct[] = [];
  const list: any[] = Array.isArray(obj?.products) ? obj.products : [];
  for (const p of list) {
    const name = String(p?.name || '').slice(0, 60);
    const rawType = String(p?.productType || '').slice(0, 60);
    const design = String(p?.design || '').slice(0, 400);
    const productType = normalizePodProductType(rawType) || '';
    if (!productType) { dropped.push({ name, rawType, reason: 'unknown_type' }); continue; }
    if (forcedType && productType !== forcedType) { dropped.push({ name, rawType, reason: 'wrong_type' }); continue; }
    if (!design) { dropped.push({ name, rawType, reason: 'no_design' }); continue; }
    if (products.length < max) products.push({ name, productType, design });
  }
  return { businessType, products, dropped };
}

interface PromptInput {
  name: string;
  idea: string;
  industry: string;
  description?: string;
  feedback?: string;
}

function contextLines(i: PromptInput): string {
  return [
    `Entreprise: ${i.name}`,
    `Idée: ${i.idea}`,
    i.description ? `Description du projet (version corrigée de l'idée, sans fautes): ${i.description}` : '',
    `Secteur: ${i.industry}`,
    i.feedback ? `\nRETOUR UTILISATEUR (à respecter absolument): ${i.feedback}\n` : '',
  ].filter(Boolean).join('\n');
}

/** Prompt de la 1ʳᵉ sélection (types libres parmi le catalogue). */
export function productSelectionPrompt(i: PromptInput): string {
  return `${contextLines(i)}
Détermine:
1. "businessType": "clothing" (vêtements/textile), "physical_product" (produit physique imprimable), ou "service_digital" (service/app numérique, sans produit physique).
2. "products": 2 produits print-on-demand concrets. Pour chacun:
   - "name": nom court du produit.
   - "productType": EXACTEMENT un de ces types fabricables par Printify : ${catalogTypesForPrompt()}. Choisis TOUJOURS le type qui EST l'objet réellement vendu par l'entreprise (une marque de pantalons → "pants", de jogging → "joggers", de chaussures → "shoe", de robes → "dress"…).
   - "design": description en ANGLAIS de l'artwork/visuel à IMPRIMER sur le produit, inspiré de l'idée de l'entreprise et de la demande utilisateur. Graphique plat, print-ready.

RÈGLE ABSOLUE #1 — ne transforme JAMAIS l'activité en goodies à son effigie : les produits doivent ÊTRE l'offre réelle de l'entreprise. Si l'idée nomme un objet précis de la liste, les 2 produits DOIVENT être cet objet (ex. deux modèles de pantalons), JAMAIS un t-shirt/hoodie portant un simple logo/dessin de cet objet.
RÈGLE ABSOLUE #2 — si les produits réels de l'entreprise ne sont dans AUCUN type de la liste (voiture/véhicule, immobilier, mobilier, électronique, restaurant/alimentaire, machine, bijou/montre, cosmétique…), renvoie "products": [] — ne propose SURTOUT PAS un t-shirt ou un hoodie de substitution.
JSON strict: {"businessType":"...","products":[{"name":"...","productType":"...","design":"..."}]}`;
}

/**
 * Prompt du 2ᵉ appel : soit le type est imposé (objet vendu connu), soit l'IA
 * doit choisir dans le catalogue l'objet vendu, après une 1ʳᵉ réponse
 * inexploitable (types inconnus).
 */
export function productRetryPrompt(i: PromptInput, forcedType: string | null, rejected: DroppedProduct[]): string {
  const rejectedLine = rejected.length
    ? `\nTa réponse précédente a été rejetée : ${rejected.map((d) => `"${d.rawType || '?'}"`).join(', ')} ${forcedType ? `n'est pas l'objet vendu ("${forcedType}").` : "n'existe pas dans la liste."}`
    : '';
  if (forcedType) {
    return `${contextLines(i)}${rejectedLine}
Le produit vendu par cette entreprise est déjà déterminé : type Printify "${forcedType}". Donne 2 variantes/modèles concrets de CE type EXACT (même "productType":"${forcedType}" pour les deux), avec un nom court et un design/artwork différent pour chacun.
"design": description en ANGLAIS de l'artwork/visuel à IMPRIMER, inspiré de l'idée et de la demande utilisateur. Graphique plat, print-ready.
JSON strict: {"products":[{"name":"...","productType":"${forcedType}","design":"..."},{"name":"...","productType":"${forcedType}","design":"..."}]}`;
  }
  return `${contextLines(i)}${rejectedLine}
Types fabricables par Printify (UNIQUEMENT ceux-ci) : ${catalogTypesForPrompt()}.
Choisis le type de la liste qui EST l'objet réellement vendu par l'entreprise (jamais un goodie à son effigie) et donne 2 modèles concrets de ce type, avec un nom court et un design différent. Si aucun type de la liste n'est l'objet vendu, renvoie "products": [].
"design": description en ANGLAIS de l'artwork/visuel à IMPRIMER. Graphique plat, print-ready.
JSON strict: {"products":[{"name":"...","productType":"...","design":"..."}]}`;
}

/** Ligne lisible des produits écartés, pour les logs et l'activité. */
export function describeDropped(dropped: DroppedProduct[]): string {
  return dropped
    .map((d) => `« ${d.name || '?'} » (${d.rawType || 'type vide'} → ${
      d.reason === 'unknown_type' ? 'type impossible à fabriquer' : d.reason === 'wrong_type' ? "pas l'objet vendu" : 'design manquant'
    })`)
    .join(' ; ');
}
