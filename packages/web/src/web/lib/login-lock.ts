import { useCallback, useEffect, useState } from 'react';
import { useI18n } from './i18n';

/**
 * Réponse d'échec de `POST /auth/login` (cf. api/login-guard.ts) :
 *   • 401 `{ error, attemptsLeft, retryAfter? }` — mauvais identifiants ;
 *   • 429 `{ error, retryAfter, locked }`       — connexion en pause.
 * `retryAfter` est en secondes.
 */
export interface LoginFailure { error?: string; retryAfter?: number; attemptsLeft?: number }

/** 75 → « 1:15 », 9 → « 0:09 ». */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Dernier essai(s) avant l'attente : on prévient seulement quand il en reste peu. */
const WARN_WHEN_LEFT = 2;

/**
 * Compte à rebours du verrou de connexion. Tant qu'il tourne, `blocked` est
 * vrai (bouton désactivé) et `message` affiche le temps restant en direct.
 */
export function useLoginLock() {
  const { t } = useI18n();
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [note, setNote] = useState('');

  useEffect(() => {
    if (until <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until]);

  const secondsLeft = Math.max(0, Math.ceil((until - now) / 1000));
  const blocked = secondsLeft > 0;

  /** Traduit la réponse d'échec en message ; démarre le compte à rebours si besoin. */
  const fail = useCallback((res: LoginFailure): string => {
    if (res.retryAfter && res.retryAfter > 0) {
      const at = Date.now();
      setNow(at);
      setUntil(at + res.retryAfter * 1000);
      setNote(res.error === 'Invalid credentials' ? t('auth.invalid') : '');
      return '';
    }
    if (res.error !== 'Invalid credentials') return res.error || '';
    const left = res.attemptsLeft;
    if (typeof left === 'number' && left > 0 && left <= WARN_WHEN_LEFT) {
      return `${t('auth.invalid')} ${t(left === 1 ? 'auth.attemptsLeft.one' : 'auth.attemptsLeft.other', { n: String(left) })}`;
    }
    return t('auth.invalid');
  }, [t]);

  const message = blocked
    ? `${note ? note + ' ' : ''}${t('auth.locked', { time: formatWait(secondsLeft) })}`
    : '';

  return { blocked, message, waitLabel: t('auth.wait', { time: formatWait(secondsLeft) }), fail };
}
