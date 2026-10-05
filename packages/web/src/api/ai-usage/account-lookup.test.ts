// Recherche admin « crédits d'un compte » : email → projets → coût par projet.
// Base SQLite en mémoire construite depuis le schéma drizzle réel (mêmes
// colonnes que la prod), aucune donnée de prod touchée.

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { aiUsageEvents, companies, users } from "../database/schema";

const client = createClient({ url: ":memory:" });
const memDb = drizzle(client);
mock.module("../database/index", () => ({ db: memDb }));

const { lookupAccount, looksLikeEmail, normalizeEmail, sortProjects } = await import("./account-lookup");
const { getSummary, getByModel } = await import("./queries");
const { createAiUsageRoutes, parseFilters } = await import("./admin-routes");

async function createTable(t: SQLiteTable) {
  const cfg = getTableConfig(t);
  const cols = cfg.columns.map((c) => `"${c.name}" ${c.getSQLType()}`).join(", ");
  await client.execute(`CREATE TABLE "${cfg.name}" (${cols})`);
}

const U = "u-1";
const T0 = Date.UTC(2026, 9, 1, 10);
let n = 0;
async function ev(p: { companyId: string | null; userId?: string | null; email?: string | null; model: string; credits: number; status?: string }) {
  n++;
  await memDb.insert(aiUsageEvents).values({
    id: `ev-${n}`,
    startedAt: new Date(T0 + n * 60_000),
    endedAt: new Date(T0 + n * 60_000 + 500),
    durationMs: 500,
    model: p.model,
    provider: p.model.split("/")[0],
    routedVia: "gateway",
    kind: "text",
    feature: "website_build",
    userId: p.userId === undefined ? U : p.userId,
    userEmail: p.email === undefined ? "John@Gmail.com" : p.email,
    companyId: p.companyId,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: p.credits / 3000,
    credits: p.credits,
    priced: "table",
    status: p.status ?? "ok",
  } as any);
}

beforeAll(async () => {
  await createTable(users);
  await createTable(companies);
  await createTable(aiUsageEvents);

  await memDb.insert(users).values([
    { id: U, email: "john@gmail.com", name: "John", passwordHash: "x", plan: "free", role: "user", tokens: 4200, createdAt: new Date(T0) },
    { id: "u-2", email: "amie@gmail.com", name: "Amie", passwordHash: "x", plan: "pro", role: "user", tokens: 10, createdAt: new Date(T0) },
  ] as any);
  await memDb.insert(companies).values([
    { id: "c-mail", userId: U, name: "MailFlow", idea: "i", status: "active", projectType: "web", origin: "user", createdAt: new Date(T0) },
    { id: "c-vide", userId: U, name: "Projet vide", idea: "i", status: "active", projectType: "mobile", origin: "user", createdAt: new Date(T0) },
    { id: "c-amie", userId: "u-2", name: "Projet d'Amie", idea: "i", status: "active", projectType: "web", origin: "user", createdAt: new Date(T0) },
  ] as any);

  await ev({ companyId: "c-mail", model: "anthropic/claude-sonnet-4.6", credits: 300 });
  await ev({ companyId: "c-mail", model: "openai/gpt-5.4-mini", credits: 10 });
  await ev({ companyId: "c-mail", model: "openai/gpt-5.4-mini", credits: 5, status: "error" });
  // Appel système sur son projet (pas d'utilisateur dans le contexte) → compté pour le projet.
  await ev({ companyId: "c-mail", userId: null, email: null, model: "google/gemini-3-flash", credits: 2 });
  // Il a co-édité le projet d'Amie.
  await ev({ companyId: "c-amie", model: "openai/gpt-5.4-mini", credits: 7 });
  // Projet supprimé depuis.
  await ev({ companyId: "c-gone", model: "openai/gpt-5.4-nano", credits: 1 });
  // Appel sans projet.
  await ev({ companyId: null, model: "openai/gpt-5.4-nano", credits: 3 });
  // Bruit : Amie sur son propre projet et un appel global anonyme.
  await ev({ companyId: "c-amie", userId: "u-2", email: "amie@gmail.com", model: "openai/gpt-5.4", credits: 999 });
  await ev({ companyId: null, userId: null, email: null, model: "openai/gpt-5.4", credits: 50 });
});

