/**
 * Internal HTTP surface for the launch gate + telemetry.
 * Mounted at `/` (final paths: `/api/launch-status`, `/api/launch-invite`,
 * `/api/telemetry/app-open`) by index.ts, next to the other route bundles
 * (social/, builder/, test-routes…).
 *
 * IMPORTANT: nothing here ever forwards `INGEST_API_KEY` to the client — the
 * frontend only ever talks to THIS app's own backend, never directly to the
 * external Velbaz control server.
 */
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { getLaunchState, validateInviteCode, trackEvent } from "./client";
import { detectDevice } from "./store";
import { rateLimit } from "../security";
import { db } from "../database/index";
import * as schema from "../database/schema";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function requestCountry(c: any): string | undefined {
  return c.req.header("CF-IPCountry") || c.req.header("X-Vercel-IP-Country") || undefined;
}

const velbazControlRoutes = new Hono();

// Admin can force the gate open regardless of the external control server's
// state (toggled from the admin panel, see index.ts `launch_gate_force_open`
// in app_config). Set via `setLaunchGateOverrideReader` from index.ts so this
// module doesn't need a direct DB import.
let overrideReader: (() => Promise<boolean>) | null = null;
export function setLaunchGateOverrideReader(fn: () => Promise<boolean>) {
  overrideReader = fn;
}

/**
 * Single source of truth for "is the gate open right now", shared by the
 * `/launch-status` endpoint below AND the server-side blocking middleware in
 * index.ts — so the API never disagrees with what the frontend gate shows.
 */
// The gate middleware in index.ts calls this on every single request while
// closed — cache the DB-backed forceOpen flag for a few seconds so a burst of
// traffic against a closed gate doesn't turn into a burst of DB reads.
let cachedForceOpen: { value: boolean; at: number } | null = null;
const FORCE_OPEN_CACHE_MS = 5_000;

// [2026-09-25] La liste d'attente est désormais OPT-IN : par défaut Velbaz est
// OUVERT. Avant, la porte était fermée tant que le serveur de contrôle externe
// ne disait pas le contraire — donc sans `INGEST_API_KEY` (ou serveur
// injoignable) tout visiteur tombait sur la landing « liste d'attente », ce qui
// n'est pas le comportement voulu par défaut.
// Pour remettre le mur : `VELBAZ_WAITLIST=1` dans le .env (l'interrupteur admin
// `launch_gate_force_open` et les codes d'invitation continuent de fonctionner
// normalement par-dessus).
export function isWaitlistEnabled(): boolean {
  const v = (process.env.VELBAZ_WAITLIST || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export async function isGateOpen(): Promise<boolean> {
  if (!isWaitlistEnabled()) return true;
  const { launch } = getLaunchState();
  if (launch.open) return true;
  if (!overrideReader) return false;
  if (cachedForceOpen && Date.now() - cachedForceOpen.at < FORCE_OPEN_CACHE_MS) {
    return cachedForceOpen.value;
  }
  const value = await overrideReader().catch(() => false);
  cachedForceOpen = { value, at: Date.now() };
  return value;
}

// ─── Server-verifiable invite bypass ───────────────────────────────────────
// `hasValidInviteBypass()` on the client is pure localStorage — it can't be
// trusted by the server. When `/launch-invite` accepts a code we ALSO drop a
// signed, httpOnly cookie here so the blocking middleware in index.ts can
// verify server-side that this caller really passed the gate, without
// re-validating the code (which the client never re-sends on API calls).
const GATE_BYPASS_COOKIE = "velbaz_gate_bypass";
function gateBypassSecret(): string {
  return process.env.LAUNCH_GATE_SECRET || process.env.SESSION_SECRET || process.env.DATABASE_AUTH_TOKEN || "velbaz-gate-fallback-secret";
}
function signGateBypass(): string {
  return createHmac("sha256", gateBypassSecret()).update("velbaz-gate-invite-ok").digest("hex");
}
function setGateBypassCookie(c: any) {
  const value = signGateBypass();
  setCookie(c, GATE_BYPASS_COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: (c.req.header("x-forwarded-proto") || "").includes("https"),
    path: "/",
    maxAge: 60 * 60 * 24 * 180, // 180 days — matches the client's permanent localStorage flag.
  });
}
/** Used by the gate middleware in index.ts to let previously-invited callers through. */
export function hasServerGateBypass(c: any): boolean {
  const cookieVal = getCookie(c, GATE_BYPASS_COOKIE);
  if (!cookieVal) return false;
  const expected = signGateBypass();
  const a = Buffer.from(cookieVal);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Public: the launch gate polls this every 60s from the frontend.
velbazControlRoutes.get("/launch-status", async (c) => {
  const { launch, stale, error } = getLaunchState();
  // Liste d'attente non activée (défaut) : la porte est ouverte, point. On ne
  // consulte ni le serveur de contrôle ni le flag admin.
  if (!isWaitlistEnabled()) {
    return c.json({
      open: true,
      launchAt: null,
      message: "Velbaz est ouvert.",
      requiresInvite: false,
      updatedAt: new Date().toISOString(),
    });
  }
  const forceOpen = overrideReader ? await overrideReader().catch(() => false) : false;
  if (forceOpen && !launch.open) {
    return c.json({ ...launch, open: true, message: "Velbaz est ouvert.", stale, error: error ?? undefined, forcedOpen: true });
  }
  return c.json({ ...launch, stale, error: error ?? undefined });
});

// Public but rate-limited: validates an early-access invite code server-side
// against LAUNCH_INVITE_CODE. Independent of the control server — the task
// spec has the code live in THIS app's env, not on the control server.
velbazControlRoutes.post(
  "/launch-invite",
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Invalid body" }, 400);
    }
    const code = String(body?.code || "");
    const ok = validateInviteCode(code);
    if (ok) setGateBypassCookie(c);
    return c.json({ ok });
  },
);

