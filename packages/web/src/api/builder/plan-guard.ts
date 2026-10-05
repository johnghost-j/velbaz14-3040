// Garde-fou DÉTERMINISTE contre le bug de « méta-business ».
//
// [2026-09-18] Symptôme réel observé en base : sur « crée-moi une marque de
// vêtements », le plan généré était
//   { appType: "saas",
//     entities: [ { collection: "brands", description: "détails de la marque
//                   de vêtement créée par l'utilisateur" },
//                 { collection: "business_plans", … } ],
//     pages: [ { name: "Showroom", sections: "tableau de bord d'avancement,
//                 FORMULAIRE DE CRÉATION DE MARQUE (data.create), barre de
//                 progression Identité/Collection/Sourcing/Lancement" } ] }
// Autrement dit : un OUTIL qui permet à son visiteur de créer une marque de
// vêtements, au lieu de la BOUTIQUE de la marque de l'utilisateur. Le modèle
// monte d'un cran d'abstraction : il confond « construis-moi X » avec
// « construis-moi le logiciel qui construit des X ».
//
// Les prompts (verrou de sujet + règle #2 bis) réduisent le risque mais ne le
// suppriment pas : un LLM finit toujours par dériver. Ce module détecte la
// dérive sur le JSON du plan — sans appel modèle, donc 100 % reproductible —
// et permet de corriger (re-plan guidé) puis d'assainir en dernier recours.
import { detectOfferLevel, stripAiTurns, stripSubjectLock } from '../idea-subject';

type PlanLike = {
  appType?: string;
  entities?: Array<{ collection: string; fields: string; description?: string }>;
  pages?: Array<{ name?: string; route?: string; purpose?: string; sections?: string;[k: string]: any }>;
};

/** Business possédé par l'utilisateur et vendu en direct (marque, boutique,
 *  resto, salon…) — par opposition à un vrai projet de logiciel/outil. */
const OWNED_BUSINESS_RE = new RegExp(
  [
    'marque', 'brand', 'boutique', 'shop', 'store', 'magasin', 'e-?commerce', 'vend(re|s)?\\b',
    'v[êe]tement', 'clothing', 'apparel', 'streetwear', 't-?shirt', 'hoodie', 'sneaker', 'chaussure',
    'bijou', 'jewel', 'montre', 'cosm[ée]tique', 'skincare', 'parfum', 'maquillage',
    'restaurant', 'resto', 'pizzeria', 'boulangerie', 'p[âa]tisserie', 'caf[ée]', 'coffee', 'traiteur', 'food truck',
    'salon', 'barbier', 'coiffure', 'spa', 'tatouage',
    'salle de sport', 'gym\\b', 'studio de yoga', 'club de',
    'meuble', 'mobilier', 'd[ée]coration', 'artisan', 'c[ée]ramique', 'bougie',
    'boisson', 'brasserie', 'vin\\b', 'chocolat', 'glace',
  ].join('|'),
  'i',
);

/** Collections qui n'ont de sens que dans un OUTIL qui gère des business des
 *  autres. Une marque de vêtements n'a pas de table « brands ». */
const META_COLLECTIONS = [
  'brand', 'brands', 'marque', 'marques', 'business', 'businesses', 'business_plan', 'business_plans',
  'businessplans', 'company', 'companies', 'entreprise', 'entreprises', 'startup', 'startups',
  'project', 'projects', 'projet', 'projets', 'client', 'clients', 'onboarding', 'onboardings',
  'brand_projects', 'brandprojects', 'brand_identity', 'brandidentity', 'identity', 'identities',
  'launch', 'launches', 'lancement', 'lancements', 'roadmap', 'roadmaps', 'milestone', 'milestones',
  'sourcing', 'sourcings', 'supplier_requests', 'quotes', 'devis', 'leads', 'prospects',
  'campaign', 'campaigns', 'strategy', 'strategies', 'strategie', 'strategies',
];

