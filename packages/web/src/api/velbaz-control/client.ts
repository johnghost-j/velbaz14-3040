/**
 * Velbaz control server client
 * -----------------------------
 * Talks to the EXTERNAL "Velbaz control server" (an admin/analytics panel
 * managed outside this repo, see task from Johne). This is UNRELATED to:
 *   - `../analytics/*`     → internal analytics for user-BUILT sites.
 *   - `vite/__plugins/runable-analytics-plugin.ts` → Runable's own platform
 *     analytics (`window.stonks`). Never touch that.
 *
 * Responsibilities:
 *   1. Queue product events + a metrics snapshot, flush every 60s (or on
 *      demand) to `POST /api/v1/ingest`. Batches capped at 500 events/call.
 *   2. Poll `GET /api/v1/launch` every 60s and cache the result so the
 *      launch gate never needs to hit the network on the hot path.
 *   3. `verifyKey()` — one-shot handshake against `POST /api/v1/verify`.
 *
 * The API key (`INGEST_API_KEY`) is read server-side only (secret store, then process.env) — this file
 * must never be imported from client/mobile bundles.
 */

import { getSecret } from "../secret-store";

// Lues À CHAQUE APPEL (et non au chargement du module) : une clé saisie dans
// Admin Panel → API Keys prend effet sans redémarrage. Repli process.env.
const baseUrl = () => (getSecret("VELBAZ_CONTROL_BASE_URL") || "https://velbazw-jixb3k1-preview-4200.runable.site").replace(/\/+$/, "");
const apiKey = () => getSecret("INGEST_API_KEY") || "";

const MAX_EVENTS_PER_CALL = 500;
// Hard cap on the in-memory queue so a prolonged outage of the control server
// can never grow this unbounded; oldest events are dropped first (append-only
// analytics — losing the very oldest ones under sustained backpressure beats
// crashing the process on OOM).
const MAX_QUEUE_SIZE = 5000;
const FLUSH_INTERVAL_MS = 60_000;
const LAUNCH_POLL_INTERVAL_MS = 60_000;

export interface ControlEvent {
  name: string;
  userId?: string;
  sessionId?: string;
  source?: string;
  country?: string;
  value?: number;
  props?: Record<string, unknown>;
  at?: string | number;
}

export interface LaunchState {
  open: boolean;
  launchAt: string | null;
  message: string;
  requiresInvite: boolean;
  updatedAt: string;
}

type MetricsSnapshotFn = () => Promise<Record<string, unknown>> | Record<string, unknown>;

let queue: ControlEvent[] = [];
let metricsSnapshotFn: MetricsSnapshotFn | null = null;

// ── Launch state cache ────────────────────────────────────────────────────
// `cachedLaunch === null` means "never fetched" → the ONLY moment the gate
// is allowed to fail closed. Any later network error keeps the last known
// value so a blip in the control server never locks real users out.
let cachedLaunch: LaunchState | null = null;
let lastLaunchFetchAt = 0;
let lastLaunchError: string | null = null;

