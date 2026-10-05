// ─── Connexion Google (OAuth 2.0) ────────────────────────────────────────────
// [2026-09-19] Ajouté pour que le rond de profil affiche la VRAIE photo du
// compte : Google la fournit dans le champ `picture` du profil.
//
// Entièrement OPTIONNEL : sans `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
// (Admin Panel ou variables d'environnement), `googleAuthConfigured()` renvoie
// false, le bouton "Continuer avec Google" est masqué côté front, et la photo
// de profil retombe sur Gravatar ou sur l'image envoyée par l'utilisateur.
//
// Flux : /auth/google/start → consentement Google → /auth/google/callback
//        → échange du code contre les jetons → lecture du profil → session.

import { getSecret } from './secret-store';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

/** Identifiants OAuth, ou null si l'instance n'a pas configuré Google. */
export function googleCredentials(): GoogleCredentials | null {
  const clientId = (getSecret('GOOGLE_CLIENT_ID') || '').trim();
  const clientSecret = (getSecret('GOOGLE_CLIENT_SECRET') || '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function googleAuthConfigured(): boolean {
  return googleCredentials() !== null;
}

/**
 * URL de retour déclarée dans la console Google ET envoyée à chaque étape.
 *
 * [2026-09-25] Google compare cette URI caractère par caractère avec celles
 * enregistrées dans la console, et n'accepte AUCUN joker. Or l'app est servie
 * sous plusieurs hôtes (domaine public, URL de préversion, localhost) : sans
 * épinglage, `redirect_uri` changeait selon l'hôte visité et Google répondait
 * `Error 400: redirect_uri_mismatch` partout sauf sur l'hôte enregistré.
 *
 * `GOOGLE_REDIRECT_BASE` fige donc la base utilisée au départ ET à l'échange
 * du code (les deux DOIVENT être identiques, sinon Google refuse l'échange).
 * Non défini, on retombe sur l'hôte courant — le comportement d'avant.
 */
// Hôtes INTERNES d'infrastructure : sur une préversion Runable, le proxy
// réécrit `x-forwarded-host` avec l'hôte du bac à sable (ex.
// `4200-xxxx.e2b.app`), qui n'est pas l'URL publique que voit l'utilisateur et
// qu'on ne peut pas enregistrer chez Google (elle change à chaque sandbox).
const INTERNAL_PROXY_HOST_RE = /(^|\.)e2b\.(app|dev)$/i;

/**
 * Base d'URL pour OAuth, déduite de l'HÔTE RÉEL de la requête.
 *
 * [2026-09-25] L'ancienne version partait de APP_BASE_URL/PUBLIC_BASE_URL, qui
 * pointent sur l'URL de préversion : un visiteur de velbaz.com était envoyé
 * chez Google avec la `redirect_uri` de la préversion — non enregistrée pour ce
 * domaine → « Accès bloqué, Error 400: redirect_uri_mismatch », et Google
 * n'accepte aucun joker. En partant de l'hôte entrant, chaque domaine renvoie
 * sur SON propre callback ; il suffit d'enregistrer chaque origine une fois.
 */
export function oauthBaseFromHost(input: {
  host?: string | null;
  proto?: string | null;
  fallback: string;
}): string {
  const host = (input.host || '').split(',')[0].trim();
  if (!host || INTERNAL_PROXY_HOST_RE.test(host.replace(/:\d+$/, ''))) {
    return (input.fallback || '').replace(/\/$/, '');
  }
  const proto =
    (input.proto || '').split(',')[0].trim() ||
    (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

export function googleRedirectUri(baseUrl: string): string {
  const pinned = (getSecret('GOOGLE_REDIRECT_BASE') || '').trim();
  const base = (pinned || baseUrl || '').replace(/\/$/, '');
  return `${base}/api/auth/google/callback`;
}

/**
 * URL de consentement Google. `state` protège du CSRF : on le vérifie au
 * retour. On demande `profile` pour récupérer le nom ET la photo.
 */
export function googleAuthUrl(input: { baseUrl: string; state: string }): string | null {
  const creds = googleCredentials();
  if (!creds) return null;
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: googleRedirectUri(input.baseUrl),
    response_type: 'code',
    scope: 'openid email profile',
    state: input.state,
    // `select_account` : on ne réutilise pas silencieusement un compte déjà
    // connecté dans le navigateur, l'utilisateur choisit toujours.
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleProfile {
  /** Identifiant stable du compte Google (`sub`). */
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** URL de la photo de profil, vide si le compte n'en a pas. */
  picture: string;
}

export interface GoogleExchangeResult {
  ok: boolean;
  profile?: GoogleProfile;
  /** Message en français, affichable tel quel. */
  error?: string;
}

/** Lit un profil Google brut (champs OpenID Connect) en objet interne. */
export function parseGoogleProfile(raw: any): GoogleProfile | null {
  const googleId = String(raw?.sub || '').trim();
  const email = String(raw?.email || '').trim().toLowerCase();
  if (!googleId || !email) return null;
  return {
    googleId,
    email,
    emailVerified: raw?.email_verified === true || raw?.email_verified === 'true',
    name: String(raw?.name || raw?.given_name || email.split('@')[0] || '').trim(),
    picture: String(raw?.picture || '').trim(),
  };
}

/**
 * Échange le `code` de retour contre le profil Google. Ne jette jamais :
 * toute panne remonte en `{ ok: false, error }` pour être affichée.
 */
export async function exchangeGoogleCode(input: { code: string; baseUrl: string }): Promise<GoogleExchangeResult> {
  const creds = googleCredentials();
  if (!creds) return { ok: false, error: "La connexion Google n'est pas configurée sur cette instance." };
  if (!input.code) return { ok: false, error: 'Code d\'autorisation manquant.' };

  let tokenJson: any;
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: googleRedirectUri(input.baseUrl),
        grant_type: 'authorization_code',
      }).toString(),
    });
    tokenJson = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = tokenJson?.error_description || tokenJson?.error || `HTTP ${res.status}`;
      return { ok: false, error: `Google a refusé la connexion (${detail}).` };
    }
  } catch (e: any) {
    return { ok: false, error: `Impossible de joindre Google (${e?.message || 'réseau'}).` };
  }

  const accessToken = String(tokenJson?.access_token || '');
  if (!accessToken) return { ok: false, error: "Google n'a pas renvoyé de jeton d'accès." };

  try {
    const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
    const raw = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: `Profil Google illisible (HTTP ${res.status}).` };
    const profile = parseGoogleProfile(raw);
    if (!profile) return { ok: false, error: 'Profil Google incomplet (e-mail manquant).' };
    if (!profile.emailVerified) return { ok: false, error: "L'adresse e-mail de ce compte Google n'est pas vérifiée." };
    return { ok: true, profile };
  } catch (e: any) {
    return { ok: false, error: `Lecture du profil Google impossible (${e?.message || 'réseau'}).` };
  }
}
