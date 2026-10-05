// Tests du garde-fou « méta-business ». Le cas n°1 est le PLAN RÉEL retrouvé en
// base pour le projet cassé signalé par l'utilisateur (idée : « cret moi une
// mark de vêtement ») : appType "saas" + collection "brands" + formulaire de
// création de marque. Aucun appel modèle ici : tout est déterministe.
import { describe, expect, it } from 'bun:test';
import { findMetaPlanViolations, isOwnedBusinessIdea, planCorrectionNote, sanitizeFirstPartyPlan } from './plan-guard';
import { normalizeIdea } from '../idea-subject';

const BROKEN_IDEA = "User: cret moi une mark de vêtement\nAI: Top — pour créer la bonne marque de vêtements pour toi, dis-moi juste ces 5 points.";

const BROKEN_PLAN = {
  appType: 'saas',
  entities: [
    { collection: 'brands', fields: 'name:string, niche:string, targetAudience:string, vision:string, logoUrl:string, status:string', description: "Détails de la marque de vêtement créée par l'utilisateur." },
    { collection: 'collections', fields: 'brandId:string, name:string, season:string', description: 'Collections saisonnières rattachées à une marque.' },
    { collection: 'products', fields: 'collectionId:string, name:string, retailPrice:number', description: 'Articles individuels.' },
    { collection: 'business_plans', fields: 'brandId:string, startupCapital:number, salesTarget:number', description: "Prévisions financières basées sur les données de l'utilisateur." },
  ],
  pages: [
    {
      name: 'Showroom', file: 'Showroom.tsx', route: '/', purpose: 'Découvrir et naviguer la marque.',
      sections: "Tableau de bord interactif affichant l'état d'avancement (data.list('brands')). Formulaire de création de marque (data.create) demandant le nom, la niche et l'audience. Barre de progression dynamique basée sur les étapes complétées (Identité, Collection, Sourcing, Lancement).",
    },
    { name: 'Collection', file: 'Collection.tsx', route: '/collection', purpose: 'Lister les créations disponibles.', sections: "Grille des pièces via data.list('products'), filtres par catégorie, lien vers la fiche produit." },
  ],
};

const GOOD_PLAN = {
  appType: 'ecommerce',
  entities: [
    { collection: 'products', fields: 'name:string, price:number, imageUrl:string', description: 'les pièces vendues par la marque' },
    { collection: 'orders', fields: 'items:string, total:number, status:string', description: 'commandes des clients finaux' },
  ],
  pages: [
    { name: 'Boutique', file: 'Boutique.tsx', route: '/', purpose: 'Acheter les pièces', sections: "Grille produits via data.list('products'), ajout au panier (useState), checkout Stripe." },
    { name: 'Produit', file: 'Produit.tsx', route: '/produit/:id', purpose: 'Fiche produit', sections: 'Galerie, tailles, prix, ajout au panier.' },
  ],
};

describe('isOwnedBusinessIdea', () => {
  it('reconnaît une marque de vêtements demandée par l’utilisateur', () => {
    expect(isOwnedBusinessIdea(BROKEN_IDEA)).toBe(true);
    expect(isOwnedBusinessIdea('crée-moi une marque de vêtements')).toBe(true);
    expect(isOwnedBusinessIdea('je veux ouvrir un restaurant italien à Lyon')).toBe(true);
    expect(isOwnedBusinessIdea('build me a coffee brand')).toBe(true);
  });
  it('ne s’applique pas à un vrai projet de logiciel', () => {
    expect(isOwnedBusinessIdea('crée-moi un SaaS de gestion de projet pour les équipes')).toBe(false);
    expect(isOwnedBusinessIdea('un clone de Notion')).toBe(false);
  });
  it('ne s’applique pas quand l’utilisateur veut explicitement un outil/app', () => {
    // Faux positif à éviter : ici le LOGICIEL est bien le produit demandé.
    expect(isOwnedBusinessIdea('je veux un outil qui permet de créer sa marque de vêtements')).toBe(false);
    expect(isOwnedBusinessIdea('une app pour gérer les commandes de ma boutique')).toBe(false);
    expect(isOwnedBusinessIdea('une marketplace de créateurs de bijoux')).toBe(false);
    expect(isOwnedBusinessIdea('une plateforme de réservation pour les restaurants')).toBe(false);
  });
  it('reste actif quand l’utilisateur demande juste « le site » de sa marque', () => {
    expect(isOwnedBusinessIdea('fais-moi le site de ma marque de vêtements')).toBe(true);
    expect(isOwnedBusinessIdea('je veux vendre mes t-shirts en ligne')).toBe(true);
  });
  it('ne s’applique pas quand l’utilisateur veut explicitement une agence', () => {
    expect(isOwnedBusinessIdea('je veux une agence qui crée des marques de vêtements pour mes clients')).toBe(false);
  });
  it('est aveugle au bloc de verrou et aux phrases de l’IA', () => {
    const locked = normalizeIdea(BROKEN_IDEA).idea;
    expect(isOwnedBusinessIdea(locked)).toBe(true);
  });
});

