// ─── Plans & droits — SOURCE UNIQUE DE VÉRITÉ ────────────────────────────────
// Un abonnement doit être VRAI : ce fichier définit, pour chaque plan, les
// limites (nombre de projets, puissance IA) et les fonctionnalités réellement
// accessibles. Le serveur refuse tout ce qui n'est pas inclus dans le plan de
// l'utilisateur — le tableau comparatif de la page /plans n'est plus décoratif.
//
// Paiement : le paiement RÉEL passe par Stripe Checkout (voir ./billing.ts).
// POST /billing/checkout/plan crée la session, et seule la confirmation du
// paiement (webhook signé, ou vérification serveur→serveur de la session)
// met à jour `users.plan`. POST /plans/subscribe ne sert plus qu'à repasser
// en Free (résiliation) — il refuse les plans payants.

export type PlanKey = 'free' | 'business' | 'enterprise';

export type PlanFeature =
  | 'mobileApp'        // construction d'apps Android / iOS
  | 'autopilot'        // l'équipe IA qui travaille toute seule
  | 'reports'          // documents & rapports générés
  | 'team'             // collaborateurs sur un projet
  | 'buyCredits'       // achat de crédits supplémentaires
  | 'removeBadge'      // retirer le badge « Made with Velbaz »
  | 'prioritySupport'
  | 'apiAccess'
  | 'integrations'
  | 'sso'
  | 'dedicatedSupport'
  | 'callsSms';        // appels téléphoniques et SMS passés par l'IA

// 'velbaz2' = le modèle « Velbaz » (ex-« Velbaz 2.0 ») : le SEUL palier des
// comptes normaux depuis le 2026-10-03 (cf. PUBLIC_TIER / capTier). Il bascule
// TOUT le pipeline (code, agents, images) sur ses modèles — cf.
// agent/model-mode.ts. 'luna', 'max', 'pro', 'lite' restent réservés à l'admin.
export type TierKey = 'lite' | 'pro' | 'max' | 'luna' | 'velbaz2';

export interface PlanConfig {
  key: PlanKey;
  name: string;
  monthlyPrice: number;
  /** -1 = illimité */
  maxProjects: number;
  /** Crédits offerts à la souscription (0 = aucun) */
  monthlyCredits: number;
  features: Record<PlanFeature, boolean>;
}

const F = false, T = true;

export const PLAN_ORDER: PlanKey[] = ['free', 'business', 'enterprise'];

export const PLAN_CONFIG: Record<PlanKey, PlanConfig> = {
  free: {
    key: 'free',
    name: 'Free',
    monthlyPrice: 0,
    maxProjects: 1,
    monthlyCredits: 0,
    features: {
      mobileApp: F, autopilot: F, reports: F, team: F,
      buyCredits: F, removeBadge: F, prioritySupport: F,
      apiAccess: F, integrations: F, sso: F, dedicatedSupport: F,
      callsSms: F,
    },
  },
  business: {
    key: 'business',
    name: 'Business',
    monthlyPrice: 29,
    maxProjects: 10,
    monthlyCredits: 75_000,
    features: {
      mobileApp: T, autopilot: T, reports: T, team: T,
      buyCredits: T, removeBadge: T, prioritySupport: T,
      apiAccess: F, integrations: F, sso: F, dedicatedSupport: F,
      callsSms: T,
    },
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    monthlyPrice: 99,
    maxProjects: -1,
    monthlyCredits: 500_000,
    features: {
      mobileApp: T, autopilot: T, reports: T, team: T,
      buyCredits: T, removeBadge: T, prioritySupport: T,
      apiAccess: T, integrations: T, sso: T, dedicatedSupport: T,
      callsSms: T,
    },
  },
};

/**
 * Ramène n'importe quelle valeur stockée en base à une clé de plan connue.
 * `pro` est l'ancien nom de `business` (endpoint admin historique) ; toute
 * valeur inconnue (`banned`, null, faute de frappe…) retombe sur `free` pour
 * les DROITS — la colonne `users.plan` n'est jamais réécrite ici.
 */