describe("account-lookup", () => {
  test("normalise et valide l'email", () => {
    expect(normalizeEmail("  John@GMAIL.com ")).toBe("john@gmail.com");
    expect(looksLikeEmail("john@gmail.com")).toBe(true);
    expect(looksLikeEmail("john")).toBe(false);
    expect(looksLikeEmail("a b@c.d")).toBe(false);
  });

  test("tri : plus cher d'abord, « sans projet » toujours en dernier", () => {
    const base = { name: null, status: null, projectType: null, createdAt: null, calls: 1, credits: 0, totalTokens: 0, errors: 0, models: 1, firstAt: null, lastAt: null };
    const out = sortProjects([
      { ...base, companyId: null, ownership: "unassigned", costUsd: 9 },
      { ...base, companyId: "a", ownership: "owner", costUsd: 1 },
      { ...base, companyId: "b", ownership: "owner", costUsd: 5 },
    ]);
    expect(out.map((p) => p.companyId)).toEqual(["b", "a", null]);
  });

  test("email inconnu sans aucun appel → null", async () => {
    expect(await lookupAccount("personne@example.com")).toBeNull();
  });

  test("liste tous ses projets avec le coût de chacun, sans rien masquer", async () => {
    const r = (await lookupAccount("JOHN@gmail.com "))!;
    expect(r.user).toMatchObject({ id: U, email: "john@gmail.com", exists: true, plan: "free", balance: 4200 });

    const byId = Object.fromEntries(r.projects.map((p) => [p.companyId ?? "none", p]));
    expect(Object.keys(byId).sort()).toEqual(["c-amie", "c-gone", "c-mail", "c-vide", "none"]);

    expect(byId["c-mail"]).toMatchObject({ name: "MailFlow", ownership: "owner", calls: 4, credits: 317, errors: 1, models: 3 });
    expect(byId["c-vide"]).toMatchObject({ name: "Projet vide", ownership: "owner", calls: 0, credits: 0, lastAt: null });
    // Sur le projet d'Amie, seuls SES appels comptent (pas les 999 d'Amie).
    expect(byId["c-amie"]).toMatchObject({ ownership: "shared", calls: 1, credits: 7 });
    expect(byId["c-gone"]).toMatchObject({ ownership: "deleted", name: null, credits: 1 });
    // L'appel global anonyme (50) n'est pas à lui.
    expect(byId["none"]).toMatchObject({ ownership: "unassigned", calls: 1, credits: 3 });

    expect(r.totals.credits).toBe(317 + 7 + 1 + 3);
    expect(r.totals.projects).toBe(4);
    // Le plus cher d'abord, « sans projet » toujours en dernier.
    expect(r.projects[0].companyId).toBe("c-mail");
    expect(r.projects.at(-1)!.ownership).toBe("unassigned");
    expect(byId["c-mail"].createdAt).toBe(T0);
  });

  test("compte supprimé : on retrouve encore ses appels par email", async () => {
    await ev({ companyId: null, userId: "u-old", email: "ancien@gmail.com", model: "openai/gpt-5.4-nano", credits: 4 });
    const r = (await lookupAccount("ancien@gmail.com"))!;
    expect(r.user.exists).toBe(false);
    expect(r.user.balance).toBeNull();
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]).toMatchObject({ ownership: "unassigned", credits: 4 });
  });

  test("détail d'un projet : filtres companyId / companyId=none depuis toujours", async () => {
    const s = await getSummary({ companyId: "c-mail" });
    expect(s.calls).toBe(4);
    expect(s.credits).toBe(317);
    const models = await getByModel({ companyId: "c-mail" });
    expect(models.map((m) => m.model).sort()).toEqual(["anthropic/claude-sonnet-4.6", "google/gemini-3-flash", "openai/gpt-5.4-mini"]);
    expect(models.find((m) => m.model === "openai/gpt-5.4-mini")).toMatchObject({ calls: 2, credits: 15, errors: 1 });

    const none = await getSummary({ companyId: "none", userId: U });
    expect(none.calls).toBe(1);
    expect(none.credits).toBe(3);
  });

  test("parseFilters : days=all supprime la borne de début", () => {
    const fake = (q: Record<string, string>) => ({ req: { query: () => q } });
    expect(parseFilters(fake({ days: "all", companyId: "c-mail" }))).toMatchObject({ since: undefined, companyId: "c-mail" });
    const d30 = parseFilters(fake({}));
    expect(typeof d30.since).toBe("number");
  });
});

describe("route GET /admin/ai-usage/account", () => {
  const app = (admin: boolean) => createAiUsageRoutes({ requireAdmin: async () => (admin ? { id: "a" } : null) });

  test("403 sans admin", async () => {
    const res = await app(false).request("/admin/ai-usage/account?email=john@gmail.com");
    expect(res.status).toBe(403);
  });

  test("400 email invalide, 404 inconnu, 200 sinon", async () => {
    const a = app(true);
    expect((await a.request("/admin/ai-usage/account?email=john")).status).toBe(400);
    const nf = await a.request("/admin/ai-usage/account?email=personne@example.com");
    expect(nf.status).toBe(404);
    expect((await nf.json()).error).toContain("personne@example.com");
    const ok = await a.request("/admin/ai-usage/account?email=John@gmail.com");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.projects.length).toBe(5);
  });

  test("/overview accepte companyId + days=all", async () => {
    const res = await app(true).request("/admin/ai-usage/overview?companyId=c-mail&days=all");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.calls).toBe(4);
    expect(body.byModel.length).toBe(3);
  });
});
