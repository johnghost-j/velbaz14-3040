/**
 * lazyRetry — `React.lazy` qui survit à une mise en ligne de Velbaz.
 *
 * Après chaque Publish de Velbaz, les fichiers JS changent de nom. Un onglet
 * ouvert AVANT la mise en ligne demande encore les anciens noms : le
 * `import()` échoue (« Failed to fetch dynamically imported module ») et
 * l'écran d'erreur s'affiche jusqu'à ce qu'on recharge. Ici on recharge
 * automatiquement la page UNE fois (l'URL est déjà la bonne, ex.
 * /company/:id?tab=domains), ce qui récupère les nouveaux fichiers.
 */
import { lazy, type ComponentType } from 'react';

const KEY = 'velbaz_chunk_reload_at';

export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed|Unable to preload CSS/i.test(msg);
}

/** Recharge une seule fois par tranche de 20 s (évite une boucle infinie). */
export function reloadOnceForChunkError(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 20_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* storage indisponible : on recharge quand même */ }
  window.location.reload();
  return true;
}

export function lazyRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (err) {
      // Un 2e essai suffit souvent (coupure réseau passagère).
      try {
        return await factory();
      } catch {
        if (isChunkLoadError(err) && reloadOnceForChunkError()) {
          // La page se recharge : on reste en attente pendant ce temps.
          return await new Promise<{ default: T }>(() => {});
        }
        throw err;
      }
    }
  });
}

/** Vite émet `vite:preloadError` quand un fichier préchargé est introuvable. */
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadOnceForChunkError()) e.preventDefault();
  });
}
