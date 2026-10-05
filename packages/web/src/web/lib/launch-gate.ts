/**
 * Frontend client for the remote launch gate (see
 * packages/web/src/api/velbaz-control/). Talks ONLY to this app's own
 * backend (`/api/launch-status`, `/api/launch-invite`) — the external
 * control server's key never reaches the browser.
 */

export interface LaunchStatus {
  open: boolean;
  launchAt: string | null;
  message: string;
  requiresInvite: boolean;
  updatedAt: string;
  stale?: boolean;
}

const CACHE_KEY = "velbaz_launch_status_cache";
const INVITE_KEY = "velbaz_invite_ok";

/** Last-known state, used so a network blip never re-locks the app. */
export function readCachedLaunchStatus(): LaunchStatus | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCachedLaunchStatus(status: LaunchStatus) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(status));
  } catch { /* private mode / quota — best effort */ }
}

/**
 * Fetches the current gate state from our own backend. On network failure,
 * returns the last cached value with `stale: true` instead of throwing, so
 * callers can keep the UI as-is rather than gate-locking on a blip.
 */
export async function fetchLaunchStatus(): Promise<LaunchStatus | null> {
  try {
    const res = await fetch("/api/launch-status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const status: LaunchStatus = {
      open: Boolean(data.open),
      launchAt: data.launchAt ?? null,
      message: String(data.message ?? ""),
      requiresInvite: Boolean(data.requiresInvite),
      updatedAt: String(data.updatedAt ?? new Date().toISOString()),
    };
    writeCachedLaunchStatus(status);
    return status;
  } catch {
    const cached = readCachedLaunchStatus();
    return cached ? { ...cached, stale: true } : null;
  }
}

export async function submitInviteCode(code: string): Promise<boolean> {
  try {
    const res = await fetch("/api/launch-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => null);
    const ok = Boolean(data?.ok);
    if (ok) {
      try { localStorage.setItem(INVITE_KEY, "1"); } catch { /* best effort */ }
    }
    return ok;
  } catch {
    return false;
  }
}

export function hasValidInviteBypass(): boolean {
  try {
    return localStorage.getItem(INVITE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Fires once per browser session — cheap `app_open` signal for the control server. */
export function reportAppOpen() {
  try {
    if (sessionStorage.getItem("velbaz_app_open_sent")) return;
    sessionStorage.setItem("velbaz_app_open_sent", "1");
  } catch { /* if storage is unavailable, just send once per page load below */ }
  let sessionId = "";
  try {
    sessionId = localStorage.getItem("velbaz_session_id") || "";
    if (!sessionId) {
      sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("velbaz_session_id", sessionId);
    }
  } catch { /* ignore */ }
  fetch("/api/telemetry/app-open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }).catch(() => { /* best effort, never blocks the app */ });
}

function getOrCreateSessionId(): string {
  try {
    let sessionId = localStorage.getItem("velbaz_session_id") || "";
    if (!sessionId) {
      sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("velbaz_session_id", sessionId);
    }
    return sessionId;
  } catch {
    return "";
  }
}

/** Fires on every route change — feeds the "visiteurs en temps réel" / trafic par page in the admin panel. */
export function reportPageView(path: string) {
  fetch("/api/telemetry/page-view", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, sessionId: getOrCreateSessionId() }),
  }).catch(() => { /* best effort */ });
}
