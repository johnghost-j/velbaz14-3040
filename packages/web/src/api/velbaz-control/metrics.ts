/**
 * Computes the `metrics` snapshot sent on every /api/v1/ingest call.
 * Kept separate from client.ts so it can be unit-tested / swapped without
 * touching the HTTP plumbing.
 */
import { db } from "../database/index";
import * as schema from "../database/schema";
import { sql, gte, eq, and, isNotNull } from "drizzle-orm";

export async function computeMetricsSnapshot(): Promise<Record<string, unknown>> {
  try {
    const [usersTotal] = await db.select({ n: sql<number>`count(*)` }).from(schema.users);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // `activeToday` = accounts with at least one live session touched in the
    // last 24h (sessions carry `expiresAt`; a fresh session implies recent
    // activity — no dedicated lastSeenAt column on `users` itself).
    const [activeToday] = await db
      .select({ n: sql<number>`count(distinct ${schema.sessions.userId})` })
      .from(schema.sessions)
      .where(gte(schema.sessions.expiresAt, dayAgo));
    const [mrrRow] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.companies.mrr}), 0)` })
      .from(schema.companies);
    const [payingUsers] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.users)
      .where(and(isNotNull(schema.users.stripeSubscriptionId), eq(schema.users.billingStatus, "active")));

    return {
      users_total: Number(usersTotal?.n ?? 0),
      active_today: Number(activeToday?.n ?? 0),
      paying_users: Number(payingUsers?.n ?? 0),
      mrr: { value: Number(mrrRow?.total ?? 0), unit: "EUR" },
    };
  } catch (err) {
    console.error("[velbaz-control] metrics snapshot query failed:", err);
    return {};
  }
}
