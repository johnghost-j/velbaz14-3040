// ─── Débit réel des crédits sur le coût IA constaté ─────────────────────────
//
// Règle de facturation : 1 $ de coût IA réellement consommé = 3000 crédits
// débités du solde de l'utilisateur (CREDITS_PER_USD dans pricing.ts).
// Le coût n'est connu qu'APRÈS l'appel : le débit est donc post-payé, branché
// sur le flush de l'enregistreur (recorder.ts), qui voit passer 100 % des
// appels IA du gateway (texte, stream, images).
//
// Les call sites (index.ts) ne font plus qu'une GARDE a priori : ils vérifient
// que le solde couvre une estimation de l'action, sans rien débiter.
//
// Règle absolue héritée du recorder : ceci ne doit JAMAIS ralentir ni casser un
// appel IA. Aucune fonction d'ici ne throw.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../database/index";
import { users, tokenTransactions, companies } from "../database/schema";

export interface UsageCharge {
  userId: string;
  /** Crédits réels (fractionnaires) à débiter. */
  credits: number;
  /** Fonctionnalité dominante du lot, pour la ligne de transaction. */
  feature?: string | null;
  /** Coût USD cumulé du lot, pour la note. */
  costUsd?: number;
}

// Les crédits réels sont fractionnaires (2 décimales) alors que le solde et les
// transactions sont des entiers. On garde le reste en mémoire par utilisateur
// pour ne rien perdre ni surfacturer sur la durée.
// Persisté sur globalThis : survit au re-eval SSR de Vite.
const carry: Map<string, number> = ((globalThis as any).__velbaz_credit_carry ??= new Map<string, number>());

// ── [2026-09-22] Rattrapage des appels non attribués ────────────────────────
// Un évènement sans `user_id` n'était facturé À PERSONNE : tout ce qui tourne
// DÉTACHÉ d'une requête HTTP (tick autopilot, heartbeat, self-heal, moteur de
// comms, relance de build en tâche de fond) n'a pas d'utilisateur dans le
// contexte ambiant — seulement un `companyId`. Résultat : les traitements les
// plus coûteux (un build complet = des dizaines d'appels) ne débitaient rien
// et le solde ne bougeait quasiment pas.
// On remonte donc au PROPRIÉTAIRE du projet (companies.user_id) — même règle
// que `billingUserId` côté routes : un collaborateur consomme les crédits du
// propriétaire. Cache mémoire pour ne pas relire la même ligne 40 fois.
const ownerCache: Map<string, string | null> = ((globalThis as any).__velbaz_company_owner ??= new Map<
  string,
  string | null
>());

// Traitements internes à la plateforme : ils ne sont la consommation de PERSONNE
// (on répare notre propre code). On ne les facture pas et on ne les signale pas
// comme non attribués — sinon le log crie à chaque passage.
const PLATFORM_FEATURES = new Set(["selfheal-diagnose", "selfheal-triage", "selfheal"]);

async function ownerOfCompany(companyId: string): Promise<string | null> {
  if (ownerCache.has(companyId)) return ownerCache.get(companyId) ?? null;
  try {
    const row = await db
      .select({ userId: companies.userId })
      .from(companies)
      .where(eq(companies.id, companyId))
      .get();
    const owner = row?.userId ?? null;
    ownerCache.set(companyId, owner);
    return owner;
  } catch {
    return null; // pas de mise en cache d'un échec : on retentera au prochain lot
  }
}

/**
 * Débite un utilisateur du coût IA réel. Le solde ne descend jamais sous 0.
 * Ne throw jamais.
 */
export async function chargeRealUsage(charge: UsageCharge): Promise<void> {
  try {
    const { userId } = charge;
    if (!userId) return;
    const raw = Number(charge.credits);
    if (!Number.isFinite(raw) || raw <= 0) return;

    const pending = (carry.get(userId) ?? 0) + raw;
    const whole = Math.floor(pending);
    carry.set(userId, Number((pending - whole).toFixed(4)));
    if (whole <= 0) return;

    const user = await db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) return;
    const newBalance = Math.max(0, user.tokens - whole);
    const applied = user.tokens - newBalance;
    if (applied <= 0) return;

    await db.update(users).set({ tokens: newBalance }).where(eq(users.id, userId));
    await db.insert(tokenTransactions).values({
      id: randomUUID(),
      userId,
      amount: -applied,
      type: "usage",
      action: charge.feature ? `ai:${charge.feature}` : "ai",
      balance: newBalance,
      note:
        charge.costUsd != null
          ? `Coût IA réel ${charge.costUsd.toFixed(6)} $ → ${raw.toFixed(2)} crédits`
          : null,
    });
  } catch (e) {
    console.warn("[ai-billing] débit KO :", (e as Error).message);
  }
}

/**
 * Regroupe un lot d'évènements par utilisateur et débite chacun une seule fois.
 * Ne throw jamais.
 */
export async function chargeBatch(
  rows: Array<{
    userId?: string | null;
    companyId?: string | null;
    credits?: number | null;
    costUsd?: number | null;
    feature?: string | null;
  }>,
): Promise<void> {
  try {
    const per = new Map<string, { credits: number; costUsd: number; features: Map<string, number> }>();
    let orphanCredits = 0;
    for (const r of rows) {
      const credits = Number(r.credits ?? 0);
      if (!Number.isFinite(credits) || credits <= 0) continue;
      // Maintenance interne (self-heal) : ce n'est la consommation de personne.
      if (r.feature && PLATFORM_FEATURES.has(r.feature)) continue;
      // Pas d'utilisateur dans le contexte (job de fond) → on facture le
      // propriétaire du projet concerné. Sans projet non plus, c'est à notre
      // charge : on le journalise pour que ça se voie.
      const uid = r.userId || (r.companyId ? await ownerOfCompany(r.companyId) : null);
      if (!uid) {
        orphanCredits += credits;
        continue;
      }
      const acc = per.get(uid) ?? { credits: 0, costUsd: 0, features: new Map<string, number>() };
      acc.credits += credits;
      acc.costUsd += Number(r.costUsd ?? 0) || 0;
      const f = r.feature || "unknown";
      acc.features.set(f, (acc.features.get(f) ?? 0) + credits);
      per.set(uid, acc);
    }
    if (orphanCredits > 0) {
      console.warn(
        `[ai-billing] ${orphanCredits.toFixed(2)} crédits non attribués (ni user ni projet dans le contexte) — à notre charge`,
      );
    }
    for (const [userId, acc] of per) {
      let top = "unknown";
      let best = -1;
      for (const [f, v] of acc.features) if (v > best) { best = v; top = f; }
      await chargeRealUsage({ userId, credits: acc.credits, costUsd: acc.costUsd, feature: top });
    }
  } catch (e) {
    console.warn("[ai-billing] lot KO :", (e as Error).message);
  }
}

/** Le propriétaire d'un projet a changé (transfert) → on oublie le cache. */
export function forgetCompanyOwner(companyId: string): void {
  ownerCache.delete(companyId);
}
