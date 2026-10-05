/**
 * Remote launch gate — wraps the whole app. Driven at runtime by the
 * external Velbaz control server's `/api/v1/launch` switch (proxied/cached
 * server-side, see api/velbaz-control/). No redeploy needed to open the app:
 * this polls our own backend every 60s and unlocks the instant it reports
 * `open: true`.
 *
 * Fails closed ONLY on the very first load (no cached state anywhere yet).
 * After that, a network blip keeps the last known state — it never re-locks
 * users who are already in.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  fetchLaunchStatus,
  readCachedLaunchStatus,
  submitInviteCode,
  hasValidInviteBypass,
  type LaunchStatus,
} from "../lib/launch-gate";
import { WaitlistLanding } from "./waitlist/WaitlistLanding";
import { useAuth, isAdminUser } from "../lib/auth";
import { getAuthToken } from "../lib/token";

const POLL_MS = 60_000;

// Routes that must stay reachable even while the gate is closed, so an admin
// (or anyone finishing an OAuth round-trip) can always sign in — the server
// mirrors this with its own allowlist (GATE_PUBLIC_EXACT_PATHS). Once signed
// in as admin, `isAdminUser` lets every subsequent API call through too.
const GATE_BYPASS_PATH_PREFIXES = ["/login", "/register", "/auth/google"];

function isGateBypassPath(path: string) {
  return GATE_BYPASS_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

function useCountdown(target: string | null) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!target) { setLabel(null); return; }
    const t = new Date(target).getTime();
    if (Number.isNaN(t)) { setLabel(null); return; }
    const tick = () => {
      const diff = t - Date.now();
      if (diff <= 0) { setLabel("any moment now"); return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setLabel(d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);
  return label;
}

export function LaunchGate({ children }: { children: React.ReactNode }) {
  // `undefined` = still resolving the very first check (never fetched, no
  // cache anywhere) → render nothing (avoids a flash of the gated screen for
  // returning users who already have a cached "open" state).
  const [status, setStatus] = useState<LaunchStatus | null | undefined>(undefined);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [unlockedByInvite, setUnlockedByInvite] = useState(hasValidInviteBypass());
  const [location] = useLocation();
  // [2026-09-23] Hydrate the auth store from its own turn — not just from
  // <AppRoutes>'s effect, which never runs while the gate is closed on any
  // path other than /login. Without this, a signed-in admin could reach
  // /login and authenticate, but every OTHER route (including /dashboard)
  // stayed behind the waitlist forever: the token was valid, `useAuth().user`
  // was simply never populated because AppRoutes (and therefore its `init()`
  // call) never mounted. That's what made login look "stuck" — successful
  // sign-in, then bounced right back to the waitlist — and made the admin
  // panel unreachable via F8 (its host tree wasn't mounted either).
  const { user, loading, init } = useAuth();
  useEffect(() => { init(); }, []);
  const admin = isAdminUser(user);
  // [2026-09-25] Le mur d'attente vise le PUBLIC non inscrit : toute session
  // valide doit passer, pas seulement les admins. Avant, un utilisateur qui
  // venait de se connecter était renvoyé sur la landing « liste d'attente »
  // (connexion réussie, jeton en place… et toujours bloqué), parce que seul
  // `admin` ouvrait la porte ici. Le serveur applique désormais la même règle
  // (cf. le middleware de gate dans api/index.ts).
  // `loading && token` couvre le tout premier chargement sans cache de compte :
  // on ne montre pas la landing le temps que /auth/me réponde. Un jeton mort
  // se fait effacer par `confirmSession()` (401/403) → retour au mur.
  const signedIn = !!user || (loading && !!getAuthToken());

  useEffect(() => {
    const cached = readCachedLaunchStatus();
    if (cached) setStatus(cached);

    let cancelled = false;
    const poll = async () => {
      const fresh = await fetchLaunchStatus();
      if (cancelled) return;
      // [2026-09-25] Premier chargement sans cache ET sans réponse de notre
      // propre backend : on échoue OUVERT. La liste d'attente est maintenant
      // opt-in côté serveur (`VELBAZ_WAITLIST`) : l'autorité est locale, donc
      // un simple hoquet de `/api/launch-status` ne doit plus afficher le mur
      // d'attente à tout le monde. Si le mur est réellement activé, le serveur
      // bloque de son côté (middleware de gate) — rien ne fuite.
      if (!fresh && !cached) {
        setStatus({
          open: true,
          launchAt: null,
          message: "",
          requiresInvite: false,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (fresh) setStatus(fresh);
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const countdown = useCountdown(status?.launchAt ?? null);

  if (status === undefined) return null; // resolving first check — no flash.
  if (status.open || unlockedByInvite || signedIn || admin) return <>{children}</>;
  // Let a logged-out admin actually reach the login form (and finish Google
  // OAuth) while the gate is closed — otherwise there is no way in at all.
  if (isGateBypassPath(location)) return <>{children}</>;

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;
    setInviteBusy(true);
    setInviteError(null);
    const ok = await submitInviteCode(inviteCode.trim());
    setInviteBusy(false);
    if (ok) setUnlockedByInvite(true);
    else setInviteError("Invalid invite code.");
  };

  if (!status.requiresInvite) {
    return <WaitlistLanding />;
  }

  return (
    <div style={{ position: "relative" }}>
      <WaitlistLanding />
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10001,
          background: "rgba(10,10,10,0.92)",
          backdropFilter: "blur(8px)",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "16px 24px",
          gap: 10,
        }}
      >
        <p style={{ fontSize: 14, opacity: 0.85, margin: 0, maxWidth: 420 }}>
          {status.message || "Vous avez un code d'invitation ?"}
        </p>
        {countdown && (
          <p style={{ fontSize: 12, opacity: 0.6, margin: 0 }}>
            Ouverture dans {countdown}
          </p>
        )}
        <form onSubmit={handleInvite} style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <input
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="Code d'invitation"
            disabled={inviteBusy}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.25)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontSize: 14,
              width: 200,
            }}
          />
          <button
            type="submit"
            disabled={inviteBusy || !inviteCode.trim()}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: "none",
              background: "#fff",
              color: "#0a0a0a",
              fontSize: 14,
              fontWeight: 600,
              cursor: inviteBusy ? "default" : "pointer",
              opacity: inviteBusy ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {inviteBusy ? "Vérification…" : "Entrer"}
          </button>
        </form>
        {inviteError && <span style={{ fontSize: 12, color: "#ff8080" }}>{inviteError}</span>}
        {status.stale && (
          <span style={{ fontSize: 11, opacity: 0.4 }}>Reconnexion…</span>
        )}
      </div>
    </div>
  );
}
