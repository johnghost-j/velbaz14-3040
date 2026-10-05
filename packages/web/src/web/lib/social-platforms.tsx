/**
 * Métadonnées des plateformes sociales RÉELLEMENT branchées côté serveur
 * (`api/social/platforms.ts` : twitter, discord, reddit, instagram).
 *
 * [2026-09-16] Source unique pour les nouveaux écrans (carte « Connecter »
 * dans le chat). Les anciens composants (SocialConnectPanel,
 * SocialConnectPopup) gardent encore leur propre liste : à fusionner ici le
 * jour où on les retouche, mais on ne les casse pas aujourd'hui.
 */

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

export interface SocialPlatformMeta {
  id: string;
  name: string;
  /** Couleur de marque (fond de la pastille d'icône). */
  color: string;
  /** Couleur du glyphe posé sur `color`. */
  fg: string;
  icon: ReactNode;
}

const IconX = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
const IconDiscord = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
  </svg>
);
const IconReddit = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
  </svg>
);
const IconInstagram = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
  </svg>
);

export const SOCIAL_PLATFORMS: SocialPlatformMeta[] = [
  { id: 'twitter', name: 'X (Twitter)', color: '#000000', fg: '#ffffff', icon: IconX },
  { id: 'discord', name: 'Discord', color: '#5865F2', fg: '#ffffff', icon: IconDiscord },
  { id: 'reddit', name: 'Reddit', color: '#FF4500', fg: '#ffffff', icon: IconReddit },
  { id: 'instagram', name: 'Instagram', color: '#E4405F', fg: '#ffffff', icon: IconInstagram },
];

/** Alias tolérés dans ce que l'IA (ou l'utilisateur) écrit → id interne. */
const ALIASES: Record<string, string> = {
  x: 'twitter',
  'x.com': 'twitter',
  twitter: 'twitter',
  tweet: 'twitter',
  discord: 'discord',
  reddit: 'reddit',
  insta: 'instagram',
  ig: 'instagram',
  instagram: 'instagram',
};

/** Normalise un nom de plateforme ; renvoie null si on ne sait pas publier dessus. */
export function normalizePlatform(raw: string | undefined | null): string | null {
  const k = (raw || '').trim().toLowerCase();
  if (!k) return null;
  const id = ALIASES[k] || k;
  return SOCIAL_PLATFORMS.some(p => p.id === id) ? id : null;
}

export function platformMeta(id: string): SocialPlatformMeta {
  return SOCIAL_PLATFORMS.find(p => p.id === id)
    || { id, name: id.charAt(0).toUpperCase() + id.slice(1), color: '#6366F1', fg: '#ffffff', icon: null };
}

// ─── Plateformes disponibles (clés API côté serveur) ─────────────────────────
// [2026-10-01] Sans leurs clés (REDDIT_* / INSTAGRAM_*), Reddit et Instagram
// n'existent plus dans Velbaz : aucun bouton, aucune carte, aucune stat. Le serveur
// publie la liste à jour sur GET /api/social/config (`available`).
// Tant que la réponse n'est pas arrivée, les plateformes « masquables » sont
// cachées (pas de Reddit qui clignote puis disparaît).

/** Doit rester aligné avec HIDDEN_WITHOUT_KEYS dans api/social/platforms.ts. */
export const HIDDEN_WITHOUT_KEYS = new Set(['reddit', 'instagram']);

const DEFAULT_AVAILABLE = SOCIAL_PLATFORMS.map(p => p.id).filter(id => !HIDDEN_WITHOUT_KEYS.has(id));
let cached: string[] | null = null;
let inflight: Promise<string[]> | null = null;
const listeners = new Set<(ids: string[]) => void>();

function loadAvailable(): Promise<string[]> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch('/api/social/config')
      .then(r => (r.ok ? r.json() : null))
      .then((j: any) => {
        const ids = Array.isArray(j?.available) ? (j.available as string[]) : DEFAULT_AVAILABLE;
        cached = ids;
        listeners.forEach(fn => fn(ids));
        return ids;
      })
      .catch(() => {
        inflight = null; // nouvel essai au prochain montage
        return DEFAULT_AVAILABLE;
      });
  }
  return inflight;
}

/** Ids des plateformes à afficher (ex. ['twitter','discord','instagram']). */
export function useAvailablePlatforms(): Set<string> {
  const [ids, setIds] = useState<string[]>(cached || DEFAULT_AVAILABLE);
  useEffect(() => {
    listeners.add(setIds);
    loadAvailable().then(setIds);
    return () => { listeners.delete(setIds); };
  }, []);
  return new Set(ids);
}

/** Filtre une liste d'objets `{ id }` sur les plateformes disponibles. */
export function useVisiblePlatforms<T extends { id: string }>(all: readonly T[]): T[] {
  const avail = useAvailablePlatforms();
  return all.filter(p => avail.has(p.id));
}