/** Appuis textuels d'un outil de création/gestion de business. */
const META_TEXT_RE = new RegExp(
  [
    'cr[ée]{1,2}(r|tion|ation)?\\s+(sa|ta|votre|une|ma|leur)\\s+(propre\\s+)?(marque|entreprise|business|boutique|soci[ée]t[ée])',
    'formulaire de cr[ée]ation de (marque|entreprise|business)',
    'cr[ée]ation de marque',
    'brand (creation|builder|wizard|onboarding)',
    'create (your|their|a) (own )?(brand|business|company|store)',
    'business plan', 'plan d\'affaires', 'pr[ée]visions financi[èe]res',
    'barre de progression.{0,40}(identit|lancement|sourcing)',
    '[ée]tapes? (de|du) (lancement|cr[ée]ation)',
    'tableau de bord.{0,40}(avancement|progression|marque|business)',
    'gestion de (la |sa |ta |votre )?(marque|entreprise|business)',
    'pour (ses|leurs|vos|tes) clients',
    'pour d\'autres (marques|entreprises)',
    '(nos|vos) (services|prestations)', 'portfolio de (projets|clients)', 'white ?label',
  ].join('|'),
  'i',
);

/** Demande EXPLICITE d'un logiciel : « un outil qui permet de créer sa marque »,
 *  « une app de fitness », « une plateforme de réservation ». Dans ce cas le
 *  produit EST un logiciel — le garde-fou ne doit pas le « corriger » en
 *  boutique. On exige un mot de logiciel, pas juste « site » (tout le monde dit
 *  « fais-moi le site de ma marque »). */
const TOOL_REQUEST_RE = new RegExp(
  [
    '\\b(outil|logiciel|app|appli|application|saas|plateforme|platform|software|tool|dashboard|tableau de bord|crm|erp|extension|api)\\b',
    '\\bmarketplace\\b', '\\bplace de march[ée]\\b',
    '\\br[ée]seau social\\b', '\\bsocial network\\b',
    '(site|app|outil|plateforme)\\s+(web\\s+)?(qui|permettant de|pour)\\s+(permet|permettre|aide|g[ée]rer|cr[ée]er)',
  ].join('|'),
  'i',
);

/** appType qui transforment un business possédé en logiciel. */
const SOFTWARE_APP_TYPES = ['saas', 'dashboard', 'tool', 'productivity', 'tracker'];

const norm = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** L'idée décrit-elle un business possédé par l'utilisateur (donc soumis au
 *  garde-fou) ? Insensible au bloc de verrou et aux phrases de l'IA. */
export function isOwnedBusinessIdea(idea: string): boolean {
  const plain = stripAiTurns(stripSubjectLock(idea || ''));
  if (!plain.trim()) return false;
  if (detectOfferLevel(plain) !== 'first_party') return false;
  // L'utilisateur veut un vrai logiciel (« un outil pour créer sa marque ») :
  // c'est SON produit, on n'y touche pas.
  if (TOOL_REQUEST_RE.test(plain)) return false;
  return OWNED_BUSINESS_RE.test(plain);
}

/**
 * Liste les dérives « méta » d'un plan pour une idée de business possédé.
 * Tableau vide = plan conforme. Aucun appel modèle.
 */
export function findMetaPlanViolations(plan: PlanLike, idea: string): string[] {
  if (!plan || !isOwnedBusinessIdea(idea)) return [];
  const out: string[] = [];

  const appType = String(plan.appType || '').toLowerCase().trim();
  if (SOFTWARE_APP_TYPES.includes(appType)) out.push(`appType "${appType}" (logiciel) au lieu d'un business en direct`);

  for (const e of plan.entities || []) {
    if (META_COLLECTIONS.includes(norm(e?.collection))) out.push(`entité "${e.collection}" (gère des business, pas des produits)`);
    else if (META_TEXT_RE.test(String(e?.description || ''))) out.push(`description de l'entité "${e?.collection}" décrit un outil de création de business`);
  }

  for (const p of plan.pages || []) {
    const blob = `${p?.name || ''} ${p?.purpose || ''} ${p?.sections || ''}`;
    if (META_TEXT_RE.test(blob)) out.push(`page "${p?.name || p?.route}" décrit un outil de création/gestion de business`);
  }

  return [...new Set(out)];
}

