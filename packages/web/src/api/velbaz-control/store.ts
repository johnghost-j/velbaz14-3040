/**
 * Local mirror + analytics queries for Velbaz control events.
 * ------------------------------------------------------------
 * The EXTERNAL control server (velbaz-control/client.ts) only accepts
 * events (`POST /api/v1/ingest`) — it has no endpoint to read them back
 * (confirmed: every GET /api/v1/* except /launch returns 404). So to give
 * the admin panel real analysis (raw list, funnel, revenue, timeseries,
 * visitors), we keep our own append-only copy in `schema.controlEvents`
 * and compute everything from that local copy.
 *
 * `recordLocalEvent` is called from `client.trackEvent()` in addition to
 * queueing for the remote flush — best-effort, never throws, never blocks.
 */
import { randomUUID } from "crypto";
import { db } from "../database/index";
import * as schema from "../database/schema";
import { and, desc, gte, sql, eq } from "drizzle-orm";
import type { ControlEvent } from "./client";

export function detectDevice(userAgent: string | undefined | null): "mobile" | "tablet" | "desktop" | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet/.test(ua)) return "tablet";
  if (/mobile|iphone|android/.test(ua)) return "mobile";
  return "desktop";
}

export async function recordLocalEvent(
  ev: ControlEvent,
  extra?: { device?: string | null; path?: string | null },
): Promise<void> {
  try {
    await db.insert(schema.controlEvents).values({
      id: randomUUID(),
      name: ev.name,
      userId: ev.userId ?? null,
      sessionId: ev.sessionId ?? null,
      source: ev.source ?? "app",
      country: ev.country ?? null,
      device: extra?.device ?? null,
      path: extra?.path ?? (ev.props as any)?.path ?? null,
      value: typeof ev.value === "number" ? ev.value : null,
      props: ev.props ? JSON.stringify(ev.props) : null,
      at: ev.at ? new Date(ev.at) : new Date(),
    });
  } catch (err) {
    console.error("[velbaz-control] local event mirror failed (non-fatal):", err);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Raw list of the most recent events, newest first. */
export async function listRecentEvents(limit = 200) {
  const rows = await db.select().from(schema.controlEvents).orderBy(desc(schema.controlEvents.at)).limit(Math.min(limit, 1000));
  return rows.map((r) => ({
    ...r,
    props: r.props ? JSON.parse(r.props) : null,
  }));
}

/** Count of events by name, over a few standard windows. */
export async function eventBreakdown() {
  const now = Date.now();
  const windows: Array<[string, Date]> = [
    ["24h", new Date(now - DAY_MS)],
    ["7d", new Date(now - 7 * DAY_MS)],
    ["30d", new Date(now - 30 * DAY_MS)],
  ];
  const result: Record<string, Record<string, number>> = {};
  for (const [label, since] of windows) {
    const rows = await db
      .select({ name: schema.controlEvents.name, count: sql<number>`count(*)` })
      .from(schema.controlEvents)
      .where(gte(schema.controlEvents.at, since))
      .groupBy(schema.controlEvents.name);
    result[label] = {};
    for (const row of rows) result[label][row.name] = Number(row.count);
  }
  const allTime = await db
    .select({ name: schema.controlEvents.name, count: sql<number>`count(*)` })
    .from(schema.controlEvents)
    .groupBy(schema.controlEvents.name);
  result["allTime"] = {};
  for (const row of allTime) result["allTime"][row.name] = Number(row.count);
  return result;
}

/** app_open → signup → purchase funnel, with conversion rates. */
export async function funnel() {
  const counts = async (name: string) => {
    const rows = await db
      .select({ n: sql<number>`count(distinct coalesce(${schema.controlEvents.userId}, ${schema.controlEvents.sessionId}))` })
      .from(schema.controlEvents)
      .where(eq(schema.controlEvents.name, name));
    return Number(rows[0]?.n || 0);
  };
  const opens = await counts("app_open");
  const signups = await counts("signup");
  const purchases = await counts("purchase");
  return {
    steps: [
      { name: "app_open", label: "Visiteurs", count: opens },
      { name: "signup", label: "Inscriptions", count: signups },
      { name: "purchase", label: "Achats", count: purchases },
    ],
    rates: {
      visitToSignup: opens > 0 ? signups / opens : 0,
      signupToPurchase: signups > 0 ? purchases / signups : 0,
      visitToPurchase: opens > 0 ? purchases / opens : 0,
    },
  };
}

/** Revenue totals + breakdown by day and by plan/kind, from `purchase` events. */
export async function revenue() {
  const rows = await db
    .select()
    .from(schema.controlEvents)
    .where(eq(schema.controlEvents.name, "purchase"))
    .orderBy(desc(schema.controlEvents.at))
    .limit(5000);

  let total = 0;
  const byDay: Record<string, number> = {};
  const byKind: Record<string, { count: number; total: number }> = {};

  for (const r of rows) {
    const v = Number(r.value || 0);
    total += v;
    const day = (r.at ? new Date(r.at) : new Date()).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + v;
    let props: any = null;
    try { props = r.props ? JSON.parse(r.props) : null; } catch { /* ignore */ }
    const kind = props?.plan || props?.kind || "unknown";
    if (!byKind[kind]) byKind[kind] = { count: 0, total: 0 };
    byKind[kind].count += 1;
    byKind[kind].total += v;
  }

  return {
    total,
    currency: "EUR",
    byDay: Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-30),
    byKind,
  };
}

/** Daily event counts for a chosen event name (default app_open), last N days. */
export async function timeseries(name = "app_open", days = 30) {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await db
    .select()
    .from(schema.controlEvents)
    .where(and(eq(schema.controlEvents.name, name), gte(schema.controlEvents.at, since)))
    .orderBy(desc(schema.controlEvents.at))
    .limit(20000);
  const byDay: Record<string, number> = {};
  for (const r of rows) {
    const day = (r.at ? new Date(r.at) : new Date()).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }
  return Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
}

/** Recent distinct sessions with their last known device/country/path — a live-ish visitor list. */
export async function recentVisitors(limit = 100) {
  const rows = await db
    .select()
    .from(schema.controlEvents)
    .where(gte(schema.controlEvents.at, new Date(Date.now() - DAY_MS)))
    .orderBy(desc(schema.controlEvents.at))
    .limit(5000);

  const bySession = new Map<string, any>();
  for (const r of rows) {
    const key = r.sessionId || r.userId || r.id;
    if (!bySession.has(key)) {
      bySession.set(key, {
        sessionId: r.sessionId,
        userId: r.userId,
        device: r.device,
        country: r.country,
        lastPath: r.path,
        lastEvent: r.name,
        lastSeen: r.at,
        eventCount: 0,
      });
    }
    const v = bySession.get(key);
    v.eventCount += 1;
    if (!v.device && r.device) v.device = r.device;
    if (!v.country && r.country) v.country = r.country;
    if (r.path) v.lastPath = r.path;
  }
  return Array.from(bySession.values())
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
    .slice(0, limit);
}
