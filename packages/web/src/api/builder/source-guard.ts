/**
 * Protection du code source des apps générées, au niveau du proxy d'aperçu.
 *
 * CONTEXTE — pourquoi ce fichier existe.
 * Un site/app publié est servi par un serveur Vite de DÉVELOPPEMENT, relayé par
 * `/api/companies/:id/preview/*`. Ce proxy est nécessairement public (un
 * visiteur du site publié n'a pas de session). Conséquence mesurée : un simple
 * `curl` sur le proxy renvoyait 200 sur
 *   • /package.json      → dépendances, scripts, nom interne du projet
 *   • /vite.config.js    → configuration de build
 *   • /tsconfig.json, /bun.lockb, /README.md, /*.map …
 * Rien de tout cela n'est demandé par le navigateur pour AFFICHER l'app : ce
 * sont des fichiers de chantier, offerts gratuitement à qui veut cloner le
 * projet. On les refuse donc ici.
 *
 * LIMITE ASSUMÉE, À NE PAS MAL COMPRENDRE.
 * Les modules sous /src/** ne peuvent PAS être bloqués : en mode dev, c'est
 * exactement ce que le navigateur télécharge pour exécuter l'app (index.html
 * importe /src/main.tsx). Tant qu'un site publié est servi par un serveur de
 * dev, son code de composants reste lisible — comme tout JavaScript de
 * navigateur. Le seul correctif complet est de servir un BUILD de production
 * pour les sites publiés (fichiers hachés, minifiés, sans sourcemap) ; c'est un
 * changement d'architecture, pas un filtre de chemins.
 */

/** Segments de `node_modules` que Vite doit pouvoir servir malgré le point. */
const ALLOWED_DOT_SEGMENTS = new Set([".vite", ".vite-temp"]);

/** Fichiers de chantier : jamais nécessaires au rendu, toujours utiles à un cloneur. */
const DENIED_FILES = [
  /^package(-lock)?\.json$/i,
  /^bun\.lockb?$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^vite\.config\.[cm]?[jt]s$/i,
  /^vite\.api\.[cm]?[jt]s$/i,
  /^(tailwind|postcss|eslint|prettier)\.config\.[cm]?[jt]s$/i,
  /^readme(\..+)?$/i,
  /^dockerfile$/i,
  /^\w+\.code-workspace$/i,
];

/**
 * Faut-il refuser ce chemin (relatif à la base de l'aperçu) ?
 *
 * @param pathAfterBase chemin SANS le préfixe `/api/companies/:id/preview`,
 *   par ex. `/src/App.tsx` ou `/package.json`. La query est ignorée : un
 *   attaquant ne doit pas contourner le filtre avec `?import` ou `?raw`.
 */
export function isProtectedSourcePath(pathAfterBase: string): boolean {
  const path = (pathAfterBase.split("?")[0] || "").split("#")[0];

  // 1. Accès système de fichiers de Vite. Vite le restreint déjà à la racine du
  //    projet (`server.fs.strict`, vérifié : 403 sur /@fs/etc/passwd), mais on
  //    ne fait pas dépendre la sécurité d'un réglage par défaut d'une
  //    dépendance : le scaffold ne produit aucune URL /@fs/, donc on refuse.
  if (path.includes("/@fs/") || path.startsWith("@fs/")) return true;

  // 2. Décodage : %2e%2e, %2f… ne doivent pas servir à déguiser un chemin.
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true; // encodage volontairement cassé → refus
  }

  const segments = decoded.split("/").filter(Boolean);

  for (const seg of segments) {
    // 3. Remontée de répertoire sous toutes ses formes.
    if (seg === "..") return true;
    // 4. Fichiers et dossiers cachés : .env, .env.local, .git, .npmrc, .ssh…
    //    (sauf le cache de Vite, que le navigateur doit vraiment charger).
    if (seg.startsWith(".") && !ALLOWED_DOT_SEGMENTS.has(seg)) return true;
  }

  const file = segments[segments.length - 1] || "";

  // 5. Sourcemaps : elles contiennent le source ORIGINAL en clair. Seul
  //    l'inspecteur du navigateur les demande — aucun rendu n'en dépend.
  if (/\.map$/i.test(file)) return true;

  // 6. Clés et certificats laissés dans le projet.
  if (/\.(pem|crt|key|p12|pfx|keystore)$/i.test(file)) return true;

  // 7. Fichiers de chantier.
  if (DENIED_FILES.some((re) => re.test(file))) return true;

  return false;
}
