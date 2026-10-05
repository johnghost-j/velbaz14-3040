import { describe, it, expect } from 'bun:test';
import {
  containsWord,
  normalizePodProductType,
  podMerchDecision,
  podProductDecision,
  podAnnouncement,
  isFashionBusiness,
  podCatalogTypes,
  requiredPodType,
} from './pod-guard';
import { mappedPodTypes } from './printify-auto';

describe('containsWord', () => {
  it('matche un mot entier', () => {
    expect(containsWord('une marque de mode', ['mode'])).toBe(true);
  });
  it('ne matche PAS une sous-chaîne (bug historique « mode » ⊂ « moderne »)', () => {
    expect(containsWord('voiture électrique moderne', ['mode'])).toBe(false);
    expect(containsWord('sportswear moderne', ['mode'])).toBe(false);
  });
  it('gère les expressions multi-mots et la ponctuation', () => {
    expect(containsWord("crée un site de prêt-à-porter !", ['pret a porter', 'prêt à porter'])).toBe(true);
  });
});

describe('normalizePodProductType', () => {
  it('normalise les types Printify connus', () => {
    expect(normalizePodProductType('T-Shirt')).toBe('t-shirt');
    expect(normalizePodProductType('tee')).toBe('t-shirt');
    expect(normalizePodProductType('hoodie')).toBe('hoodie');
    expect(normalizePodProductType('sweatshirt')).toBe('hoodie');
    expect(normalizePodProductType('mug')).toBe('mug');
    expect(normalizePodProductType('tote bag')).toBe('tote bag');
    expect(normalizePodProductType('phone case')).toBe('phone case');
    expect(normalizePodProductType('sticker')).toBe('sticker');
    expect(normalizePodProductType('poster')).toBe('poster');
  });
  it('renvoie null pour un produit non imprimable (plus de repli t-shirt)', () => {
    expect(normalizePodProductType('car')).toBeNull();
    expect(normalizePodProductType('electric sedan')).toBeNull();
    expect(normalizePodProductType('sofa')).toBeNull();
    expect(normalizePodProductType('smartphone')).toBeNull();
    expect(normalizePodProductType('')).toBeNull();
  });
  // [2026-09-19] Trou signalé : une marque d'objets déco que Printify FABRIQUE
  // vraiment (coussin, plaid, paillasson…) était refusée comme non imprimable.
  it('reconnaît les objets maison/déco réellement fabricables', () => {
    expect(normalizePodProductType('coussin')).toBe('cushion');
    expect(normalizePodProductType('housse de coussin imprimée')).toBe('cushion');
    expect(normalizePodProductType('coussin de sol')).toBe('floor pillow');
    expect(normalizePodProductType('pouf')).toBe('bean bag');
    expect(normalizePodProductType('plaid')).toBe('blanket');
    expect(normalizePodProductType('paillasson')).toBe('doormat');
    expect(normalizePodProductType('tapis')).toBe('rug');
    expect(normalizePodProductType('rideau de douche')).toBe('shower curtain');
    expect(normalizePodProductType('tablier')).toBe('apron');
    expect(normalizePodProductType('puzzle')).toBe('puzzle');
    expect(normalizePodProductType('serviette de plage')).toBe('beach towel');
    expect(normalizePodProductType('gourde')).toBe('water bottle');
    expect(normalizePodProductType('casquette')).toBe('cap');
    expect(normalizePodProductType('carnet')).toBe('notebook');
    expect(normalizePodProductType('bougie parfumée')).toBe('candle');
    expect(normalizePodProductType('dessous de verre')).toBe('coaster');
  });
  it('ne confond pas les libellés composés avec le générique « tapis »', () => {
    expect(normalizePodProductType('tapis de souris')).toBe('mouse pad');
    expect(normalizePodProductType('mousepad gaming')).toBe('mouse pad');
    expect(normalizePodProductType('tapis de porte')).toBe('doormat');
  });
  // [2026-09-25] Bug signalé : une basket nommée « Summit High Top » sortait en
  // T-SHIRT, parce que 't-shirt' est en tête de table et liste « top » parmi
  // ses synonymes. Le synonyme le plus spécifique trouvé doit gagner.
  it('préfère le synonyme le plus spécifique, pas le premier de la table', () => {
    expect(normalizePodProductType('high top')).toBe('shoe');
    expect(normalizePodProductType('Summit High Top shoe')).toBe('shoe');
    expect(normalizePodProductType('Urban Pulse Low Top')).toBe('shoe');
    // …sans casser les cas où le générique EST le bon type.
    expect(normalizePodProductType('tank top')).toBe('t-shirt');
    expect(normalizePodProductType('crop top')).toBe('t-shirt');
    expect(normalizePodProductType('coussin de sol')).toBe('floor pillow');
  });
  it('ne fabrique toujours pas de meuble (Printify n’a aucun tabouret)', () => {
    // Vérifié sur le catalogue Printify : 0 blueprint « stool »/« tabouret »,
    // aucun meuble. Une marque de tabouret ne doit donc RIEN déclencher.
    expect(normalizePodProductType('tabouret')).toBeNull();
    expect(normalizePodProductType('stool')).toBeNull();
    expect(normalizePodProductType('chaise')).toBeNull();
    expect(normalizePodProductType('table basse')).toBeNull();
  });
});

