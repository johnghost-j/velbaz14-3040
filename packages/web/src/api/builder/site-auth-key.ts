// [2026-10-03] Clé de session des sites générés, propre à CHAQUE site.
//
// Bug « je me connecte sur mon site, j'actualise / je navigue → déconnecté » :
// tous les sites générés sont servis depuis la MÊME origine (l'aperçu Velbaz
// `/api/companies/<id>/preview/`, et les sites publiés `/s/<sous-domaine>` y
// renvoient). Ils rangeaient tous leur jeton sous `localStorage["auth_token"]`.
// Ouvrir un autre site (ou l'aperçu d'un autre projet) faisait appeler
// `/auth/me` à CE site avec le jeton du premier → 401 → le client effaçait le
// jeton… du premier site. Le compte « ne se souvenait plus » de l'utilisateur.
//
// La clé inclut désormais `import.meta.env.BASE_URL` (unique par site : Vite le
// fixe au chemin d'aperçu de la société ; "/" pour un site autonome).

/** Expression JS (côté site généré) de la clé du jeton de session. */
export const SITE_AUTH_KEY_EXPR = `"auth_token:" + (import.meta.env.BASE_URL || "/")`;

const LEGACY_KEY_RE = /localStorage\.(getItem|setItem|removeItem)\(\s*(["'])auth_token\2/g;

/**
 * Remplace la clé partagée `"auth_token"` par la clé propre au site dans tout
 * fichier source front (templates anciens en base ET code écrit par l'IA).
 * Idempotent : `"auth_token:" + …` n'est plus reconnu comme l'ancienne clé.
 */
export function namespaceSiteAuthKey(filePath: string, code: string): string {
  if (typeof code !== "string" || !filePath.startsWith("src/") || !/\.(tsx?|jsx?)$/.test(filePath)) return code;
  if (!code.includes("auth_token")) return code;
  return code.replace(LEGACY_KEY_RE, (_m, fn: string) => `localStorage.${fn}(${SITE_AUTH_KEY_EXPR}`);
}