describe('findMetaPlanViolations', () => {
  it('détecte le plan cassé réel (appType saas + brands + formulaire de création)', () => {
    const v = findMetaPlanViolations(BROKEN_PLAN, BROKEN_IDEA);
    expect(v.length).toBeGreaterThanOrEqual(3);
    expect(v.join(' | ')).toContain('saas');
    expect(v.join(' | ')).toContain('brands');
    expect(v.join(' | ')).toContain('Showroom');
  });
  it('détecte aussi le plan cassé quand l’idée est déjà verrouillée', () => {
    expect(findMetaPlanViolations(BROKEN_PLAN, normalizeIdea(BROKEN_IDEA).idea).length).toBeGreaterThan(0);
  });
  it('laisse passer un plan de boutique légitime', () => {
    expect(findMetaPlanViolations(GOOD_PLAN, BROKEN_IDEA)).toEqual([]);
  });
  it('ne touche pas aux vrais projets logiciels', () => {
    expect(findMetaPlanViolations(BROKEN_PLAN, 'crée-moi un SaaS de gestion de projet')).toEqual([]);
  });
  it('détecte les pages de prestataire glissées dans une marque', () => {
    const plan = { ...GOOD_PLAN, pages: [...GOOD_PLAN.pages, { name: 'Services', file: 'Services.tsx', route: '/services', purpose: 'Nos services pour les marques', sections: 'Liste des prestations, demande de devis.' }] };
    expect(findMetaPlanViolations(plan, BROKEN_IDEA).length).toBeGreaterThan(0);
  });
});

describe('sanitizeFirstPartyPlan', () => {
  const fixed = sanitizeFirstPartyPlan(BROKEN_PLAN, BROKEN_IDEA);

  it('remplace un appType logiciel', () => {
    expect(['ecommerce', 'brand']).toContain(fixed.appType);
  });
  it('supprime les entités méta', () => {
    const cols = fixed.entities!.map(e => e.collection);
    expect(cols).not.toContain('brands');
    expect(cols).not.toContain('business_plans');
    expect(cols).toContain('products');
  });
  it('purge le formulaire de création de marque des sections', () => {
    const showroom = fixed.pages!.find(p => p.name === 'Showroom')!;
    expect(showroom.sections.toLowerCase()).not.toContain('création de marque');
    expect(showroom.sections.toLowerCase()).not.toContain("état d'avancement");
  });
  it('garde les sections légitimes intactes', () => {
    const coll = fixed.pages!.find(p => p.name === 'Collection')!;
    expect(coll.sections).toContain("data.list('products')");
  });
  it('produit un plan sans aucune violation résiduelle', () => {
    expect(findMetaPlanViolations(fixed, BROKEN_IDEA)).toEqual([]);
  });
  it('est idempotent', () => {
    expect(sanitizeFirstPartyPlan(fixed, BROKEN_IDEA)).toEqual(fixed);
  });
  it('ne modifie pas un plan légitime', () => {
    expect(sanitizeFirstPartyPlan(GOOD_PLAN, BROKEN_IDEA)).toEqual(GOOD_PLAN as any);
  });
  it('ne modifie pas un projet logiciel', () => {
    expect(sanitizeFirstPartyPlan(BROKEN_PLAN, 'crée-moi un SaaS de gestion de projet')).toEqual(BROKEN_PLAN as any);
  });
});

describe('planCorrectionNote', () => {
  it('liste les violations et interdit le méta-business', () => {
    const note = planCorrectionNote(['appType "saas"'], 'fr');
    expect(note).toContain('appType "saas"');
    expect(note).toContain('REJETÉ');
    expect(note.toLowerCase()).toContain('clients finaux');
  });
  it('a une version anglaise', () => {
    expect(planCorrectionNote(['appType "saas"'], 'en')).toContain('REJECTED');
  });
});
