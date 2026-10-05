// ─── Demandes d'argent de l'IA (popup dans le chat) ──────────────────────────
//
// L'IA émet un bloc [MONEY_REQUEST]{…}[/MONEY_REQUEST] quand elle a besoin
// d'argent pour faire avancer l'entreprise. Ce module est le SEUL endroit qui
// crée, décide et encaisse ces demandes.
//
// ─────────────────────────────────────────────────────────────────────────────
// GARANTIE « l'argent va au bon endroit, jamais dans le vide » — comment :
//
//  1. FIGÉ À LA CRÉATION. Montant, devise, cadence, canal, bénéficiaire et
//     poste de dépense sont écrits une seule fois, côté serveur, à partir du
//     bloc de l'IA. Aucune route ne les modifie ensuite (pas d'UPDATE sur ces
//     colonnes dans tout ce fichier — vérifiable d'un coup d'œil).
//  2. LE NAVIGATEUR N'EST JAMAIS CRU. /pay ne lit aucun montant dans le corps
//     de la requête : il relit la ligne en base par son id. Un JSON trafiqué
//     dans le chat ne peut pas changer ce qui est payé.
//  3. PAIEMENT CLOUÉ À LA DEMANDE. La session Stripe porte
//     metadata.moneyRequestId ; au retour (webhook ou confirm) on retrouve la
//     demande PAR CET ID, et on revérifie que la session correspond bien à
//     celle qu'on avait créée (stripeSessionId) et au bon utilisateur.
//     → impossible de créditer une autre demande, une autre entreprise, ou un
//       autre compte.
//  4. UN SEUL CRÉDIT. Verrou par UPDATE conditionnel (… WHERE paid_at IS NULL)
//     + index unique sur la clé de déduplication du grand livre. Webhook et
//     page de retour peuvent arriver ensemble : un seul passe.
//  5. ARGENT FLÉCHÉ. Le crédit entre au grand livre avec moneyRequestId +
//     purpose. `spendBudget()` refuse toute dépense sans solde disponible sur
//     ce poste → l'argent d'un budget pub ne peut pas partir ailleurs.
//  6. CANAL EXTERNE = ZÉRO ENCAISSEMENT VELBAZ. Aucune session Stripe n'est
//     créée : on affiche la destination figée et on enregistre une trace quand
//     l'utilisateur confirme avoir payé le tiers.
//  7. PLAFONDS SERVEUR. 500 € par demande, 2 000 € glissants sur 30 jours.
//     Dépassement = demande refusée à la création, rien n'est affiché à payer.
// ─────────────────────────────────────────────────────────────────────────────

import type Stripe from 'stripe';
import type { Hono } from 'hono';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from './database/index';
import * as schema from './database/schema';
import { getStripeClient, isStripeConfigured } from './stripe-connect';

const CURRENCY = 'eur';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Plafonds serveur — non contournables par l'IA ni par le navigateur. */
export const MAX_PER_REQUEST = 500;
export const MAX_PER_30_DAYS = 2000;

export const CHANNELS = ['budget', 'external'] as const;
export const CADENCES = ['once', 'weekly', 'monthly', 'quarterly'] as const;
export type MoneyChannel = (typeof CHANNELS)[number];
export type MoneyCadence = (typeof CADENCES)[number];

const CADENCE_LABEL: Record<MoneyCadence, string> = {
  once: 'une seule fois',
  weekly: 'par semaine',
  monthly: 'par mois',
  quarterly: 'par trimestre',
};

/** Cadence → intervalle Stripe (abonnement réel côté canal budget). */
function stripeInterval(cadence: MoneyCadence): { interval: 'week' | 'month'; interval_count: number } | null {
  switch (cadence) {
    case 'weekly': return { interval: 'week', interval_count: 1 };
    case 'monthly': return { interval: 'month', interval_count: 1 };
    case 'quarterly': return { interval: 'month', interval_count: 3 };
    default: return null;
  }
}

const NOT_CONFIGURED = {
  error: 'Les paiements ne sont pas encore configurés. Ajoute la clé secrète Stripe dans l\'Admin Panel.',
  code: 'stripe_not_configured' as const,
};

function stripeOrNull(): Stripe | null {
  if (!isStripeConfigured()) return null;
  try { return getStripeClient(); } catch { return null; }
}

function originOf(c: any): string {
  const proto = c.req.header('x-forwarded-proto');
  const host = c.req.header('x-forwarded-host') || c.req.header('host');
  if (proto && host) return `${proto}://${host}`;
  try { return new URL(c.req.url).origin; } catch { return ''; }
}

