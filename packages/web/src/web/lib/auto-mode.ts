/**
 * Mode Auto — UNE seule source de vérité pour tous les boutons « Auto »
 * (chat, en-tête du dashboard, onglet Auto, réglages).
 *
 * Avant : chaque écran gardait son propre état (et l'en-tête du dashboard
 * pilotait même un autre interrupteur, l'ancien « auto heartbeat »). Résultat :
 * activé dans le chat, le dashboard affichait encore « Activer », et un refus
 * serveur (plan) remettait le bouton à « off » sans rien dire.
 *
 * Ici : un état par projet, partagé par tous les composants de l'onglet, et
 * diffusé aux autres onglets (BroadcastChannel). Après chaque clic, l'état est
 * relu sur le serveur : le bouton affiche toujours ce qui est VRAIMENT actif.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { authHeaders } from './token';

export type AutoState = {
  /** null = pas encore lu */
  enabled: boolean | null;
  toggling: boolean;
  /** Dernier refus du serveur (plan, droits…), affichable tel quel. */
  error: string | null;
  /** Le plan de l'utilisateur ne permet pas le mode Auto. */
  planLocked: boolean;
  isWorking: boolean;
  currentTask: { agent?: string; title?: string } | null;
};

const EMPTY: AutoState = { enabled: null, toggling: false, error: null, planLocked: false, isWorking: false, currentTask: null };

const states = new Map<string, AutoState>();
const listeners = new Map<string, Set<() => void>>();
const lastFetch = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();

const channel: BroadcastChannel | null = (() => {
  try { return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('velbaz-auto-mode') : null; } catch { return null; }
})();
channel?.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { companyId?: string; enabled?: boolean } | null;
  if (!d?.companyId || typeof d.enabled !== 'boolean') return;
  set(d.companyId, { enabled: d.enabled, error: null }, false);
  void refreshAuto(d.companyId, true);
});

function get(companyId: string): AutoState {
  return states.get(companyId) || EMPTY;
}

function set(companyId: string, patch: Partial<AutoState>, broadcast = false) {
  const prev = get(companyId);
  const next = { ...prev, ...patch };
  states.set(companyId, next);
  listeners.get(companyId)?.forEach((l) => l());
  if (broadcast && typeof patch.enabled === 'boolean') {
    try { channel?.postMessage({ companyId, enabled: patch.enabled }); } catch { /* onglet fermé */ }
  }
}

function subscribe(companyId: string, cb: () => void): () => void {
  let s = listeners.get(companyId);
  if (!s) { s = new Set(); listeners.set(companyId, s); }
  s.add(cb);
  return () => { s!.delete(cb); };
}

/** Lecture synchrone de l'état connu (ex. message d'erreur après setAuto). */
export function getAutoState(companyId: string): AutoState {
  return get(companyId);
}

/** Relit l'état sur le serveur (dédoublonné, max 1 lecture / 3 s sauf `force`). */
export function refreshAuto(companyId: string, force = false): Promise<void> {
  if (!companyId) return Promise.resolve();
  const running = inflight.get(companyId);
  if (running) return running;
  if (!force && Date.now() - (lastFetch.get(companyId) || 0) < 3000) return Promise.resolve();
  const p = (async () => {
    try {
      const r = await fetch(`/api/companies/${companyId}/autopilot/status`, { headers: authHeaders() });
      if (!r.ok) return;
      const d = await r.json();
      lastFetch.set(companyId, Date.now());
      // Pendant un clic en cours on ne réécrit pas l'état (évite un clignotement).
      if (get(companyId).toggling) return;
      set(companyId, {
        enabled: !!d.enabled,
        planLocked: !!d.planLocked,
        isWorking: !!d.isWorking,
        currentTask: d.currentTask || null,
      });
    } catch { /* réseau : on garde l'état connu */ }
    finally { inflight.delete(companyId); }
  })();
  inflight.set(companyId, p);
  return p;
}

/** Active / désactive le mode Auto. Renvoie l'état réellement obtenu. */
export async function setAuto(companyId: string, enabled: boolean): Promise<boolean> {
  const before = get(companyId).enabled;
  set(companyId, { toggling: true, error: null, enabled });
  let ok = false;
  try {
    let timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* vieux navigateur */ }
    const r = await fetch(`/api/companies/${companyId}/autopilot/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ timezone }),
    });
    if (r.ok) ok = true;
    else {
      const body = await r.json().catch(() => ({} as any));
      const msg = body?.error || (r.status === 401 ? 'Connecte-toi pour utiliser le mode Auto.' : `Le serveur a refusé (HTTP ${r.status}).`);
      set(companyId, { error: msg, enabled: before ?? false, planLocked: r.status === 403 && !!body?.upgradeTo });
    }
  } catch {
    set(companyId, { error: 'Réseau indisponible — réessaie.', enabled: before ?? false });
  }
  set(companyId, { toggling: false });
  if (ok) set(companyId, { enabled }, true);
  // Une lecture lancée AVANT le clic peut finir maintenant avec l'ancien état :
  // on l'attend, puis on relit pour de bon.
  const pending = inflight.get(companyId);
  if (pending) await pending;
  await refreshAuto(companyId, true);
  return get(companyId).enabled === true;
}

/** Hook partagé : même état pour tous les boutons Auto du projet. */
export function useAutoMode(companyId: string | null | undefined, pollMs = 20000) {
  const id = companyId || '';
  const state = useSyncExternalStore(
    useCallback((cb: () => void) => (id ? subscribe(id, cb) : () => {}), [id]),
    () => (id ? get(id) : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (!id) return;
    void refreshAuto(id, true);
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refreshAuto(id); }, pollMs);
    const onFocus = () => void refreshAuto(id);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [id, pollMs]);
  const toggle = useCallback(() => (id ? setAuto(id, !(get(id).enabled === true)) : Promise.resolve(false)), [id]);
  const enable = useCallback(() => (id ? setAuto(id, true) : Promise.resolve(false)), [id]);
  const disable = useCallback(() => (id ? setAuto(id, false) : Promise.resolve(false)), [id]);
  const clearError = useCallback(() => { if (id) set(id, { error: null }); }, [id]);
  return { ...state, on: state.enabled === true, toggle, enable, disable, clearError };
}

/** Libellé unique du bouton, identique partout. */
export function autoButtonLabel(on: boolean, toggling: boolean): string {
  if (toggling) return on ? 'Activation…' : 'Désactivation…';
  return on ? 'Désactiver Auto' : 'Activer Auto';
}
