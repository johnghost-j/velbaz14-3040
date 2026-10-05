/**
 * Verdict d'une vérification de session (`GET /auth/me`).
 *
 * [2026-09-17] Fonction isolée VOLONTAIREMENT sans dépendance au navigateur :
 * c'est la règle qui décide si l'on déconnecte l'utilisateur, donc elle doit
 * être testable seule. Le bug d'origine : toute réponse sans `user` — y compris
 * un 503 ou un réseau coupé — était traitée comme « session morte », le token
 * était effacé et l'interface affichait « Sign In » alors que la session était
 * valide (les projets, servis depuis leur cache local, restaient visibles).
 */
export type SessionVerdict =
  /** Session confirmée par le serveur. */
  | { kind: 'ok'; user: any }
  /** Le serveur affirme que la session n'est plus valide → nettoyage. */
  | { kind: 'unauthorized' }
  /** On ne sait pas (réseau, 5xx, réponse illisible) → garder la session. */
  | { kind: 'transient'; reason: string };

export function classifySession(status: number, data: any): SessionVerdict {
  if (status === 200 && data && data.user) return { kind: 'ok', user: data.user };
  // Seul le serveur peut prononcer la déconnexion, et seulement par 401/403.
  if (status === 401 || status === 403) return { kind: 'unauthorized' };
  if (status === 0) return { kind: 'transient', reason: 'network' };
  if (status >= 500) return { kind: 'transient', reason: `http_${status}` };
  // 200 sans `user` (réponse tronquée, proxy bavard) : douteux, pas fatal.
  return { kind: 'transient', reason: `unexpected_${status}` };
}