// Public but rate-limited: lets the frontend report `app_open` without ever
// holding the ingest API key itself. Restricted to a known event name so
// this can't become an arbitrary-event injection endpoint.
velbazControlRoutes.post(
  "/telemetry/app-open",
  rateLimit({ windowMs: 60_000, max: 30 }),
  async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch { /* body optional */ }
    const device = detectDevice(c.req.header("User-Agent"));
    trackEvent(
      "app_open",
      {
        sessionId: typeof body?.sessionId === "string" ? body.sessionId.slice(0, 100) : undefined,
        country: (typeof body?.country === "string" ? body.country.slice(0, 2).toUpperCase() : undefined) || requestCountry(c),
        source: "app",
      },
      { device },
    );
    return c.json({ ok: true });
  },
);

// Public but rate-limited: one entry per route change, used to build the
// "visiteurs en temps réel" + trafic par page views in the admin panel.
velbazControlRoutes.post(
  "/telemetry/page-view",
  rateLimit({ windowMs: 60_000, max: 120 }),
  async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch { /* body optional */ }
    const device = detectDevice(c.req.header("User-Agent"));
    trackEvent(
      "page_view",
      {
        sessionId: typeof body?.sessionId === "string" ? body.sessionId.slice(0, 100) : undefined,
        country: requestCountry(c),
        source: "app",
        props: { path: typeof body?.path === "string" ? body.path.slice(0, 300) : "" },
      },
      { device, path: typeof body?.path === "string" ? body.path.slice(0, 300) : null },
    );
    return c.json({ ok: true });
  },
);

// ─── Waitlist (landing page affichée quand le gate est fermé) ─────────────
// Stockage 100% local (table waitlist_signups) — jamais transmis au serveur
// externe ni à l'autre projet Runable "Velbaz Waitlist".

// Public: compteur d'inscrits affiché sur la landing page.
velbazControlRoutes.get("/waitlist/stats", async (c) => {
  try {
    const [row] = await db.select({ n: count() }).from(schema.waitlistSignups);
    return c.json({ count: row?.n ?? 0 });
  } catch (e) {
    console.error("[waitlist] stats KO:", e);
    return c.json({ count: 0 });
  }
});

// Public but rate-limited: inscription à la liste d'attente.
velbazControlRoutes.post(
  "/waitlist/join",
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ status: "error", error: "Invalid body" }, 400);
    }
    const email = String(body?.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      return c.json({ status: "error", error: "Adresse e-mail invalide." }, 400);
    }
    try {
      const existing = await db
        .select({ id: schema.waitlistSignups.id })
        .from(schema.waitlistSignups)
        .where(eq(schema.waitlistSignups.email, email))
        .limit(1);
      if (existing.length > 0) {
        const [row] = await db.select({ n: count() }).from(schema.waitlistSignups);
        return c.json({ status: "already", position: row?.n ?? 0 });
      }
      const id = crypto.randomUUID();
      await db.insert(schema.waitlistSignups).values({
        id,
        email,
        ref: typeof body?.ref === "string" ? body.ref.slice(0, 120) : undefined,
        referrer: typeof body?.referrer === "string" ? body.referrer.slice(0, 300) : undefined,
        userAgent: c.req.header("User-Agent")?.slice(0, 300),
        country: requestCountry(c),
      });
      const [row] = await db.select({ n: count() }).from(schema.waitlistSignups);
      trackEvent(
        "signup",
        { source: "web", country: requestCountry(c), props: { kind: "waitlist" } },
        { device: detectDevice(c.req.header("User-Agent")) },
      );
      return c.json({ status: "joined", position: row?.n ?? 1 });
    } catch (e) {
      console.error("[waitlist] join KO:", e);
      return c.json({ status: "error", error: "Erreur serveur." }, 500);
    }
  },
);

export default velbazControlRoutes;
