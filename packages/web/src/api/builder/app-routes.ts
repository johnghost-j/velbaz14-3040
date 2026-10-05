// [2026-10-01] BUG CORRIGÉ : quand une édition (chat ou mode auto) ajoutait une
// page, App.tsx était RÉGÉNÉRÉ de zéro depuis la liste des fichiers de pages,
// avec une route devinée d'après le nom (« /home », « /productdetail »,
// « /legalnotice », « /notfound »…). Résultat : la page d'accueil quittait « / »,
// les fiches produit (/product/:id) et pages légales (/legal/:slug) cassaient, et
// LegalNotice / NotFound étaient importés deux fois → App.tsx ne compilait plus
// (site blanc). Désormais on AJOUTE seulement les nouvelles routes à l'App.tsx
// existant : tout le reste (routes réelles, pages de paiement) est préservé.

export type NewRoute = { name?: string; route?: string; file?: string };

/** Nom de composant d'une page (« Blog.tsx », « src/pages/Blog.tsx » → « Blog »). */
export function pageComponent(r: NewRoute): string | null {
  const base = String(r.file || r.name || '').split('/').pop() || '';
  const comp = base.replace(/\.(tsx|jsx|ts|js)$/, '').replace(/[^a-zA-Z0-9]/g, '');
  if (!comp || !/^[A-Za-z]/.test(comp)) return null;
  return comp.charAt(0).toUpperCase() + comp.slice(1);
}

function normRoute(route: unknown): string | null {
  let r = String(route || '').trim();
  if (!r) return null;
  if (!r.startsWith('/')) r = '/' + r;
  if (!/^\/[A-Za-z0-9\-_/:.*]*$/.test(r)) return null;
  return r;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ajoute à App.tsx les routes manquantes (import + <Route>), sans rien toucher
 * d'autre. Renvoie le nouveau contenu, ou `null` si App.tsx n'a pas la forme
 * attendue (pas de <Routes>) — l'appelant retombe alors sur la régénération.
 */
export function wireNewRoutes(appTsx: string, newRoutes: NewRoute[], pageFiles: string[] = []): string | null {
  let src = String(appTsx || '');
  if (!/<Routes[\s>]/.test(src) || !src.includes('</Routes>')) return null;
  const existingPages = new Set(pageFiles.map((p) => (p.split('/').pop() || '').replace(/\.(tsx|jsx)$/, '')));
  for (const nr of Array.isArray(newRoutes) ? newRoutes : []) {
    const comp = pageComponent(nr);
    const route = normRoute(nr.route);
    if (!comp || !route) continue;
    if (pageFiles.length && !existingPages.has(comp)) continue; // page jamais écrite : pas de route morte
    if (new RegExp(`path=(?:"|'|\\{\\s*["'\`])${escapeRe(route)}["'\`]`).test(src)) continue; // route déjà câblée

    // Import (une seule fois, quel que soit le style d'import déjà présent).
    const imported = new RegExp(`import\\s+${comp}\\s+from\\s+["']\\./pages/${comp}(\\.tsx)?["']`).test(src)
      || new RegExp(`\\b(const|let|var|function)\\s+${comp}\\b`).test(src)
      || new RegExp(`import\\s*\\{[^}]*\\b${comp}\\b[^}]*\\}`).test(src);
    if (!imported) {
      const line = `import ${comp} from "./pages/${comp}";`;
      // Après la DERNIÈRE fin d'import (gère les imports sur plusieurs lignes).
      const lines = src.split('\n');
      const endOfImport = /^(import\b.*\bfrom\s+["'][^"']+["']|import\s+["'][^"']+["']|\}\s*from\s+["'][^"']+["']);?\s*$/;
      let lastIdx = -1;
      for (let i = 0; i < lines.length; i++) if (endOfImport.test(lines[i])) lastIdx = i;
      lines.splice(lastIdx + 1, 0, line);
      src = lines.join('\n');
    }

    // Route : juste avant le catch-all (sinon il l'avalerait), ou avant </Routes>.
    const catchAll = /^([ \t]*)<Route\s+path=["']\*["'][^\n]*$/m.exec(src);
    if (catchAll) {
      const routeLine = `${catchAll[1]}<Route path="${route}" element={<${comp} />} />\n`;
      src = src.slice(0, catchAll.index) + routeLine + src.slice(catchAll.index);
    } else {
      const end = src.lastIndexOf('</Routes>');
      const lineStart = src.lastIndexOf('\n', end) + 1;
      const indent = (src.slice(lineStart, end).match(/^[ \t]*/) || [''])[0] + '  ';
      src = src.slice(0, lineStart) + `${indent}<Route path="${route}" element={<${comp} />} />\n` + src.slice(lineStart);
    }
  }
  return src;
}

/**
 * App.tsx à jour après une édition qui ajoute des pages : part de la version
 * la plus récente (modifiée par l'édition, sinon celle du projet) et n'y ajoute
 * que les routes manquantes. `null` = impossible (l'appelant régénère).
 */
export function appTsxWithNewRoutes(
  files: Array<{ path: string; content: string }>,
  changed: Array<{ path: string; content: string }>,
  newRoutes: NewRoute[],
): string | null {
  const current = changed.find((f) => f.path === 'src/App.tsx')?.content
    ?? files.find((f) => f.path === 'src/App.tsx')?.content;
  if (!current) return null;
  const pages = [...files, ...changed].map((f) => f.path).filter((p) => /^src\/pages\/[^/]+\.(tsx|jsx)$/.test(p));
  return wireNewRoutes(current, newRoutes, pages);
}
