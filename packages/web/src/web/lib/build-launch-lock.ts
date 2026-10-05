/* ─────────────────────────────────────────────────────────────
   Verrou anti-double-lancement de build (côté navigateur).

   [2026-09-17] BUG CORRIGÉ ICI : « dans le chat l'IA a dit 2 fois
   🚀 Je prépare ton projet… comme si l'IA avait commencé, puis bugué,
   puis recommencé ».

   Mesuré en base avant correctif : UN SEUL build côté serveur (une seule
   ligne `execution_state` de type build-website, un seul « ⚙️ Je démarre la
   construction… ») mais DEUX bulles à l'écran. La bulle est empilée par
   `launchBuildForMsg()` AVANT les garde-fous de `triggerBuild()` : tout
   second appel se VOIT, même quand le build lui-même est bien ignoré.

   Origine du second appel : `updateTokens()` recrée l'objet `user` à chaque
   réponse d'API qui renvoie un solde (plusieurs fois par minute pendant un
   build). L'effet de restauration de la « porte de marque » dépend de
   `[user, projectId, hasExistingWebsite]` : il se rejouait et réinstallait un
   lanceur depuis localStorage, alors qu'en mode marque automatique le build
   était DÉJÀ parti. À la validation de la marque, ce lanceur relançait
   `launchBuildForMsg` → 2ᵉ bulle. Les refs en mémoire (`brandAutoLaunchedRef`)
   ne protégeaient rien : elles ne survivent ni au rejeu de l'effet ni à un
   remontage.

   D'où un verrou PERSISTANT (localStorage) : posé au lancement réel, levé
   uniquement quand l'utilisateur envoie un NOUVEAU message — donc les
   relances automatiques (marque validée, remontage, HMR, retry de flux)
   n'annoncent ni ne relancent jamais un second build.
   ───────────────────────────────────────────────────────────── */

const KEY = (companyId: string) => `velbaz_build_launch_${companyId}`;

/** Le verrou doit couvrir tout un build, jamais bloquer un vrai relancement
 *  des heures plus tard (onglet laissé ouvert, projet repris le lendemain). */
export const LAUNCH_TTL_MS = 45 * 60 * 1000;

function store(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null; // mode privé / stockage bloqué
  }
}

/** Marque : « un build a été annoncé et lancé pour ce projet ». */
export function markBuildLaunched(companyId?: string | null, now = Date.now()): void {
  if (!companyId) return;
  store()?.setItem(KEY(companyId), String(now));
}

/** Un build a-t-il déjà été annoncé pour ce projet depuis le dernier message
 *  de l'utilisateur (et il y a moins de 45 min) ? */
export function isBuildLaunched(companyId?: string | null, now = Date.now()): boolean {
  if (!companyId) return false;
  const s = store();
  if (!s) return false;
  const at = Number(s.getItem(KEY(companyId)) || 0);
  if (!at || Number.isNaN(at)) return false;
  if (now - at > LAUNCH_TTL_MS) {
    s.removeItem(KEY(companyId));
    return false;
  }
  return true;
}

/** Nouveau message RÉEL de l'utilisateur → ce tour-ci a le droit d'annoncer
 *  et de lancer un build. */
export function clearBuildLaunched(companyId?: string | null): void {
  if (!companyId) return;
  store()?.removeItem(KEY(companyId));
}