describe('cohérence catalogue ↔ blueprints', () => {
  it('chaque type reconnu a un blueprint Printify mappé', () => {
    // Sans cette garantie, un type est reconnu par pod-guard puis abandonné
    // en silence par resolveBlueprint (BLUEPRINT_BY_POD_TYPE[type] undefined).
    const mapped = new Set(mappedPodTypes());
    const missing = podCatalogTypes().filter((t) => !mapped.has(t));
    expect(missing).toEqual([]);
  });
});

describe('podMerchDecision', () => {
  it('refuse le merch pour une marque de voiture (bug signalé)', () => {
    const d = podMerchDecision({ idea: 'cret une mark de voiture', industry: 'Automotive' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('not_requested');
  });
  it('refuse le merch pour les autres activités non imprimables', () => {
    expect(podMerchDecision({ idea: 'une agence immobilière à Lyon' }).allowed).toBe(false);
    expect(podMerchDecision({ idea: 'un restaurant de burgers' }).allowed).toBe(false);
    expect(podMerchDecision({ idea: 'une marque de meubles en chêne' }).allowed).toBe(false);
    expect(podMerchDecision({ idea: 'une marque de montres de luxe' }).allowed).toBe(false);
    expect(podMerchDecision({ idea: 'une marque de parfum' }).allowed).toBe(false);
  });
  // ── AUCUNE LISTE NOIRE : le refus ne doit JAMAIS venir d'une catégorie
  // d'activité, toujours du seul fait que l'objet imprimé n'a pas été demandé.
  it('ne refuse jamais « par catégorie d’activité » (plus de liste noire)', () => {
    for (const idea of [
      'cret une mark de voiture',
      'une agence immobilière à Lyon',
      'un restaurant de burgers',
      'une clinique dentaire',
      'une banque en ligne',
    ]) {
      const d = podMerchDecision({ idea });
      expect(d.reason).toBe('not_requested');
      expect(d).not.toHaveProperty('category');
    }
  });
  it('autorise le merch pour une activité textile', () => {
    const d = podMerchDecision({ idea: 'cret moi une mark de vêtement', industry: 'Fashion' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('pod_native');
  });
  // [2026-09-20 puis 09-22] Bug signalé : « crée-moi une marque de chaussures »
  // classée sous l'industrie générique « Fashion » fabriquait un t-shirt/hoodie
  // à logo de chaussure au lieu de vraies chaussures. Le [2026-09-20] avait
  // corrigé la moitié du problème (plus de t-shirt à logo) mais abandonnait
  // le produit au lieu de fabriquer de vraies chaussures — Printify en a de
  // réelles (blueprint vérifié), donc c'est maintenant autorisé pour de bon.
  it('autorise et fabrique de VRAIES chaussures pour une marque de chaussures classée "Fashion"', () => {
    const d = podMerchDecision({ idea: 'crer moi une mark de chaussure', industry: 'Fashion' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('real_product_match');
    const p = podProductDecision({ idea: 'crer moi une mark de chaussure', industry: 'Fashion', productType: 'sneakers' });
    expect(p.create).toBe(true);
    expect(p.podType).toBe('shoe');
  });
  it('autorise aussi une marque de sneakers classée "Mode", jamais en merch textile', () => {
    const d = podMerchDecision({ idea: 'une marque de sneakers', industry: 'Mode' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('real_product_match');
  });
  it('refuse le merch pour d’autres produits physiques précis classés "Fashion" (pas encore de blueprint vérifié)', () => {
    expect(podMerchDecision({ idea: 'une marque de sacs à main', industry: 'Fashion' }).allowed).toBe(false);
    expect(podMerchDecision({ idea: 'une marque de bijoux', industry: 'Fashion' }).allowed).toBe(false);
  });
  // [2026-09-23] Bug signalé par l'utilisateur : Printify était bien branché
  // et fonctionnel pour une marque de chaussures, mais l'IA de sélection
  // produit (gpt-5.4-mini) a quand même choisi "t-shirt"/"hoodie" en ignorant
  // la règle du prompt qui lui interdit ce genre de substitution. Comme cette
  // règle n'était vérifiée QUE dans le texte du prompt, rien en code ne
  // l'empêchait. `requiredPodType`/`podProductDecision` la font maintenant
  // respecter de force.
  it('requiredPodType force le type réel (chaussure) et rejette un t-shirt de substitution', () => {
    const decision = podMerchDecision({ idea: 'une marque de chaussures', industry: 'Fashion' });
    expect(requiredPodType(decision)).toBe('shoe');
    const wrongType = podProductDecision({ idea: 'une marque de chaussures', industry: 'Fashion', productType: 't-shirt' });
    expect(wrongType.create).toBe(false);
    expect(wrongType.reason).toBe('wrong_type');
    const rightType = podProductDecision({ idea: 'une marque de chaussures', industry: 'Fashion', productType: 'sneaker' });
    expect(rightType.create).toBe(true);
    expect(rightType.podType).toBe('shoe');
  });
  // [2026-09-23] Le verrou "objet vendu = objet imprimé" n'est plus limité aux
  // chaussures : n'importe quel type du catalogue Printify réellement vérifié
  // (mug, tapis, coussin…) nommé explicitement dans l'idée doit aussi gagner
  // sur un t-shirt/hoodie de substitution. Aucune liste de produits figée :
  // seul le type précis déjà nommé est forcé, tout le reste du catalogue
  // reste utilisable normalement ailleurs (demande explicite, activité
  // textile générique…).
  it('généralise le verrou de type à tout le catalogue Printify, pas seulement aux chaussures', () => {
    const decision = podMerchDecision({ idea: 'une marque de tapis', industry: 'Maison' });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('real_product_match');
    expect(requiredPodType(decision)).toBe('rug');
    const wrongType = podProductDecision({ idea: 'une marque de tapis', industry: 'Maison', productType: 'hoodie' });
    expect(wrongType.create).toBe(false);
    expect(wrongType.reason).toBe('wrong_type');
  });
  it('autorise quand même si le t-shirt est explicitement demandé pour une marque de chaussures', () => {
    const d = podMerchDecision({ idea: 'des t-shirts pour ma marque de chaussures', industry: 'Fashion' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('explicit_request');
  });
  it('autorise le merch quand l’utilisateur le demande explicitement', () => {
    const d = podMerchDecision({ idea: 'une boutique de t-shirts pour mon garage automobile', industry: 'Automotive' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('explicit_request');
  });
  it('ne classe pas « moderne » comme textile', () => {
    const d = podMerchDecision({ idea: 'une marque de voiture électrique moderne', industry: 'Automotive' });
    expect(d.allowed).toBe(false);
  });
  it('autorise une activité dont le produit EST l’objet imprimé (posters)', () => {
    // « posters » est nommé dans l'idée → demande explicite d'objet imprimé.
    const d = podMerchDecision({ idea: 'une marque de posters minimalistes', industry: 'Design' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('explicit_request');
  });
  it('autorise une activité nativement imprimable sans produit nommé', () => {
    const d = podMerchDecision({ idea: 'une marque de papeterie soignée', industry: 'Stationery' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('pod_native');
  });
  // ── Printify est OPT-IN : tout ce qui n'est ni demandé ni nativement
  // imprimable est refusé, même si l'activité n'est pas dans la liste noire.
  it('refuse par défaut toute activité qui n’a rien demandé (opt-in)', () => {
    for (const idea of [
      'une entreprise de nettoyage de bureaux',
      'un cabinet de conseil en stratégie',
      'une école de langues en ligne',
      'un studio de tatouage',
      'une marque de trottinettes pliables',
    ]) {
      const d = podMerchDecision({ idea });
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('not_requested');
    }
  });
  it('expose le terme qui a déclenché l’autorisation (explicabilité)', () => {
    expect(podMerchDecision({ idea: 'ajoute des mugs à ma marque' }).match).toBe('mug');
    expect(podMerchDecision({ idea: 'une marque de vêtements', industry: 'Fashion' }).match).toBeTruthy();
  });
});

describe('podProductDecision', () => {
  it('refuse tout produit quand l’activité n’est pas imprimable (bug signalé)', () => {
    // « une marque de voiture » → AUCUN pull/t-shirt à logo de voiture.
    const d = podProductDecision({
      idea: 'cret une mark de voiture',
      industry: 'Automotive',
      productName: 'Torque Club Hoodie',
      category: 'apparel',
    });
    expect(d.create).toBe(false);
    expect(d.reason).toBe('not_requested');
    expect(d.podType).toBeNull();
  });
  it('refuse un produit non imprimable même pour une activité autorisée', () => {
    const d = podProductDecision({
      idea: 'une marque de vêtements streetwear',
      industry: 'Fashion',
      productType: 'ceinture en cuir',
    });
    expect(d.create).toBe(false);
    expect(d.reason).toBe('product_not_printable');
    expect(d.podType).toBeNull();
  });
  it('accepte un vrai produit Printify pour une activité textile', () => {
    const d = podProductDecision({
      idea: 'une marque de vêtements streetwear',
      industry: 'Fashion',
      productType: 'Hoodie',
    });
    expect(d).toEqual({ create: true, podType: 'hoodie', reason: 'ok' });
  });
  it('accepte quand l’utilisateur demande explicitement du merch', () => {
    const d = podProductDecision({
      idea: 'des t-shirts pour ma marque de voiture',
      industry: 'Automotive',
      productType: 'tee',
    });
    expect(d.create).toBe(true);
    expect(d.podType).toBe('t-shirt');
  });
  it('déduit le type depuis le nom/catégorie si productType manque', () => {
    const d = podProductDecision({
      idea: 'une marque de papeterie',
      productName: 'Studio Mug',
      category: 'accessoires',
    });
    expect(d.create).toBe(true);
    expect(d.podType).toBe('mug');
  });
  it('ne substitue jamais un t-shirt par défaut', () => {
    const d = podProductDecision({
      idea: 'une marque de vêtements',
      industry: 'Fashion',
      productType: 'berline électrique',
    });
    expect(d.podType).not.toBe('t-shirt');
    expect(d.create).toBe(false);
  });
});

describe('podAnnouncement', () => {
  it('prévient qu’AUCUN produit imprimé ne sera créé, et comment en demander', () => {
    const msg = podAnnouncement({ decision: podMerchDecision({ idea: 'cret une mark de voiture' }) });
    expect(msg).toContain('aucun produit imprimé');
    expect(msg.toLowerCase()).toContain('t-shirt'); // explique comment en demander
    // Aucun jugement d'activité dans le message (plus de liste noire).
    expect(msg.toLowerCase()).not.toContain('automobile');
  });
  it('annonce la liste exacte des produits AVANT de les créer', () => {
    const msg = podAnnouncement({
      decision: podMerchDecision({ idea: 'des t-shirts pour ma marque de voiture' }),
      products: [{ name: 'Race Tee', podType: 't-shirt' }],
    });
    expect(msg).toContain('je vais créer 1 produit');
    expect(msg).toContain('Race Tee');
    expect(msg).toContain('t-shirt');
    expect(msg).toContain('tu as demandé'); // dit POURQUOI
  });
  it('liste les produits écartés et affirme l’absence de substitution', () => {
    const msg = podAnnouncement({
      decision: podMerchDecision({ idea: 'une marque de vêtements', industry: 'Fashion' }),
      products: [{ name: 'Basic Tee', podType: 't-shirt' }],
      skipped: [{ name: 'Ceinture cuir', reason: 'product_not_printable' }],
    });
    expect(msg).toContain('Ceinture cuir');
    expect(msg).toContain('aucun t-shirt par défaut');
  });
});

describe('isFashionBusiness', () => {
  it('reconnaît la mode', () => {
    expect(isFashionBusiness('Fashion', 'streetwear brand')).toBe(true);
    expect(isFashionBusiness('Apparel', '')).toBe(true);
    expect(isFashionBusiness('', 'une marque de vêtements')).toBe(true);
  });
  it('ne prend pas une voiture moderne pour de la mode', () => {
    expect(isFashionBusiness('Automotive', 'une marque de voiture moderne')).toBe(false);
    expect(isFashionBusiness('Technology', 'design moderne et épuré')).toBe(false);
  });
  // [2026-09-20] Bug signalé : une marque de chaussures classée "Fashion" par
  // le classifieur d'industrie recevait le traitement textile (fiche 3 vues,
  // "porté par un mannequin", design imprimé) au lieu d'une vraie chaussure.
  it('ne prend pas une marque de chaussures pour de la mode, même classée "Fashion"', () => {
    expect(isFashionBusiness('Fashion', 'crer moi une mark de chaussure')).toBe(false);
    expect(isFashionBusiness('Mode', 'une marque de sneakers premium')).toBe(false);
    expect(isFashionBusiness('Fashion', 'une marque de sacs à main')).toBe(false);
    expect(isFashionBusiness('Fashion', 'une marque de bijoux')).toBe(false);
  });
});

// [2026-10-03] Bug « des fois ça n'utilise pas Printify » (projet Denimora,
// « cret une mark de pentalon ») : l'IA renvoyait « pants », type alors
// inconnu → produit jeté en silence → 0 produit Printify.
describe('vêtements du catalogue (pantalon, jogging, robe…)', () => {
  it('normalise les nouveaux types renvoyés par l’IA', () => {
    expect(normalizePodProductType('pants')).toBe('pants');
    expect(normalizePodProductType('Pantalon chino')).toBe('pants');
    expect(normalizePodProductType('jeans')).toBe('pants');
    expect(normalizePodProductType('jogging')).toBe('joggers');
    expect(normalizePodProductType('sweatpants')).toBe('joggers');
    expect(normalizePodProductType('short')).toBe('shorts');
    expect(normalizePodProductType('robe')).toBe('dress');
    expect(normalizePodProductType('chaussettes')).toBe('socks');
    expect(normalizePodProductType('bonnet')).toBe('beanie');
    expect(normalizePodProductType('sac à dos')).toBe('backpack');
    expect(normalizePodProductType('maillot de bain')).toBe('swimsuit');
  });
  it('le synonyme le plus spécifique gagne : « veste en jean » → jacket, pas pants', () => {
    expect(normalizePodProductType('veste en jean')).toBe('jacket');
    expect(normalizePodProductType('pantalon de jogging')).toBe('joggers');
    expect(normalizePodProductType('maillot de bain')).toBe('swimsuit'); // pas t-shirt (« maillot »)
  });
  it('une marque de pantalons crée des pantalons, même classée « Retail »', () => {
    const d = podMerchDecision({ idea: 'une marque de pantalons', industry: 'Retail' });
    expect(d).toMatchObject({ allowed: true, reason: 'real_product_match' });
    expect(requiredPodType(d)).toBe('pants');
  });
  it('idée pleine de fautes : la description du projet décide (cas Denimora)', () => {
    const idea = 'cret une mark de pentalon';
    const description = 'Marque de pantalons qui vend directement ses modèles à ses clients finaux.';
    for (const industry of ['Fashion', 'Retail', 'Other']) {
      const d = podMerchDecision({ idea, industry, description });
      expect(d.allowed).toBe(true);
      expect(requiredPodType(d)).toBe('pants');
    }
    // Sans description, l'industrie « Other » ne suffit pas (comportement opt-in inchangé).
    expect(podMerchDecision({ idea, industry: 'Other' }).allowed).toBe(false);
  });
  it('podProductDecision : un « shoe » proposé pour une marque de pantalons est rejeté', () => {
    const base = { idea: 'cret une mark de pentalon', industry: 'Fashion', description: 'Marque de pantalons.' };
    expect(podProductDecision({ ...base, productType: 'pants' })).toMatchObject({ create: true, podType: 'pants' });
    expect(podProductDecision({ ...base, productType: 'shoe' })).toMatchObject({ create: false, reason: 'wrong_type' });
  });
  it('les mots ambigus ne déclenchent rien : prénom Jean, voiture Polo, sport jogging', () => {
    expect(podMerchDecision({ idea: 'la boulangerie de Jean', industry: 'Food' }).allowed).toBe(false);
    expect(podMerchDecision({ idea: 'garage spécialisé Volkswagen Polo', industry: 'Automotive' }).allowed).toBe(false);
    expect(podMerchDecision({ idea: 'une appli de jogging', industry: 'Technology' }).allowed).toBe(false);
  });
  it('mots génériques de la description ignorés (« top », « print », « robe »…)', () => {
    const d = podMerchDecision({
      idea: 'garage auto', industry: 'Automotive',
      description: 'Un garage au service top, avec un print de devis rapide et une robe de carrosserie impeccable.',
    });
    expect(d.allowed).toBe(false);
  });
  it('un objet réel non fabricable dans la description bloque toujours (bijoux)', () => {
    const d = podMerchDecision({ idea: 'cret une mark de bijou', industry: 'Fashion', description: 'Marque de bijoux faits main.' });
    expect(d.allowed).toBe(false);
  });
  it('une marque de pantalons reste de la mode (fiche textile), une marque de mugs non', () => {
    expect(isFashionBusiness('Retail', 'une marque de pantalons')).toBe(true);
    expect(isFashionBusiness('Fashion', 'une marque de robes')).toBe(true);
    expect(isFashionBusiness('Fashion', 'une marque de chaussures')).toBe(false);
    expect(isFashionBusiness('Retail', 'une marque de mugs')).toBe(false);
  });
});
