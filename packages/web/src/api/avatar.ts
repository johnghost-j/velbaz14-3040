// ─── Photo de profil du compte ───────────────────────────────────────────────
// [2026-09-19] Le rond de profil affichait toujours l'initiale du prénom. Il
// doit afficher la VRAIE photo du compte. Trois sources, par ordre de priorité :
//
//   1. 'upload'   → la photo que l'utilisateur a lui-même choisie (prioritaire,
//                   un choix explicite ne doit jamais être écrasé)
//   2. 'google'   → la photo du compte Google, récupérée à la connexion Google
//   3. 'gravatar' → détectée automatiquement depuis l'e-mail du compte
//
// Si aucune source ne donne de photo, le front retombe sur l'initiale : c'est
// une dégradation volontaire, jamais une erreur.

import { createHash } from 'node:crypto';

export type AvatarSource = 'upload' | 'google' | 'gravatar';

/** Une source choisie par l'utilisateur ne doit pas être écrasée par l'auto-détection. */
const EXPLICIT_SOURCES: AvatarSource[] = ['upload', 'google'];

export function isExplicitSource(source?: string | null): boolean {
  return !!source && EXPLICIT_SOURCES.includes(source as AvatarSource);
}

// ─── Gravatar ────────────────────────────────────────────────────────────────
// Gravatar indexe par SHA-256 de l'e-mail normalisé (minuscules, sans espaces).

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * URL Gravatar de l'e-mail. `d=404` fait répondre 404 quand le compte n'a
 * AUCUNE photo — c'est ce qui permet de tester l'existence au lieu de coller
 * une image générique grise sur tout le monde.
 */
export function gravatarUrl(email: string, size = 256, fallback: '404' | 'mp' = '404'): string {
  return `https://www.gravatar.com/avatar/${emailHash(email)}?s=${size}&d=${fallback}`;
}

/**
 * Cherche une vraie photo Gravatar pour cet e-mail. Renvoie l'URL si elle
 * existe, null sinon (404, réseau coupé, timeout). Ne jette jamais : l'absence
 * de photo n'est pas une erreur.
 */
export async function findGravatar(email: string, timeoutMs = 4000): Promise<string | null> {
  if (!email || !email.includes('@')) return null;
  const url = gravatarUrl(email);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    clearTimeout(t);
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

// ─── Photo Google ────────────────────────────────────────────────────────────

/**
 * Les URL `googleusercontent` portent la taille dans le chemin (`=s96-c`).
 * On demande 256px : le rond de profil est affiché jusqu'à 56px, donc x2 pour
 * les écrans à haute densité, sans télécharger une image inutilement lourde.
 */
export function normalizeGoogleAvatar(url: string, size = 256): string {
  if (!url) return '';
  if (/=s\d+(-c)?$/.test(url)) return url.replace(/=s\d+(-c)?$/, `=s${size}-c`);
  if (/\/s\d+(-c)?\//.test(url)) return url.replace(/\/s\d+(-c)?\//, `/s${size}-c/`);
  return url;
}

// ─── Photo envoyée par l'utilisateur ────────────────────────────────────────

const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** 700 Ko de data URL : le front redimensionne en 256×256 avant d'envoyer,
 *  donc dépasser cette taille veut dire que l'image n'a pas été traitée. */
export const MAX_AVATAR_BYTES = 700 * 1024;

export interface AvatarUploadCheck {
  ok: boolean;
  /** Message prêt à afficher, en français, quand ok === false. */
  error?: string;
  mime?: string;
  bytes?: number;
}

/** Valide une data URL d'image avant de la stocker comme photo de profil. */
export function checkAvatarUpload(dataUrl: unknown): AvatarUploadCheck {
  if (typeof dataUrl !== 'string' || !dataUrl) {
    return { ok: false, error: 'Aucune image reçue.' };
  }
  const m = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) return { ok: false, error: "Format invalide : envoie une image (PNG, JPEG, WebP ou GIF)." };
  const mime = m[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(mime)) {
    return { ok: false, error: `Type d'image non accepté (${mime}). Utilise PNG, JPEG, WebP ou GIF.` };
  }
  const base64 = m[2].replace(/\s/g, '');
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes <= 0) return { ok: false, error: 'Image vide.' };
  if (bytes > MAX_AVATAR_BYTES) {
    return { ok: false, error: `Image trop lourde (${Math.round(bytes / 1024)} Ko, maximum ${Math.round(MAX_AVATAR_BYTES / 1024)} Ko).` };
  }
  return { ok: true, mime, bytes };
}

// ─── Choix de la photo à afficher ───────────────────────────────────────────

export interface AvatarState {
  avatarUrl?: string | null;
  avatarSource?: string | null;
  email?: string | null;
}

export interface AvatarResolution {
  /** L'URL à afficher, ou null si le front doit montrer l'initiale. */
  url: string | null;
  source: AvatarSource | null;
  /** Vrai quand une nouvelle photo a été trouvée et doit être enregistrée. */
  changed: boolean;
}

/**
 * Décide quelle photo afficher pour un compte, en cherchant au besoin une
 * photo Gravatar. `probe` est injectable pour les tests.
 */
export async function resolveAvatar(
  user: AvatarState,
  probe: (email: string) => Promise<string | null> = findGravatar,
): Promise<AvatarResolution> {
  // Un choix explicite (upload / Google) gagne toujours et sans aucun appel réseau.
  if (user.avatarUrl && isExplicitSource(user.avatarSource)) {
    return { url: user.avatarUrl, source: user.avatarSource as AvatarSource, changed: false };
  }
  // Gravatar déjà connu : on le garde tel quel, pas de re-vérification à chaque page.
  if (user.avatarUrl && user.avatarSource === 'gravatar') {
    return { url: user.avatarUrl, source: 'gravatar', changed: false };
  }
  // Rien de stocké : une seule tentative de détection automatique.
  const email = (user.email || '').trim();
  if (!email) return { url: null, source: null, changed: false };
  const found = await probe(email);
  if (found) return { url: found, source: 'gravatar', changed: true };
  return { url: null, source: null, changed: false };
}

/** Initiales de repli, utilisées par le serveur (e-mails) et par le front. */
export function initialsOf(name?: string | null, email?: string | null): string {
  const src = (name || '').trim() || (email || '').trim();
  if (!src) return 'U';
  const parts = src.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] || 'U').toUpperCase();
}