export function normalizePlan(plan?: string | null): PlanKey {
  const p = String(plan || 'free').trim().toLowerCase();
  if (p === 'business' || p === 'pro' || p === 'biz') return 'business';
  if (p === 'enterprise' || p === 'ent') return 'enterprise';
  return 'free';
}

export function planConfig(plan?: string | null): PlanConfig {
  return PLAN_CONFIG[normalizePlan(plan)];
}

export function can(plan: string | null | undefined, feature: PlanFeature): boolean {
  return planConfig(plan).features[feature];
}

/** Plan le moins cher qui débloque cette fonctionnalité. */
export function requiredPlanFor(feature: PlanFeature): PlanKey {
  for (const key of PLAN_ORDER) if (PLAN_CONFIG[key].features[feature]) return key;
  return 'enterprise';
}

const FEATURE_LABEL: Record<PlanFeature, string> = {
  mobileApp: 'La création d\'applications Android / iOS',
  autopilot: 'Le mode Auto (l\'équipe IA qui travaille en autonomie)',
  reports: 'La génération de documents & rapports',
  team: 'Les collaborateurs sur un projet',
  buyCredits: 'L\'achat de crédits supplémentaires',
  removeBadge: 'Le retrait du badge « Made with Velbaz »',
  prioritySupport: 'Le support prioritaire',
  apiAccess: 'L\'accès API',
  integrations: 'Les intégrations personnalisées',
  sso: 'Le SSO',
  dedicatedSupport: 'Le support dédié',
  callsSms: 'Les appels et SMS passés par l\'IA',
};

/**
 * Message d'erreur prêt à renvoyer au client quand le plan ne couvre pas la
 * fonctionnalité. `null` = accès autorisé.
 */
export function featureGate(
  plan: string | null | undefined,
  feature: PlanFeature,
): { error: string; feature: PlanFeature; plan: PlanKey; upgradeTo: PlanKey } | null {
  if (can(plan, feature)) return null;
  const need = requiredPlanFor(feature);
  return {
    // Formulation neutre : évite tout accord de genre approximatif selon le
    // libellé de la fonctionnalité.
    error: `Fonctionnalité réservée au plan ${PLAN_CONFIG[need].name} : ${FEATURE_LABEL[feature]}. Passe au plan ${PLAN_CONFIG[need].name} pour y accéder.`,
    feature,
    plan: normalizePlan(plan),
    upgradeTo: need,
  };
}

/** Limite de projets du plan (-1 = illimité). */
export function maxProjects(plan?: string | null): number {
  return planConfig(plan).maxProjects;
}

export function projectLimitError(plan: string | null | undefined, current: number): { error: string; plan: PlanKey; upgradeTo: PlanKey; limit: number } | null {
  const cfg = planConfig(plan);
  if (cfg.maxProjects < 0 || current < cfg.maxProjects) return null;
  const next: PlanKey = cfg.key === 'free' ? 'business' : 'enterprise';
  return {
    error: `Limite du plan ${cfg.name} atteinte : ${cfg.maxProjects} projet${cfg.maxProjects > 1 ? 's' : ''}. Passe au plan ${PLAN_CONFIG[next].name} pour ${PLAN_CONFIG[next].maxProjects < 0 ? 'des projets illimités' : `${PLAN_CONFIG[next].maxProjects} projets`}.`,
    plan: cfg.key,
    upgradeTo: next,
    limit: cfg.maxProjects,
  };
}

// ─── Durée d'abonnement ──────────────────────────────────────────────────────
// Un abonnement offert depuis le panel admin, ou souscrit sur /plans, porte une
// date de fin (`users.plan_expires_at`). Passée cette date, le compte retombe
// automatiquement en Free — les droits sont calculés avec la date, la colonne
// `plan` est remise à jour au premier passage de l'utilisateur.

