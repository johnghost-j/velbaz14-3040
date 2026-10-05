// ─── Appels / SMS du chat : ouverture du panneau SMS + petits utilitaires ───
//
// Les cartes [CALL_VIEW] / [SMS_VIEW] sont rendues profond dans l'arbre du
// chat. Comme pour CodePreviewContext, le chat fournit l'ouvreur du panneau de
// droite via un contexte plutôt que de faire descendre un callback partout.

import { createContext, useContext } from 'react';
import { authHeaders } from './token';

export type SmsPaneTarget = { threadId: string; label: string };
export type SmsPaneOpener = (target: SmsPaneTarget) => void;

export const SmsPaneContext = createContext<SmsPaneOpener | null>(null);

export function useSmsPaneOpener(): SmsPaneOpener | null {
  return useContext(SmsPaneContext);
}

/** fetch JSON authentifié ; jette une Error lisible si la réponse n'est pas 2xx. */
export async function commsJson<T = any>(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const r = await fetch(url, {
    method: init.method || 'GET',
    headers: authHeaders(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || `Erreur ${r.status}`) as Error & { status?: number; code?: string };
    err.status = r.status;
    err.code = data?.code;
    throw err;
  }
  return data as T;
}

/** +33612345678 → +33 6 12 34 56 78 (lisible, sans rien changer d'autre). */
export function prettyPhone(p?: string | null): string {
  const s = String(p || '');
  const fr = s.match(/^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (fr) return `+33 ${fr[1]} ${fr[2]} ${fr[3]} ${fr[4]} ${fr[5]}`;
  return s;
}

export function initials(name?: string | null, phone?: string | null): string {
  const n = String(name || '').trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  return String(phone || '#').replace(/\D/g, '').slice(-2) || '#';
}

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