/** Entités de repli, orientées vente en direct. */
const SAFE_ENTITIES = [
  { collection: 'products', fields: 'name:string, description:string, price:number, category:string, imageUrl:string, stock:number', description: 'les produits vendus par le business lui-même' },
  { collection: 'orders', fields: 'items:string, total:number, customerName:string, customerEmail:string, status:string, createdAt:number', description: 'commandes passées par les clients finaux' },
];

/**
 * Assainit un plan en dernier recours : retire tout ce qui transforme le
 * business en outil de création de business. Purement déterministe.
 */
export function sanitizeFirstPartyPlan<T extends PlanLike>(plan: T, idea: string): T {
  if (!plan || !isOwnedBusinessIdea(idea)) return plan;

  const appType = String(plan.appType || '').toLowerCase().trim();
  const wantsShop = /boutique|shop|store|vend|e-?commerce|magasin/i.test(stripAiTurns(stripSubjectLock(idea)));
  const nextAppType = SOFTWARE_APP_TYPES.includes(appType) ? (wantsShop ? 'ecommerce' : 'brand') : plan.appType;

  const entities = (plan.entities || []).filter(
    e => !META_COLLECTIONS.includes(norm(e?.collection)) && !META_TEXT_RE.test(String(e?.description || '')),
  );

  // Purge phrase par phrase : on garde le CRUD légitime (panier, commande,
  // configurateur) et on supprime seulement les phrases « méta ».
  const scrub = (txt?: string) => {
    if (!txt) return txt;
    const kept = txt
      .split(/(?<=[.;!?])\s+/)
      .filter(s => !META_TEXT_RE.test(s))
      .join(' ')
      .trim();
    return kept;
  };

  const pages = (plan.pages || []).map(p => {
    const sections = scrub(p?.sections);
    const purpose = scrub(p?.purpose);
    return {
      ...p,
      purpose: purpose && purpose.length > 3 ? purpose : 'Page orientée client final du business lui-même.',
      sections: sections && sections.length > 20
        ? sections
        : "Contenu orienté client final : présentation des produits/offres du business (data.list('products')), détail, ajout au panier ou prise de commande/réservation qui persiste (data.create), états loading/vide réels.",
    };
  });

  return {
    ...plan,
    appType: nextAppType,
    entities: entities.length ? entities : SAFE_ENTITIES,
    pages,
  };
}

/** Consigne de correction ajoutée au PLAN_PROMPT pour un 2e essai guidé. */
export function planCorrectionNote(violations: string[], lang = 'fr'): string {
  const list = violations.map(v => `- ${v}`).join('\n');
  if (lang.startsWith('en')) {
    return `\n\n🚨 YOUR PREVIOUS PLAN WAS REJECTED. Detected violations:\n${list}\n\nThe business belongs to the user and sells DIRECTLY to its own end customers. Never plan a tool, SaaS, dashboard, wizard or workspace that lets its visitor create or manage a brand/business. No "brands", "businesses", "clients", "projects", "business_plans" collections, no brand-creation form, no launch progress bar, no services/portfolio/quote pages. The site's visitor is a CUSTOMER who browses and buys. appType must be "ecommerce", "brand", "configurator" or "service". Re-answer with the corrected JSON only.`;
  }
  return `\n\n🚨 TON PLAN PRÉCÉDENT A ÉTÉ REJETÉ. Violations détectées :\n${list}\n\nL'entreprise appartient à l'utilisateur et vend EN DIRECT à SES clients finaux. Ne planifie JAMAIS un outil, un SaaS, un tableau de bord, un assistant ou un espace de travail qui permettrait à son visiteur de créer ou gérer une marque/entreprise. Aucune collection "brands", "marques", "businesses", "clients", "projects", "business_plans" ; aucun formulaire de création de marque ; aucune barre de progression de lancement ; aucune page "Nos services", "Portfolio", "Devis". Le visiteur du site est un CLIENT qui regarde et achète. appType doit valoir "ecommerce", "brand", "configurator" ou "service". Réponds uniquement avec le JSON corrigé.`;
}