/** Durée par défaut d'un abonnement selon le cycle de facturation. */
export const DEFAULT_DURATION_DAYS = { monthly: 30, yearly: 365 } as const;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0); // 31 janvier + 1 mois → 28/29 février
  return d;
}

/**
 * Interprète une durée saisie à la main : `30d`, `3m`, `2 mois`, `1y`, `1 an`,
 * une date `2026-12-31` / `31-12-2026` / `31/12/2026`, ou `forever` / `illimité`
 * / `permanent` / `never` pour un abonnement sans fin.
 * `{ ok: false }` = saisie incomprise (on ne devine pas, on prévient).
 */
export function parsePlanDuration(
  input: string | null | undefined,
  from: Date = new Date(),
): { ok: true; expiresAt: Date | null } | { ok: false; error: string } {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return { ok: true, expiresAt: null };
  if (['forever', 'infini', 'illimite', 'illimité', 'permanent', 'never', 'jamais', 'lifetime', 'a vie', 'à vie'].includes(raw)) {
    return { ok: true, expiresAt: null };
  }

  // Date explicite : 2026-12-31 (ISO) ou 31/12/2026 / 31-12-2026 (FR)
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 23, 59, 59);
    if (isNaN(d.getTime())) return { ok: false, error: `Date invalide : ${input}` };
    return { ok: true, expiresAt: d };
  }
  const fr = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (fr) {
    const d = new Date(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]), 23, 59, 59);
    if (isNaN(d.getTime())) return { ok: false, error: `Date invalide : ${input}` };
    return { ok: true, expiresAt: d };
  }

  // Durée relative : 30d, 3m, 1y, "2 mois", "1 an", "45 jours"…
  const rel = raw.match(/^(\d+)\s*(d|j|jour|jours|day|days|w|s|semaine|semaines|week|weeks|m|mois|month|months|y|a|an|ans|annee|année|year|years)?$/);
  if (rel) {
    const n = Number(rel[1]);
    if (!n || n < 0) return { ok: false, error: `Durée invalide : ${input}` };
    const unit = rel[2] || 'd';
    if (/^(d|j|jour|jours|day|days)$/.test(unit)) return { ok: true, expiresAt: addDays(from, n) };
    if (/^(w|s|semaine|semaines|week|weeks)$/.test(unit)) return { ok: true, expiresAt: addDays(from, n * 7) };
    if (/^(m|mois|month|months)$/.test(unit)) return { ok: true, expiresAt: addMonths(from, n) };
    return { ok: true, expiresAt: addMonths(from, n * 12) };
  }

  return { ok: false, error: `Durée non comprise : « ${input} ». Exemples : 30d, 3m, 1y, 2026-12-31, forever.` };
}

/** L'abonnement est-il arrivé à échéance ? (pas de date = sans fin) */
export function isPlanExpired(expiresAt: Date | number | null | undefined, now: Date = new Date()): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt) * (Number(expiresAt) < 1e12 ? 1000 : 1);
  if (!ms || isNaN(ms)) return false;
  return ms <= now.getTime();
}

/** Plan réellement actif : retombe sur `free` si l'abonnement a expiré. */
export function activePlan(plan: string | null | undefined, expiresAt: Date | number | null | undefined): PlanKey {
  const key = normalizePlan(plan);
  if (key === 'free') return key;
  return isPlanExpired(expiresAt) ? 'free' : key;
}

/** Date lisible en français : « 31 décembre 2026 ». */
export function formatPlanDate(expiresAt: Date | number | null | undefined): string {
  if (expiresAt === null || expiresAt === undefined) return 'sans date de fin';
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt) * (Number(expiresAt) < 1e12 ? 1000 : 1);
  if (!ms || isNaN(ms)) return 'sans date de fin';
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

const TIER_RANK: Record<TierKey, number> = { lite: 0, pro: 1, max: 2, luna: 3, velbaz2: 4 };

