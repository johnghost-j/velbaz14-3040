/**
 * Bouton « Continue with Google » + retour du flux OAuth.
 *
 * Le bouton n'apparaît que si le déploiement a bien GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET (voir GET /api/auth/providers) : sans clés, aucune
 * promesse n'est affichée à l'utilisateur.
 *
 * Au retour, le serveur redirige vers /login#google_token=<session>. Le jeton
 * voyage dans le FRAGMENT (jamais en query) pour ne pas finir dans les logs
 * serveur ni dans l'en-tête Referer.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

/** Lit le jeton du fragment d'URL puis nettoie la barre d'adresse. */
function takeTokenFromHash(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash || '';
  const m = hash.match(/google_token=([^&]+)/);
  if (!m) return '';
  const token = decodeURIComponent(m[1]);
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {}
  return token;
}

/** Lit ?error=... laissé par un échec du callback, puis nettoie l'URL. */
function takeErrorFromQuery(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const err = params.get('error') || '';
  if (!err) return '';
  try {
    params.delete('error');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
  } catch {}
  return err;
}

/**
 * Termine la connexion Google si la page a été ouverte par le callback.
 * À monter une seule fois sur les pages login/register.
 */
export function useGoogleReturn(onError?: (msg: string) => void) {
  const adoptToken = useAuth((s) => s.adoptToken);
  const [, navigate] = useLocation();

  useEffect(() => {
    const qErr = takeErrorFromQuery();
    if (qErr) { onError?.(qErr); return; }

    const token = takeTokenFromHash();
    if (!token) return;

    let cancelled = false;
    (async () => {
      const res = await adoptToken(token);
      if (cancelled) return;
      if (res.error) { onError?.(res.error); return; }
      // Reprend l'invitation en attente comme après une connexion classique.
      const pending = (() => { try { return localStorage.getItem('velbaz_pending_invite'); } catch { return null; } })();
      if (pending) { navigate(`/accept-invite?token=${encodeURIComponent(pending)}`); return; }
      navigate('/');
    })();
    return () => { cancelled = true; };
  }, []);
}

export function GoogleSignInButton({
  label = 'Continue with Google',
  variant = 'app',
}: { label?: string; variant?: 'app' | 'waitlist' }) {
  // `null` = on ne sait pas encore. Le bouton est affiché TOUT DE SUITE dans
  // tous les cas : l'utilisateur doit voir où il se trouve même avant que les
  // clés Google soient configurées.
  const [available, setAvailable] = useState<boolean | null>(null);
  const [hint, setHint] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.auth.providers();
        if (!cancelled) setAvailable(!!res?.google);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const ready = available === true;
  const isWaitlist = variant === 'waitlist';

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (ready) { window.location.href = '/api/auth/google/start'; return; }
          setHint("Connexion Google pas encore configurée : ajoute GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET.");
        }}
        className={
          isWaitlist
            ? 'flex w-full items-center justify-center gap-2.5 rounded-full py-2.5 text-[13px] font-medium text-wl-fg shadow-[0_14px_40px_-28px_rgba(18,18,18,0.45)] backdrop-blur-md transition-colors'
            : 'w-full py-2.5 text-[13px] font-medium rounded-lg flex items-center justify-center gap-2.5 transition-colors'
        }
        style={
          isWaitlist
            ? {
                background: 'var(--wl-surface)',
                border: '1px solid var(--wl-line)',
                opacity: available === false ? 0.55 : 1,
                cursor: 'pointer',
              }
            : {
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-secondary)',
                opacity: available === false ? 0.55 : 1,
                cursor: 'pointer',
              }
        }
      >
        <GoogleGlyph />
        {label}
      </button>

      {hint && (
        <div
          className={isWaitlist ? 'label-mono text-center !text-wl-subtle' : 'text-[11px] text-center'}
          style={isWaitlist ? undefined : { color: 'var(--text-dim)' }}
        >
          {hint}
        </div>
      )}

      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px" style={{ background: isWaitlist ? 'var(--wl-line)' : 'var(--border-subtle)' }} />
        <span
          className={isWaitlist ? 'label-mono' : 'text-[10px] uppercase tracking-wider'}
          style={isWaitlist ? undefined : { color: 'var(--text-ghost)' }}
        >
          or
        </span>
        <div className="flex-1 h-px" style={{ background: isWaitlist ? 'var(--wl-line)' : 'var(--border-subtle)' }} />
      </div>
    </>
  );
}

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.9 2.6 13.8l7.8 6.1C12.3 14 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-2.8-.4-4.1H24v8.2h12.5c-.3 2.1-1.6 5.2-4.7 7.3l7.6 5.9c4.5-4.2 6.7-10.3 6.7-17.3z" />
      <path fill="#FBBC05" d="M10.4 28.1c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.8-6.1C1 16.1 0 19.9 0 23.5s1 7.4 2.6 10.7l7.8-6.1z" />
      <path fill="#34A853" d="M24 46.5c6.2 0 11.5-2 15.4-5.6l-7.6-5.9c-2.1 1.4-4.8 2.3-7.8 2.3-6.3 0-11.7-4.5-13.6-10.4l-7.8 6.1C6.5 41.1 14.6 46.5 24 46.5z" />
    </svg>
  );
}