function idOf(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.id ? String(v.id) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clean(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ─────────────────────────────────────────────────────────────────────────────
// Grand livre du budget — le solde est TOUJOURS une somme, jamais un compteur
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetEventInput {
  companyId: string;
  type: 'topup' | 'spend' | 'refund' | 'adjustment' | 'external_paid';
  /** Positif pour une entrée, positif aussi pour `spend` (le signe est appliqué ici). */
  amount: number;
  currency?: string;
  moneyRequestId?: string | null;
  purpose?: string | null;
  label?: string | null;
  meta?: unknown;
  /** Clé stable (ex. id de facture Stripe) : rejeu = une seule ligne. */
  dedupeKey?: string | null;
}

/**
 * Détecte une violation de contrainte d'unicité SQLite.
 * Drizzle enveloppe l'erreur libsql dans une DrizzleQueryError dont le message
 * n'est que la requête : il FAUT descendre la chaîne des `cause`, sinon un
 * rejeu ressort en erreur 500 au lieu d'être ignoré.
 */
function isUniqueViolation(e: any): boolean {
  for (let cur = e, depth = 0; cur && depth < 6; cur = cur.cause, depth++) {
    const code = String(cur?.code || cur?.rawCode || '');
    const msg = String(cur?.message || '');
    if (code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
    if (/UNIQUE constraint failed/i.test(msg)) return true;
  }
  return false;
}

/**
 * Écrit une ligne au grand livre. Renvoie false si la clé de déduplication
 * existe déjà (l'index unique fait le verrou) — donc un rejeu ne crédite jamais
 * deux fois.
 */
export async function recordBudgetEvent(input: BudgetEventInput): Promise<boolean> {
  const signed = input.type === 'spend' ? -Math.abs(input.amount) : input.amount;
  try {
    await db.insert(schema.companyBudgetEvents).values({
      id: uuidv4(),
      companyId: input.companyId,
      type: input.type,
      amount: round2(signed),
      currency: (input.currency || CURRENCY).toLowerCase(),
      moneyRequestId: input.moneyRequestId ?? null,
      purpose: input.purpose ?? null,
      label: input.label ?? null,
      meta: input.meta === undefined ? null : JSON.stringify(input.meta),
      dedupeKey: input.dedupeKey ?? null,
    });
    return true;
  } catch (e: any) {
    // Violation d'unicité = rejeu déjà traité : ce n'est pas une erreur.
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/** Solde global du budget de l'entreprise (somme du grand livre). */
export async function budgetBalance(companyId: string): Promise<number> {
  const rows = await db.select({ amount: schema.companyBudgetEvents.amount, type: schema.companyBudgetEvents.type })
    .from(schema.companyBudgetEvents)
    .where(eq(schema.companyBudgetEvents.companyId, companyId))
    .all().catch(() => [] as { amount: number; type: string }[]);
  // `external_paid` est une trace informative : Velbaz n'a jamais eu cet argent.
  return round2(rows.filter((r) => r.type !== 'external_paid').reduce((s, r) => s + Number(r.amount || 0), 0));
}

/** Solde disponible sur UN poste de dépense (argent fléché). */
export async function budgetBalanceForPurpose(companyId: string, purpose: string): Promise<number> {
  const rows = await db.select({ amount: schema.companyBudgetEvents.amount, type: schema.companyBudgetEvents.type })
    .from(schema.companyBudgetEvents)
    .where(and(
      eq(schema.companyBudgetEvents.companyId, companyId),
      eq(schema.companyBudgetEvents.purpose, purpose),
    ))
    .all().catch(() => [] as { amount: number; type: string }[]);
  return round2(rows.filter((r) => r.type !== 'external_paid').reduce((s, r) => s + Number(r.amount || 0), 0));
}

/**
 * Dépense du budget. REFUSE si l'argent n'est pas là, ou s'il n'est pas fléché
 * sur ce poste → un crédit « budget pub Meta » ne peut pas servir à autre chose.
 */
export async function spendBudget(input: {
  companyId: string;
  amount: number;
  purpose: string;
  label: string;
  moneyRequestId?: string | null;
  dedupeKey?: string | null;
  meta?: unknown;
}): Promise<{ ok: true; remaining: number; already?: boolean } | { ok: false; error: string; code: string; available: number }> {
  const amount = Math.abs(round2(input.amount));
  if (!amount) return { ok: false, error: 'Montant nul', code: 'invalid_amount', available: 0 };
  const onPurpose = await budgetBalanceForPurpose(input.companyId, input.purpose);
  if (onPurpose < amount) {
    return {
      ok: false,
      code: 'insufficient_earmarked_budget',
      error: `Budget insuffisant sur le poste « ${input.purpose} » : ${onPurpose.toFixed(2)} € disponibles, ${amount.toFixed(2)} € demandés.`,
      available: onPurpose,
    };
  }
  const written = await recordBudgetEvent({
    companyId: input.companyId,
    type: 'spend',
    amount,
    moneyRequestId: input.moneyRequestId ?? null,
    purpose: input.purpose,
    label: input.label,
    dedupeKey: input.dedupeKey ?? null,
    meta: input.meta,
  });
  // `written === false` → même dedupeKey déjà passée : la dépense a déjà été
  // enregistrée, on ne la compte pas une deuxième fois.
  if (!written) return { ok: true, remaining: onPurpose, already: true };
  return { ok: true, remaining: round2(onPurpose - amount) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Création d'une demande à partir du bloc de l'IA
// ─────────────────────────────────────────────────────────────────────────────

export interface MoneyRequestDraft {
  channel?: string;
  amount?: number | string;
  currency?: string;
  cadence?: string;
  title?: string;
  reason?: string;
  detail?: string;
  expectedReturn?: string;
  purpose?: string;
  payee?: string;
  payUrl?: string;
  payInstructions?: string;
}

export type CreateResult =
  | { ok: true; row: any }
  | { ok: false; error: string; code: string };

/** Total engagé sur les 30 derniers jours (demandes réellement payées). */
async function paidLast30Days(companyId: string): Promise<number> {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const rows = await db.select({ amount: schema.moneyRequests.amountPaid })
    .from(schema.moneyRequests)
    .where(and(
      eq(schema.moneyRequests.companyId, companyId),
      gte(schema.moneyRequests.paidAt, since),
    ))
    .all().catch(() => [] as { amount: number | null }[]);
  return round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
}

/**
 * Valide et PERSISTE une demande. Tout ce qui suit est figé : plus aucune
 * route de ce fichier ne réécrit montant / canal / destination.
 */
export async function createMoneyRequest(
  draft: MoneyRequestDraft,
  ctx: { companyId: string; userId: string; sessionId?: string | null; agentRole?: string | null },
): Promise<CreateResult> {
  const channel = String(draft.channel || '').toLowerCase() as MoneyChannel;
  if (!CHANNELS.includes(channel)) return { ok: false, error: 'Canal invalide', code: 'bad_channel' };

  const cadenceRaw = String(draft.cadence || 'once').toLowerCase() as MoneyCadence;
  const cadence: MoneyCadence = CADENCES.includes(cadenceRaw) ? cadenceRaw : 'once';

  const amount = round2(Number(draft.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Montant invalide', code: 'bad_amount' };
  if (amount > MAX_PER_REQUEST) {
    return { ok: false, error: `Plafond dépassé : ${MAX_PER_REQUEST} € maximum par demande.`, code: 'over_request_cap' };
  }

  const title = clean(draft.title, 120);
  const reason = clean(draft.reason, 600);
  if (!title || !reason) return { ok: false, error: 'Titre et raison obligatoires', code: 'missing_reason' };

  // Canal externe : la destination doit être identifiable, sinon on refuse —
  // on ne demande JAMAIS de payer sans savoir à qui.
  const payee = clean(draft.payee, 160);
  const payUrl = clean(draft.payUrl, 500);
  const payInstructions = clean(draft.payInstructions, 600);
  if (channel === 'external') {
    if (!payee) return { ok: false, error: 'Bénéficiaire obligatoire pour un paiement externe', code: 'missing_payee' };
    if (!payUrl && !payInstructions) {
      return { ok: false, error: 'Lien ou instructions de paiement obligatoires', code: 'missing_pay_target' };
    }
    if (payUrl && !/^https:\/\//i.test(payUrl)) {
      return { ok: false, error: 'Le lien de paiement doit être en https', code: 'bad_pay_url' };
    }
  }

  // Canal budget : le poste de dépense est obligatoire — c'est lui qui flèche
  // l'argent et empêche qu'il serve à autre chose.
  const purpose = clean(draft.purpose, 60).toLowerCase().replace(/[^a-z0-9_]+/g, '_') || null;
  if (channel === 'budget' && !purpose) {
    return { ok: false, error: 'Poste de dépense obligatoire pour un crédit de budget', code: 'missing_purpose' };
  }

  // Plafond glissant : on compte l'engagé réel + cette demande.
  const already = await paidLast30Days(ctx.companyId);
  if (channel === 'budget' && already + amount > MAX_PER_30_DAYS) {
    return {
      ok: false,
      code: 'over_monthly_cap',
      error: `Plafond dépassé : ${MAX_PER_30_DAYS} € maximum sur 30 jours (déjà ${already.toFixed(2)} €).`,
    };
  }

  const id = uuidv4();
  await db.insert(schema.moneyRequests).values({
    id,
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId ?? null,
    agentRole: ctx.agentRole ?? null,
    channel,
    amount,
    currency: CURRENCY,
    cadence,
    title,
    reason,
    detail: clean(draft.detail, 2000) || null,
    expectedReturn: clean(draft.expectedReturn, 300) || null,
    purpose,
    payee: channel === 'external' ? payee : null,
    payUrl: channel === 'external' ? (payUrl || null) : null,
    payInstructions: channel === 'external' ? (payInstructions || null) : null,
    status: 'pending',
  });

  const row = await db.select().from(schema.moneyRequests).where(eq(schema.moneyRequests.id, id)).get();
  console.log(`[money-request] créée ${id} — ${channel} ${amount} € ${cadence} (${title})`);
  return { ok: true, row };
}

const BLOCK_RE = /\[MONEY_REQUEST\]([\s\S]*?)\[\/MONEY_REQUEST\]/g;

/**
 * Coupe une ouverture de bloc restée sans fermeture (réponse tronquée en
 * streaming) : on ne montre jamais un demi-bloc à l'écran.
 */
function dropUnterminatedBlock(text: string): string {
  const open = text.lastIndexOf('[MONEY_REQUEST]');
  if (open < 0) return text;
  const close = text.indexOf('[/MONEY_REQUEST]', open);
  return close < 0 ? text.slice(0, open) : text;
}

/** Retire tout bloc [MONEY_REQUEST] (y compris un bloc tronqué en streaming). */
export function stripMoneyRequestBlocks(text: string): string {
  return dropUnterminatedBlock(text.replace(BLOCK_RE, '')).trim();
}

/**
 * Remplace chaque bloc émis par l'IA par un bloc VALIDÉ ET PERSISTÉ, dont le
 * JSON ne contient plus que l'id et l'état officiel de la demande.
 *
 * C'est la charnière de sécurité : ce que l'IA a écrit n'est qu'une INTENTION.
 * Après ce passage, le seul montant et la seule destination qui existent sont
 * ceux de la ligne en base. Une demande invalide (plafond, destination
 * inconnue, montant absurde) n'est pas affichée du tout — on ne montre jamais
 * un bouton « Payer » qui ne mène nulle part.
 */
export async function applyMoneyRequestBlocks(
  text: string,
  ctx: { companyId: string; userId: string; sessionId?: string | null; agentRole?: string | null },
): Promise<string> {
  if (!ctx.companyId || !ctx.userId) return stripMoneyRequestBlocks(text);

  // Une seule demande à la fois : s'il y en a déjà une en attente, on
  // n'en crée pas une deuxième.
  const pending = await db.select({ id: schema.moneyRequests.id })
    .from(schema.moneyRequests)
    .where(and(
      eq(schema.moneyRequests.companyId, ctx.companyId),
      eq(schema.moneyRequests.status, 'pending'),
    ))
    .get().catch(() => null);

  const matches = [...text.matchAll(BLOCK_RE)];
  let out = text;
  let created = 0;

  for (const m of matches) {
    let draft: MoneyRequestDraft | null = null;
    try { draft = JSON.parse(m[1].trim()); } catch { draft = null; }

    let replacement = '';
    if (!draft) {
      console.warn('[money-request] bloc JSON invalide ignoré');
    } else if (pending || created > 0) {
      console.warn('[money-request] demande ignorée : une demande est déjà en attente');
    } else {
      const res = await createMoneyRequest(draft, ctx);
      if (res.ok) {
        created++;
        replacement = `[MONEY_REQUEST]${JSON.stringify(publicMoneyRequest(res.row))}[/MONEY_REQUEST]`;
      } else {
        console.warn(`[money-request] refusée (${res.code}): ${res.error}`);
      }
    }
    out = out.replace(m[0], replacement);
  }

  // Reste-t-il une ouverture sans fermeture (bloc coupé en streaming) ?
  // On ne coupe qu'à partir de là, pour ne pas détruire les blocs validés
  // qu'on vient d'écrire juste au-dessus.
  return dropUnterminatedBlock(out).replace(/\n{3,}/g, '\n\n').trim();
}

/** Vue publique d'une demande (ce que le front a le droit de connaître). */
export function publicMoneyRequest(r: any) {
  return {
    id: r.id,
    companyId: r.companyId,
    channel: r.channel,
    amount: Number(r.amount || 0),
    currency: r.currency || CURRENCY,
    cadence: r.cadence || 'once',
    cadenceLabel: CADENCE_LABEL[(r.cadence || 'once') as MoneyCadence] || 'une seule fois',
    title: r.title,
    reason: r.reason,
    detail: r.detail || null,
    expectedReturn: r.expectedReturn || null,
    purpose: r.purpose || null,
    payee: r.payee || null,
    payUrl: r.payUrl || null,
    payInstructions: r.payInstructions || null,
    status: r.status,
    refusedReason: r.refusedReason || null,
    counterAmount: r.counterAmount == null ? null : Number(r.counterAmount),
    counterNote: r.counterNote || null,
    amountPaid: Number(r.amountPaid || 0),
    paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
    decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    maxPerRequest: MAX_PER_REQUEST,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Encaissement — IDEMPOTENT, et clouée à la demande par son id
// ─────────────────────────────────────────────────────────────────────────────

function isSessionPaid(session: any): boolean {
  const ps = String(session?.payment_status || '');
  if (ps === 'paid' || ps === 'no_payment_required') return true;
  return String(session?.status || '') === 'complete' && ps !== 'unpaid';
}

export type ApplyMoneyResult =
  | { ok: true; already: boolean; requestId: string; amount: number; balance: number }
  | { ok: false; error: string; code?: string };

/**
 * Applique une session Checkout payée à SA demande.
 * Appelable par le webhook signé ET par la page de retour : le verrou est un
 * UPDATE conditionnel sur `paid_at`, donc une seule voie crédite.
 */
export async function applyMoneyRequestSession(session: any): Promise<ApplyMoneyResult> {
  const sessionId = idOf(session);
  const requestId = String(session?.metadata?.moneyRequestId || '');
  if (!sessionId) return { ok: false, error: 'Session Stripe invalide', code: 'bad_session' };
  if (!requestId) return { ok: false, error: 'Session sans demande associée', code: 'no_request' };

  const row = await db.select().from(schema.moneyRequests)
    .where(eq(schema.moneyRequests.id, requestId)).get().catch(() => null);
  if (!row) return { ok: false, error: 'Demande introuvable', code: 'not_found' };

  // La session doit être EXACTEMENT celle que /pay a créée et clouée à la
  // demande. Pas de session enregistrée = aucun paiement n'a été ouvert pour
  // cette demande → on refuse. C'est la barrière contre « payé au mauvais
  // endroit » : ni une session d'une autre demande, ni une session fabriquée
  // ailleurs ne peut créditer ce budget.
  if (!row.stripeSessionId) {
    console.warn(`[money-request] ${requestId}: aucune session ouverte, session ${sessionId} ignorée`);
    return { ok: false, error: 'Aucun paiement ouvert pour cette demande', code: 'session_mismatch' };
  }
  if (row.stripeSessionId !== sessionId) {
    console.warn(`[money-request] session ${sessionId} ≠ session enregistrée pour ${requestId} — ignorée`);
    return { ok: false, error: 'Session non rattachée à cette demande', code: 'session_mismatch' };
  }
  if (row.channel !== 'budget') {
    return { ok: false, error: 'Cette demande n\'encaisse rien via Velbaz', code: 'not_billable' };
  }
  // Devise : on ne crédite un budget en euros qu'avec des euros.
  const sessCur = String(session?.currency || '').toLowerCase();
  const rowCur = String(row.currency || CURRENCY).toLowerCase();
  if (sessCur && sessCur !== rowCur) {
    console.warn(`[money-request] ${requestId}: devise ${sessCur} ≠ ${rowCur} — ignorée`);
    return { ok: false, error: 'Devise incohérente avec la demande', code: 'currency_mismatch' };
  }
  if (!isSessionPaid(session)) {
    return { ok: false, error: `Paiement non confirmé (${session?.payment_status || session?.status || 'inconnu'})`, code: 'not_paid' };
  }

  // Le montant crédité est celui de la DEMANDE, pas celui du navigateur. On
  // journalise tout écart avec Stripe au lieu de l'avaler en silence.
  const expected = round2(Number(row.amount || 0));
  const charged = round2(Number(session?.amount_total ?? 0) / 100);
  if (charged && Math.abs(charged - expected) > 0.01) {
    console.warn(`[money-request] ${requestId}: Stripe a encaissé ${charged} € pour ${expected} € demandés`);
  }
  const credited = charged || expected;

  const claim: any = await db.update(schema.moneyRequests)
    .set({
      status: 'paid',
      paidAt: new Date(),
      decidedAt: new Date(),
      amountPaid: credited,
      stripeSubscriptionId: idOf(session?.subscription) ?? row.stripeSubscriptionId ?? null,
    })
    .where(and(eq(schema.moneyRequests.id, requestId), isNull(schema.moneyRequests.paidAt)));
  const claimed = Number(claim?.rowsAffected ?? claim?.changes ?? 0) > 0;

  if (!claimed) {
    return { ok: true, already: true, requestId, amount: 0, balance: await budgetBalance(row.companyId) };
  }

  // Argent fléché : moneyRequestId + purpose. Clé de dédup = la session.
  await recordBudgetEvent({
    companyId: row.companyId,
    type: 'topup',
    amount: credited,
    currency: row.currency || CURRENCY,
    moneyRequestId: requestId,
    purpose: row.purpose,
    label: row.title,
    dedupeKey: `mr_session_${sessionId}`,
    meta: {
      sessionId,
      cadence: row.cadence,
      declaredAmount: expected,
      ...(charged && Math.abs(charged - expected) > 0.01 ? { mismatch: { charged, expected } } : {}),
    },
  });

  const balance = await budgetBalance(row.companyId);
  console.log(`[money-request] ${requestId} payée : +${credited} € sur « ${row.purpose} » (solde ${balance} €)`);
  return { ok: true, already: false, requestId, amount: credited, balance };
}

/**
 * Renouvellement d'un abonnement lié à une demande (cadence récurrente).
 * Chaque facture payée crédite à nouveau le MÊME poste de dépense, une seule
 * fois par facture (dédup sur l'id de facture).
 */
export async function applyMoneyRequestInvoice(invoice: any): Promise<ApplyMoneyResult> {
  const subId = idOf(invoice?.subscription)
    || idOf(invoice?.parent?.subscription_details?.subscription)
    || idOf(invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription);
  if (!subId) return { ok: false, error: 'Facture sans abonnement', code: 'no_subscription' };

  const row = await db.select().from(schema.moneyRequests)
    .where(eq(schema.moneyRequests.stripeSubscriptionId, subId)).get().catch(() => null);
  if (!row) return { ok: false, error: 'Aucune demande pour cet abonnement', code: 'not_found' };

  const invoiceId = idOf(invoice) || '';
  const paid = round2(Number(invoice?.amount_paid ?? invoice?.total ?? 0) / 100) || Number(row.amount || 0);

  const written = await recordBudgetEvent({
    companyId: row.companyId,
    type: 'topup',
    amount: paid,
    currency: row.currency || CURRENCY,
    moneyRequestId: row.id,
    purpose: row.purpose,
    label: `${row.title} — renouvellement`,
    dedupeKey: `mr_invoice_${invoiceId}`,
    meta: { invoiceId, subscriptionId: subId },
  });
  if (!written) {
    return { ok: true, already: true, requestId: row.id, amount: 0, balance: await budgetBalance(row.companyId) };
  }

  await db.update(schema.moneyRequests)
    .set({ amountPaid: round2(Number(row.amountPaid || 0) + paid) })
    .where(eq(schema.moneyRequests.id, row.id)).catch(() => {});

  const balance = await budgetBalance(row.companyId);
  console.log(`[money-request] ${row.id} renouvelée : +${paid} € (solde ${balance} €)`);
  return { ok: true, already: false, requestId: row.id, amount: paid, balance };
}

/** Une session Checkout appartient-elle à une demande d'argent ? */
export function isMoneyRequestSession(session: any): boolean {
  return String(session?.metadata?.kind || '') === 'money_request'
    && !!String(session?.metadata?.moneyRequestId || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

interface Deps {
  getUser: (c: any) => Promise<any>;
}

/**
 * Charge une demande et vérifie que l'appelant est bien celui qui doit payer.
 * 404 (et pas 403) si ce n'est pas lui : on ne révèle pas l'existence de la
 * demande d'un autre compte.
 */
async function loadOwned(c: any, deps: Deps): Promise<
  | { ok: true; user: any; row: any }
  | { ok: false; res: Response }
> {
  const user = await deps.getUser(c);
  if (!user) return { ok: false, res: c.json({ error: 'Unauthorized' }, 401) };
  const id = String(c.req.param('id') || '');
  if (!id) return { ok: false, res: c.json({ error: 'Id manquant' }, 400) };
  const row = await db.select().from(schema.moneyRequests)
    .where(eq(schema.moneyRequests.id, id)).get().catch(() => null);
  if (!row) return { ok: false, res: c.json({ error: 'Demande introuvable' }, 404) };
  if (String(row.userId) !== String(user.id)) {
    return { ok: false, res: c.json({ error: 'Demande introuvable' }, 404) };
  }
  return { ok: true, user, row };
}

export function registerMoneyRequestRoutes(app: Hono<any>, deps: Deps) {
  // ── État d'une demande ────────────────────────────────────────────────────
  app.get('/money-requests/:id', async (c) => {
    const got = await loadOwned(c, deps);
    if (!got.ok) return got.res;
    return c.json({ ok: true, request: publicMoneyRequest(got.row) });
  });

  // ── PAYER (canal budget) : crée la session Stripe Checkout ────────────────
  // Aucun montant n'est lu dans le corps de la requête : tout vient de la base.
  app.post('/money-requests/:id/pay', async (c) => {
    const got = await loadOwned(c, deps);
    if (!got.ok) return got.res;
    const { user, row } = got;

    if (row.channel !== 'budget') {
      return c.json({ error: 'Cette demande se paie directement au bénéficiaire, pas via Velbaz.', code: 'external_channel' }, 400);
    }
    if (row.status === 'paid' || row.paidAt) {
      return c.json({ ok: true, already: true, request: publicMoneyRequest(row) });
    }
    if (row.status === 'refused' || row.status === 'canceled' || row.status === 'expired') {
      return c.json({ error: 'Cette demande n\'est plus active.', code: 'not_active' }, 409);
    }

    const stripe = stripeOrNull();
    if (!stripe) return c.json(NOT_CONFIGURED, 503);

    // Re-contrôle du plafond glissant au moment de payer (le temps a pu passer).
    const already = await paidLast30Days(row.companyId);
    if (already + Number(row.amount || 0) > MAX_PER_30_DAYS) {
      return c.json({
        error: `Plafond de ${MAX_PER_30_DAYS} € sur 30 jours atteint (déjà ${already.toFixed(2)} €).`,
        code: 'over_monthly_cap',
      }, 409);
    }

    const amountCents = Math.round(Number(row.amount) * 100);
    const recurring = stripeInterval(row.cadence as MoneyCadence);
    const origin = String((await c.req.json().catch(() => ({} as any)))?.origin || originOf(c) || '').replace(/\/+$/, '');
    const back = `${origin}/chat/${row.companyId}`;
    const metadata = {
      app: 'velbaz',
      kind: 'money_request',
      moneyRequestId: String(row.id),
      companyId: String(row.companyId),
      userId: String(user.id),
      purpose: String(row.purpose || ''),
    };

    try {
      const session = await stripe.checkout.sessions.create({
        mode: recurring ? 'subscription' : 'payment',
        client_reference_id: String(user.id),
        customer_email: user.stripeCustomerId ? undefined : (user.email || undefined),
        customer: user.stripeCustomerId ? String(user.stripeCustomerId) : undefined,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: (row.currency || CURRENCY).toLowerCase(),
            unit_amount: amountCents,
            ...(recurring ? { recurring } : {}),
            product_data: {
              name: `${row.title}`.slice(0, 120),
              description: `Budget ${row.purpose || 'entreprise'} — ${String(row.reason || '').slice(0, 180)}`,
            },
          },
        }],
        success_url: `${back}?mr=${row.id}&mr_status=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${back}?mr=${row.id}&mr_status=cancel`,
        metadata,
        ...(recurring ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
      });

      // On cloue la session à la demande. Si une session existait déjà, on la
      // remplace (l'ancienne devient invalide pour créditer : voir le contrôle
      // `session_mismatch` dans applyMoneyRequestSession).
      await db.update(schema.moneyRequests)
        .set({ stripeSessionId: session.id })
        .where(eq(schema.moneyRequests.id, row.id));

      return c.json({ ok: true, url: session.url, sessionId: session.id, amount: Number(row.amount), currency: row.currency });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 300);
      console.error('[money-request] checkout échoué:', msg);
      return c.json({ error: `Stripe: ${msg}`, code: 'stripe_error' }, 502);
    }
  });

  // ── Retour de Checkout : on relit la session chez Stripe ──────────────────
  // Filet de sécurité si le webhook n'est pas configuré. Serveur → Stripe,
  // donc le navigateur ne peut rien affirmer sur le paiement.
  app.post('/money-requests/:id/confirm', async (c) => {
    const got = await loadOwned(c, deps);
    if (!got.ok) return got.res;
    const { user, row } = got;
    const body = await c.req.json().catch(() => ({} as any));
    const sessionId = String(body?.sessionId || row.stripeSessionId || '').trim();
    if (!sessionId.startsWith('cs_')) return c.json({ error: 'sessionId invalide' }, 400);
    if (row.stripeSessionId && row.stripeSessionId !== sessionId) {
      return c.json({ error: 'Session non rattachée à cette demande', code: 'session_mismatch' }, 409);
    }

    const stripe = stripeOrNull();
    if (!stripe) return c.json(NOT_CONFIGURED, 503);

    let session: any;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (e: any) {
      return c.json({ error: `Stripe: ${String(e?.message || e).slice(0, 200)}`, code: 'stripe_error' }, 502);
    }

    const owner = String(session?.metadata?.userId || session?.client_reference_id || '');
    if (owner && owner !== String(user.id)) return c.json({ error: 'Session d\'un autre compte' }, 403);
    if (String(session?.metadata?.moneyRequestId || '') !== String(row.id)) {
      return c.json({ error: 'Session non rattachée à cette demande', code: 'session_mismatch' }, 409);
    }

    const res = await applyMoneyRequestSession(session);
    if (!res.ok) return c.json(res, res.code === 'not_paid' ? 402 : 400);
    const fresh = await db.select().from(schema.moneyRequests).where(eq(schema.moneyRequests.id, row.id)).get();
    return c.json({ ok: true, request: publicMoneyRequest(fresh), balance: res.balance });
  });

  // ── Canal externe : l'utilisateur confirme avoir payé le tiers ────────────
  // Velbaz n'encaisse rien ici : on enregistre une TRACE (montant 0 au solde)
  // pour que l'IA sache qu'elle peut continuer.
  app.post('/money-requests/:id/mark-external-paid', async (c) => {
    const got = await loadOwned(c, deps);
    if (!got.ok) return got.res;
    const { row } = got;
    if (row.channel !== 'external') {
      return c.json({ error: 'Cette demande se paie via Velbaz.', code: 'budget_channel' }, 400);
    }
    if (row.paidAt) return c.json({ ok: true, already: true, request: publicMoneyRequest(row) });

    const claim: any = await db.update(schema.moneyRequests)
      .set({ status: 'paid', paidAt: new Date(), decidedAt: new Date(), amountPaid: Number(row.amount || 0) })
      .where(and(eq(schema.moneyRequests.id, row.id), isNull(schema.moneyRequests.paidAt)));
    const claimed = Number(claim?.rowsAffected ?? claim?.changes ?? 0) > 0;
    if (claimed) {
      await recordBudgetEvent({
        companyId: row.companyId,
        type: 'external_paid',
        amount: 0,
        moneyRequestId: row.id,
        purpose: row.purpose,
        label: `Payé directement à ${row.payee} — ${Number(row.amount).toFixed(2)} €`,
        dedupeKey: `mr_external_${row.id}`,
        meta: { payee: row.payee, payUrl: row.payUrl, declaredAmount: Number(row.amount) },
      });
    }
    const fresh = await db.select().from(schema.moneyRequests).where(eq(schema.moneyRequests.id, row.id)).get();
    return c.json({ ok: true, request: publicMoneyRequest(fresh) });
  });

  // ── REFUSER ───────────────────────────────────────────────────────────────
  app.post('/money-requests/:id/refuse', async (c) => {
    const got = await loadOwned(c, deps);
    if (!got.ok) return got.res;
    const { row } = got;
    if (row.paidAt) return c.json({ error: 'Déjà payée.', code: 'already_paid' }, 409);
    const body = await c.req.json().catch(() => ({} as any));
    await db.update(schema.moneyRequests)
      .set({ status: 'refused', refusedReason: clean(body?.reason, 500) || null, decidedAt: new Date() })
      .where(and(eq(schema.moneyRequests.id, row.id), isNull(schema.moneyRequests.paidAt)));
    const fresh = await db.select().from(schema.moneyRequests).where(eq(schema.moneyRequests.id, row.id)).get();
    return c.json({ ok: true, request: publicMoneyRequest(fresh) });
  });

  // ── NÉGOCIER : contre-proposition de montant ──────────────────────────────
  // On n'écrase JAMAIS `amount` : la contre-proposition vit dans sa propre
  // colonne, et c'est l'IA qui décide d'émettre une nouvelle demande au
  // nouveau montant. Aucun paiement n'est possible sur une contre-proposition.
  app.post('/money-requests/:id/negotiate', async (c) => {
    const got = await loadOwned(c, deps);
    if (!got.ok) return got.res;
    const { row } = got;
    if (row.paidAt) return c.json({ error: 'Déjà payée.', code: 'already_paid' }, 409);
    const body = await c.req.json().catch(() => ({} as any));
    const counter = round2(Number(body?.amount));
    if (!Number.isFinite(counter) || counter <= 0) return c.json({ error: 'Montant invalide' }, 400);
    if (counter > MAX_PER_REQUEST) return c.json({ error: `Plafond : ${MAX_PER_REQUEST} € par demande.`, code: 'over_request_cap' }, 400);
    await db.update(schema.moneyRequests)
      .set({ status: 'negotiating', counterAmount: counter, counterNote: clean(body?.note, 500) || null, decidedAt: new Date() })
      .where(and(eq(schema.moneyRequests.id, row.id), isNull(schema.moneyRequests.paidAt)));
    const fresh = await db.select().from(schema.moneyRequests).where(eq(schema.moneyRequests.id, row.id)).get();
    return c.json({ ok: true, request: publicMoneyRequest(fresh) });
  });

  // ── Budget de l'entreprise : solde, postes de dépense, historique ─────────
  app.get('/companies/:id/budget', async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const companyId = String(c.req.param('id') || '');
    const company = await db.select().from(schema.companies)
      .where(eq(schema.companies.id, companyId)).get().catch(() => null);
    if (!company) return c.json({ error: 'Not found' }, 404);
    if (String(company.userId) !== String(user.id)) return c.json({ error: 'Not found' }, 404);

    const events = await db.select().from(schema.companyBudgetEvents)
      .where(eq(schema.companyBudgetEvents.companyId, companyId))
      .orderBy(desc(schema.companyBudgetEvents.createdAt)).limit(100).all().catch(() => []);
    const requests = await db.select().from(schema.moneyRequests)
      .where(eq(schema.moneyRequests.companyId, companyId))
      .orderBy(desc(schema.moneyRequests.createdAt)).limit(50).all().catch(() => []);

    const byPurpose: Record<string, number> = {};
    for (const e of events) {
      if (e.type === 'external_paid') continue;
      const k = e.purpose || 'divers';
      byPurpose[k] = round2((byPurpose[k] || 0) + Number(e.amount || 0));
    }

    return c.json({
      ok: true,
      balance: await budgetBalance(companyId),
      currency: CURRENCY,
      byPurpose,
      paidLast30Days: await paidLast30Days(companyId),
      caps: { perRequest: MAX_PER_REQUEST, per30Days: MAX_PER_30_DAYS },
      requests: requests.map(publicMoneyRequest),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        amount: Number(e.amount || 0),
        purpose: e.purpose || null,
        label: e.label || null,
        moneyRequestId: e.moneyRequestId || null,
        createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : null,
      })),
    });
  });
}