/**
 * [2026-10-03] Le modèle « Velbaz » (ex-« Velbaz 2.0 » : GPT 6 Luna + images
 * Nano Banana 2, cf. agent/model-mode.ts) est LE modèle de tout le monde, Free
 * compris. Un compte normal n'a PLUS le choix du modèle — ni dans le chat, ni
 * à l'accueil, ni par une requête forgée : capTier le ramène toujours ici.
 */
export const PUBLIC_TIER: TierKey = 'velbaz2';

/**
 * Paliers que SEUL un admin peut choisir. L'admin garde tout : Velbaz (le
 * palier public), GPT 6 Luna (essai interne) et les anciens Max / Pro / Lite.
 */
export const ADMIN_ONLY_TIERS: readonly TierKey[] = ['luna', 'max', 'pro', 'lite'];

/**
 * Palier effectif d'une requête. C'est la SEULE porte d'entrée, côté serveur :
 * le front cache le menu, mais ça ne protège rien — n'importe qui peut poster
 * `tier: 'max'` à la main.
 *  - compte normal (tous plans) → toujours `PUBLIC_TIER`, quoi qu'il demande ;
 *  - admin → le palier demandé, sans plafond de plan ; `PUBLIC_TIER` si le
 *    palier est absent ou inconnu.
 * `plan` n'influe plus sur le modèle (gardé pour la signature des appelants).
 */
export function capTier(
  tier: string | undefined | null,
  _plan?: string | null,
  opts?: { admin?: boolean },
): TierKey {
  if (!opts?.admin) return PUBLIC_TIER;
  const asked = (String(tier || '').toLowerCase() as TierKey);
  return TIER_RANK[asked] === undefined ? PUBLIC_TIER : asked;
}

// ─── Facturation : packs de crédits & cycle annuel ───────────────────────────
// SOURCE UNIQUE DE VÉRITÉ des montants réellement facturés par Stripe
// (./billing.ts construit les sessions Checkout depuis ces valeurs — aucun
// produit ni prix à créer à la main dans le dashboard Stripe).

/** 12 mois payés 10 → 2 mois offerts (≈ -17 %). */
export const YEARLY_FACTOR = 10;

export interface CreditPackage {
  id: string;
  /** Crédits ajoutés au solde après paiement confirmé. */
  tokens: number;
  /** Prix en euros (TTC affiché). */
  price: number;
  label: string;
}

/** 1 € = 1000 crédits. */
export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: 'credits_4990', tokens: 4990, price: 4.99, label: '4 990 Crédits' },
  { id: 'credits_9990', tokens: 9990, price: 9.99, label: '9 990 Crédits' },
  { id: 'credits_24990', tokens: 24990, price: 24.99, label: '24 990 Crédits' },
  { id: 'credits_49990', tokens: 49990, price: 49.99, label: '49 990 Crédits' },
];

export function creditPackage(id: string | null | undefined): CreditPackage | null {
  return CREDIT_PACKAGES.find((p) => p.id === String(id || '')) || null;
}

export type BillingCycle = 'monthly' | 'yearly';

export function normalizeBillingCycle(v: unknown): BillingCycle {
  return String(v || '').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';
}

/** Prix facturé pour un plan sur un cycle, en euros. 0 = gratuit. */
export function planPrice(plan: PlanKey, billing: BillingCycle): number {
  const monthly = PLAN_CONFIG[plan].monthlyPrice;
  if (monthly <= 0) return 0;
  return billing === 'yearly' ? monthly * YEARLY_FACTOR : monthly;
}

/** Montant Stripe (centimes) pour un plan sur un cycle. */
export function planPriceCents(plan: PlanKey, billing: BillingCycle): number {
  return Math.round(planPrice(plan, billing) * 100);
}

/** Crédits inclus dans un cycle d'abonnement (annuel = 12 mois d'un coup). */
export function planCreditsForCycle(plan: PlanKey, billing: BillingCycle): number {
  const c = PLAN_CONFIG[plan].monthlyCredits;
  if (c <= 0) return 0;
  return billing === 'yearly' ? c * 12 : c;
}