function isConfigured() {
  return Boolean(apiKey());
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey()}`,
    "x-api-key": apiKey(),
  };
}

/** Registers the function used to compute the `metrics` snapshot sent on every ingest call. */
export function setMetricsSnapshotFn(fn: MetricsSnapshotFn) {
  metricsSnapshotFn = fn;
}

/** Queues a product event for the next flush. Never throws. Also mirrors
 * it into the local DB (fire-and-forget) so the admin panel can build real
 * analytics — the external control server has no read endpoint for events. */
export function trackEvent(name: string, opts: Omit<ControlEvent, "name"> = {}, local?: { device?: string | null; path?: string | null }) {
  if (!name) return;
  const event: ControlEvent = { name, at: new Date().toISOString(), ...opts };
  if (isConfigured()) {
    queue.push(event);
    if (queue.length > MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  }
  // Local mirror is independent of whether the remote key is configured —
  // the admin panel's own analytics must keep working either way.
  import("./store").then((m) => m.recordLocalEvent(event, local)).catch(() => {});
}

/**
 * POST /api/v1/verify — one-shot handshake to confirm the key works.
 * Safe to call repeatedly; the control server doesn't rate-limit this per the
 * task spec beyond normal usage.
 */
export async function verifyKey(): Promise<{ ok: boolean; error?: string; raw?: any }> {
  if (!isConfigured()) return { ok: false, error: "INGEST_API_KEY not set" };
  try {
    const res = await fetch(`${baseUrl()}/api/v1/verify`, { method: "POST", headers: authHeaders() });
    const raw = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, raw };
    applyLaunchFromResponse(raw?.launch);
    if (raw && (typeof raw.eventsAllTime === "number" || typeof raw.eventsLast24h === "number")) {
      cachedRemoteCounts = {
        eventsAllTime: Number(raw.eventsAllTime ?? 0),
        eventsLast24h: Number(raw.eventsLast24h ?? 0),
        fetchedAt: Date.now(),
      };
    }
    return { ok: Boolean(raw?.ok), raw };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Last known event counts on the control server, as reported by `/api/v1/verify`. */
let cachedRemoteCounts: { eventsAllTime: number; eventsLast24h: number; fetchedAt: number } | null = null;

/** Used by the admin overview endpoint to show live-ish numbers without hammering /verify. */
export function getCachedRemoteCounts() {
  return cachedRemoteCounts;
}

/**
 * On-demand refresh for the admin panel — calls /verify right now (it's
 * cheap and not rate-limited per spec) and returns fresh counts + queue
 * state, instead of waiting for the next scheduled tick.
 */
export async function fetchControlOverview(): Promise<{
  ok: boolean;
  error?: string;
  eventsAllTime?: number;
  eventsLast24h?: number;
  queueSize: number;
  launch: LaunchState | null;
  lastLaunchError: string | null;
}> {
  const result = await verifyKey();
  return {
    ok: result.ok,
    error: result.error,
    eventsAllTime: cachedRemoteCounts?.eventsAllTime,
    eventsLast24h: cachedRemoteCounts?.eventsLast24h,
    queueSize: queue.length,
    launch: cachedLaunch,
    lastLaunchError,
  };
}

function applyLaunchFromResponse(launch: any) {
  if (!launch || typeof launch !== "object") return;
  cachedLaunch = {
    open: Boolean(launch.open),
    launchAt: launch.launchAt ?? null,
    message: String(launch.message ?? ""),
    requiresInvite: Boolean(launch.requiresInvite),
    updatedAt: String(launch.updatedAt ?? new Date().toISOString()),
  };
  lastLaunchFetchAt = Date.now();
  lastLaunchError = null;
}

/**
 * Flushes the queue: sends up to MAX_EVENTS_PER_CALL events + the current
 * metrics snapshot to POST /api/v1/ingest. On failure the events are put
 * BACK at the front of the queue for the next attempt (simple retry — no
 * events are ever dropped on a transient failure, only on sustained
 * backpressure via MAX_QUEUE_SIZE above).
 */
export async function flush(): Promise<{ ok: boolean; sent: number; error?: string }> {
  if (!isConfigured()) return { ok: false, sent: 0, error: "INGEST_API_KEY not set" };

  const batch = queue.splice(0, MAX_EVENTS_PER_CALL);
  let metrics: Record<string, unknown> = {};
  try {
    metrics = (await metricsSnapshotFn?.()) || {};
  } catch (err) {
    console.error("[velbaz-control] metrics snapshot failed:", err);
  }

  // Nothing to report at all: still worth a heartbeat call to keep launch
  // state fresh, but not worth spamming the control server every 60s when
  // idle — the separate launch poller already covers freshness.
  if (batch.length === 0 && Object.keys(metrics).length === 0) return { ok: true, sent: 0 };

  try {
    const res = await fetch(`${baseUrl()}/api/v1/ingest`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ source: "app", events: batch, metrics }),
    });
    const raw = await res.json().catch(() => null);
    if (!res.ok) {
      // Put the batch back so nothing is lost.
      queue.unshift(...batch);
      return { ok: false, sent: 0, error: `HTTP ${res.status}: ${JSON.stringify(raw)}` };
    }
    applyLaunchFromResponse(raw?.launch);
    return { ok: true, sent: batch.length };
  } catch (err: any) {
    queue.unshift(...batch);
    return { ok: false, sent: 0, error: err?.message || String(err) };
  }
}

/** GET /api/v1/launch — public, no key. Updates the cache on success. */
async function pollLaunch(): Promise<void> {
  try {
    const res = await fetch(`${baseUrl()}/api/v1/launch`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    applyLaunchFromResponse(raw);
  } catch (err: any) {
    lastLaunchError = err?.message || String(err);
    console.error("[velbaz-control] launch poll failed (keeping last known state):", lastLaunchError);
  }
}

/**
 * Returns the current launch state for the frontend gate.
 * Fails CLOSED only when nothing has ever been fetched (fresh boot, control
 * server unreachable on first try). Once we have a cached value, network
 * blips never flip it back closed.
 */
export function getLaunchState(): { launch: LaunchState; stale: boolean; error: string | null } {
  if (!cachedLaunch) {
    return {
      launch: {
        open: false,
        launchAt: null,
        message: "Connecting…",
        requiresInvite: false,
        updatedAt: new Date().toISOString(),
      },
      stale: true,
      error: lastLaunchError,
    };
  }
  return { launch: cachedLaunch, stale: Date.now() - lastLaunchFetchAt > LAUNCH_POLL_INTERVAL_MS * 3, error: lastLaunchError };
}

export function validateInviteCode(code: string): boolean {
  const expected = process.env.LAUNCH_INVITE_CODE || "";
  if (!expected || !code) return false;
  return code.trim() === expected.trim();
}

/**
 * Starts the 60s flush loop and 60s launch poller. Guarded against
 * hot-reload duplication the same way every other scheduler in this repo is
 * (see index.ts `__velbaz_schedulers_started`).
 */
export function startVelbazControlSchedulers() {
  if ((globalThis as any).__velbaz_control_started) return;
  (globalThis as any).__velbaz_control_started = true;

  if (!isConfigured()) {
    console.warn("[velbaz-control] INGEST_API_KEY not set — telemetry/launch-gate disabled (app stays gated closed).");
    return;
  }

  // Prime the launch cache immediately so the very first request doesn't
  // have to wait 60s for the first poll tick.
  pollLaunch();

  setInterval(() => { pollLaunch(); }, LAUNCH_POLL_INTERVAL_MS);
  setInterval(() => {
    flush().then((r) => {
      if (!r.ok && r.error) console.error("[velbaz-control] flush failed:", r.error);
    });
  }, FLUSH_INTERVAL_MS);
}

/** Manual flush hook, e.g. for a graceful-shutdown handler or an admin debug route. */
export async function manualFlush() {
  return flush();
}

/**
 * GET /api/v1/stats — real analytics of the WAITLIST LANDING PAGE itself
 * (velbazw-jixb3k1-preview-4200.runable.site): its own visitors and
 * signups, tracked by that separate project, not by this app. Added once
 * that project shipped a read endpoint (previously it had none).
 */
export async function fetchWaitlistStats(): Promise<{ ok: boolean; error?: string; data?: any }> {
  if (!isConfigured()) return { ok: false, error: "INGEST_API_KEY not set" };
  try {
    const res = await fetch(`${baseUrl()}/api/v1/stats`, { headers: authHeaders() });
    const raw = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data: raw };
    return { ok: Boolean(raw?.ok ?? true), data: raw };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
