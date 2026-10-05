// ─── Recherche admin « crédits d'un compte » ────────────────────────────────
//
// L'admin tape l'email d'un compte → on rend ses projets avec, pour chacun, ce
// que l'IA a coûté depuis toujours. Le détail d'un projet (modèles, features,
// appels) passe ensuite par les routes existantes avec ?companyId=…&days=all.
//
// Rien n'est masqué :
//   • projets possédés (companies.user_id), même sans aucun appel IA ;
//   • projets d'autres comptes où ce compte a dépensé (co-édition) → "shared" ;
//   • événements dont la société n'existe plus → "deleted" ;
//   • événements du compte sans société rattachée → "unassigned".
//
// LECTURE SEULE.

import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../database/index";
import { aiUsageEvents, companies, users } from "../database/schema";
import { CREDITS_PER_USD } from "./pricing";

/** Id virtuel utilisé par l'UI et `where()` pour « aucune société rattachée ». */
export const NO_COMPANY = "none";

export type ProjectOwnership = "owner" | "shared" | "deleted" | "unassigned";

export interface AccountProject {
  /** null = appels du compte sans société (ownership "unassigned"). */
  companyId: string | null;
  name: string | null;
  ownership: ProjectOwnership;
  status: string | null;
  projectType: string | null;
  /** ms epoch */
  createdAt: number | null;
  calls: number;
  costUsd: number;
  credits: number;
  totalTokens: number;
  errors: number;
  models: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface AccountLookup {
  user: {
    id: string | null; email: string; name: string | null; createdAt: number | null; exists: boolean;
    /** Plan et solde de crédits actuel (null si le compte n'existe plus). */
    plan: string | null; balance: number | null;
  };
  totals: { calls: number; costUsd: number; credits: number; projects: number };
  projects: AccountProject[];
  creditsPerUsd: number;
}

export function normalizeEmail(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** Grossier mais suffisant : on évite juste de taper la DB pour « abc ». */
export function looksLikeEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Colonnes « timestamp » drizzle = secondes ; started_at = ms.
  return n < 1e12 ? n * 1000 : n;
}

/** Tri : le plus cher d'abord, puis le plus récent ; « non attribué » en dernier. */
export function sortProjects(rows: AccountProject[]): AccountProject[] {
  return [...rows].sort((a, b) => {
    if ((a.ownership === "unassigned") !== (b.ownership === "unassigned")) return a.ownership === "unassigned" ? 1 : -1;
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
    return (b.lastAt ?? b.createdAt ?? 0) - (a.lastAt ?? a.createdAt ?? 0);
  });
}

/**
 * Rend null si l'email ne correspond ni à un compte ni à aucun appel IA.
 * Un compte supprimé dont il reste des appels (user_email) est quand même rendu.
 */
export async function lookupAccount(rawEmail: string): Promise<AccountLookup | null> {
  const email = normalizeEmail(rawEmail);

  const [u] = await db
    .select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt, plan: users.plan, tokens: users.tokens })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  const owned = u
    ? await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
          projectType: companies.projectType,
          createdAt: companies.createdAt,
        })
        .from(companies)
        .where(eq(companies.userId, u.id))
    : [];
  const ownedIds = owned.map((c) => c.id);

  // Tous les appels liés au compte : sur ses projets (quel que soit l'auteur de
  // l'appel) + ceux faits par lui ailleurs ou sans projet.
  const byUser = u
    ? or(eq(aiUsageEvents.userId, u.id), sql`lower(${aiUsageEvents.userEmail}) = ${email}`)
    : sql`lower(${aiUsageEvents.userEmail}) = ${email}`;
  const scope = ownedIds.length > 0 ? or(inArray(aiUsageEvents.companyId, ownedIds), byUser) : byUser;

  const usage = await db
    .select({
      companyId: aiUsageEvents.companyId,
      calls: sql<number>`count(*)`,
      costUsd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)`,
      credits: sql<number>`coalesce(sum(${aiUsageEvents.credits}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`,
      errors: sql<number>`coalesce(sum(case when ${aiUsageEvents.status} = 'error' then 1 else 0 end), 0)`,
      models: sql<number>`count(distinct ${aiUsageEvents.model})`,
      firstAt: sql<number | null>`min(${aiUsageEvents.startedAt})`,
      lastAt: sql<number | null>`max(${aiUsageEvents.startedAt})`,
    })
    .from(aiUsageEvents)
    .where(scope)
    .groupBy(aiUsageEvents.companyId)
    .orderBy(desc(sql`coalesce(sum(${aiUsageEvents.costUsd}), 0)`));

  if (!u && usage.length === 0) return null;

  // Sociétés présentes dans l'usage mais pas possédées : co-édition ou supprimées.
  const foreignIds = usage
    .map((r) => r.companyId)
    .filter((id): id is string => !!id && !ownedIds.includes(id));
  const foreign = foreignIds.length
    ? await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
          projectType: companies.projectType,
          createdAt: companies.createdAt,
        })
        .from(companies)
        .where(inArray(companies.id, foreignIds))
    : [];

  const meta = new Map<string, { name: string; status: string | null; projectType: string | null; createdAt: unknown; ownership: ProjectOwnership }>();
  for (const c of owned) meta.set(c.id, { ...c, ownership: "owner" });
  for (const c of foreign) meta.set(c.id, { ...c, ownership: "shared" });

  const empty = { calls: 0, costUsd: 0, credits: 0, totalTokens: 0, errors: 0, models: 0, firstAt: null, lastAt: null };
  const usageById = new Map(usage.map((r) => [r.companyId ?? NO_COMPANY, r]));

  const projects: AccountProject[] = [];
  for (const id of new Set<string>([...ownedIds, ...usage.map((r) => r.companyId ?? NO_COMPANY)])) {
    const m = id === NO_COMPANY ? undefined : meta.get(id);
    const agg = usageById.get(id) ?? empty;
    projects.push({
      companyId: id === NO_COMPANY ? null : id,
      name: m?.name ?? null,
      ownership: id === NO_COMPANY ? "unassigned" : (m?.ownership ?? "deleted"),
      status: m?.status ?? null,
      projectType: m?.projectType ?? null,
      createdAt: toMs(m?.createdAt),
      calls: Number(agg.calls) || 0,
      costUsd: Number(agg.costUsd) || 0,
      credits: Number(agg.credits) || 0,
      totalTokens: Number(agg.totalTokens) || 0,
      errors: Number(agg.errors) || 0,
      models: Number(agg.models) || 0,
      firstAt: toMs(agg.firstAt),
      lastAt: toMs(agg.lastAt),
    });
  }

  const sorted = sortProjects(projects);
  return {
    user: {
      id: u?.id ?? null,
      email: u?.email ?? email,
      name: u?.name ?? null,
      createdAt: toMs(u?.createdAt),
      exists: !!u,
      plan: u?.plan ?? null,
      balance: u ? Number(u.tokens) : null,
    },
    totals: {
      calls: sorted.reduce((s, p) => s + p.calls, 0),
      costUsd: sorted.reduce((s, p) => s + p.costUsd, 0),
      credits: sorted.reduce((s, p) => s + p.credits, 0),
      projects: sorted.filter((p) => p.ownership !== "unassigned").length,
    },
    projects: sorted,
    creditsPerUsd: CREDITS_PER_USD,
  };
}
