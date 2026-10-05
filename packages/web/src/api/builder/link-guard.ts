// ─── GARDE-FOU DES LIENS INTERNES ────────────────────────────────────────────
// Cause n°1 de « site buggé dès le début » : l'IA écrit un lien interne
// (`<Link to="/reservations">`, `navigate("/tarifs")`, `<a href="/blog">`) vers
// une route qui N'EXISTE PAS dans le router. Le build passe, TypeScript passe,
// le QA statique passe — mais l'utilisateur clique et tombe sur la page 404.
//
// Jusqu'ici, la seule protection était une CONSIGNE dans le prompt ("ne link
// que vers une route existante"), donc non fiable par nature. Ce module rend la
// garantie DÉTERMINISTE : on lit la table de routes réelle depuis src/App.tsx
// (généré par code, jamais par l'IA), on scanne TOUS les liens internes de tous
// les fichiers, et on réécrit ceux qui pointent dans le vide vers la route
// existante la plus proche (ou l'accueil en dernier recours).
//
// Résultat : plus aucun lien interne ne peut mener à un 404 dans un site généré.

import type { ScaffoldFile } from "./scaffold";

// ─── Table de routes ─────────────────────────────────────────────────────────

export interface RouteTable {
  /** Routes statiques exactes, ex. "/", "/services", "/login". */
  paths: string[];
  /** Routes dynamiques, ex. "/product/:id". */
  dynamic: string[];
  /** Présence d'un `<Route path="*">` (page NotFound). */
  hasCatchAll: boolean;
}

/** Lit la table de routes réelle depuis le contenu de src/App.tsx. */
export function extractRouteTable(appTsx: string): RouteTable {
  const paths: string[] = [];
  const dynamic: string[] = [];
  let hasCatchAll = false;
  if (!appTsx) return { paths, dynamic, hasCatchAll };
  const re = /<Route\s+[^>]*?path=["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(appTsx))) {
    const p = m[1].trim();
    if (!p) continue;
    if (p === "*") { hasCatchAll = true; continue; }
    const norm = p.startsWith("/") ? p : `/${p}`;
    if (norm.includes(":")) { if (!dynamic.includes(norm)) dynamic.push(norm); }
    else if (!paths.includes(norm)) paths.push(norm);
  }
  return { paths, dynamic, hasCatchAll };
}

// ─── Normalisation d'une cible de lien ───────────────────────────────────────

/**
 * Ramène une cible brute à un chemin comparable, ou renvoie null quand le lien
 * ne concerne pas le router interne (externe, ancre, mailto, relatif…).
 */
export function normalizeTarget(raw: string): string | null {
  const t = (raw || "").trim();
  if (!t) return null;
  // Externe / protocole / ancre pure / relatif → hors périmètre.
  if (/^(https?:|mailto:|tel:|sms:|data:|blob:|\/\/|#|\?)/i.test(t)) return null;
  if (t === "." || t === ".." || t.startsWith("./") || t.startsWith("../")) return null;
  if (!t.startsWith("/")) return null;
  // Retire query + hash, puis le slash final (sauf la racine).
  let p = t.split("#")[0].split("?")[0];
  if (!p) return "/"; // "/#section" → accueil
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** Une cible dynamique contenant une interpolation (`/produit/${id}`) ? */
function isInterpolated(raw: string): boolean {
  return raw.includes("${") || raw.includes("{");
}

/** Remplace les interpolations par un segment joker pour la comparaison. */
function toPattern(raw: string): string {
  return raw.replace(/\$\{[^}]*\}/g, ":x");
}

function segments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

/** La cible correspond-elle à une route (statique ou dynamique) ? */
export function routeExists(target: string, table: RouteTable): boolean {
  const t = target === "/" ? "/" : target.replace(/\/+$/, "");
  if (table.paths.includes(t)) return true;
  const ts = segments(t);
  return table.dynamic.some(d => {
    const ds = segments(d);
    if (ds.length !== ts.length) return false;
    return ds.every((seg, i) => seg.startsWith(":") || seg === ts[i]);
  });
}

// ─── Choix de la route de remplacement ───────────────────────────────────────

function tokens(p: string): string[] {
  return p
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(t => t.length > 1 && !["le", "la", "les", "des", "nos", "mes", "our", "the", "my", "page", "fr", "en"].includes(t));
}

/** Deux mots désignent-ils la même chose (pluriel, dérivé, préfixe commun) ? */
function sameishWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return Math.min(a.length, b.length) >= 4;
  // Racine commune longue : "reservation" / "reserver" → "reserv".
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 5;
}

/** Score de proximité entre une cible cassée et une route existante (0 → 1). */
export function routeSimilarity(target: string, route: string): number {
  const a = tokens(target);
  const b = tokens(route);
  if (!a.length || !b.length) return 0;
  let hits = 0;
  for (const ta of a) if (b.some(tb => sameishWord(ta, tb))) hits++;
  const jaccard = hits / new Set([...a, ...b].map(x => x)).size;
  const coverage = hits / Math.min(a.length, b.length);
  return Math.max(jaccard, coverage * 0.9);
}

// Liens légaux inventés (« /legal/cgv », « /mentions-legales »…) → les pages
// légales fixes du site, au lieu de l'accueil (vu sur PasStride : 10 liens
// footer recâblés vers « / »).
const LEGAL_ALIASES: Array<[RegExp, string]> = [
  [/\b(cgv|cgu|terms?|conditions|retours?|returns?|livraison|shipping|refund|remboursement)\b/, "/terms"],
  [/\b(privacy|confidentialite|rgpd|gdpr|donnees)\b/, "/privacy"],
  [/\b(cookies?)\b/, "/cookies"],
  [/\b(mentions?|legal[\w-]*|imprint|notice)\b/, "/legal-notice"],
];

function legalAlias(target: string, table: RouteTable): string | null {
  const t = target.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ");
  for (const [re, route] of LEGAL_ALIASES) {
    if (re.test(t) && table.paths.includes(route)) return route;
  }
  return null;
}

/**
 * Meilleure route existante pour remplacer une cible cassée. Renvoie null si
 * rien n'est assez proche (l'appelant retombe alors sur l'accueil).
 */
export function bestRouteMatch(target: string, table: RouteTable): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const r of table.paths) {
    if (r === "/") continue; // l'accueil est le fallback, pas un "match"
    const s = routeSimilarity(target, r);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  // Une vraie route proche gagne ; sinon un lien légal va vers sa page légale.
  return bestScore >= 0.5 ? best : legalAlias(target, table);
}

// ─── Détection ───────────────────────────────────────────────────────────────

export type LinkKind = "link" | "navigate" | "anchor";

export interface BrokenLink {
  file: string;
  /** Cible telle qu'écrite dans le code. */
  target: string;
  kind: LinkKind;
  /** Route de remplacement retenue ("/" en dernier recours). */
  fixedTo: string;
  /** Cible interpolée (`/produit/${id}`) → signalée mais jamais réécrite. */
  interpolated: boolean;
}

/** Fichiers susceptibles de contenir des liens (pas les tests/config). */
function isScannable(path: string): boolean {
  return /^src\/.*\.(tsx|ts)$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith("src/lib/images.ts");
}

interface Hit { kind: LinkKind; raw: string; index: number; quoted: string }

/** Toutes les cibles internes citées dans un fichier, avec leur emplacement. */
function collectHits(content: string): Hit[] {
  const hits: Hit[] = [];
  const push = (kind: LinkKind, raw: string, index: number, quoted: string) => hits.push({ kind, raw, index, quoted });
  // to="/x" | to={"/x"} | to={`/x`}  (Link, NavLink, Navigate)
  const toRe = /\bto=(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\}|\{\s*`([^`]*)`\s*\})/g;
  let m: RegExpExecArray | null;
  while ((m = toRe.exec(content))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    push("link", raw, m.index, m[0]);
  }
  // href="/x" (balise <a> interne)
  const hrefRe = /\bhref=(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/g;
  while ((m = hrefRe.exec(content))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    push("anchor", raw, m.index, m[0]);
  }
  // { label: "Accueil", to: "/x" } | { href: "/x" } — tableaux de navigation
  // (Header/Footer). [2026-10-03] Ils échappaient à la réparation : le QA live
  // voyait le lien mort dans le DOM à chaque passe sans pouvoir le recâbler.
  const propRe = /\b(to|href):\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  while ((m = propRe.exec(content))) {
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    push(m[1] === "to" ? "link" : "anchor", raw, m.index, m[0]);
  }
  // window.location.href = "/x" | location.assign("/x") | location.replace("/x")
  const hardRe = /\blocation\.(?:href\s*=\s*|assign\(\s*|replace\(\s*)(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  while ((m = hardRe.exec(content))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    push("navigate", raw, m.index, m[0]);
  }
  // navigate("/x") | navigate(`/x`)
  const navRe = /\bnavigate\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  while ((m = navRe.exec(content))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    push("navigate", raw, m.index, m[0]);
  }
  return hits;
}

/**
 * Liste les liens internes qui ne correspondent à AUCUNE route du router.
 * `appTsx` est le contenu de src/App.tsx (source de vérité du routage).
 */
export function findBrokenLinks(files: ScaffoldFile[], appTsx: string): BrokenLink[] {
  const table = extractRouteTable(appTsx);
  if (!table.paths.length && !table.dynamic.length) return []; // pas de router lisible → on ne touche à rien
  const out: BrokenLink[] = [];
  for (const f of files) {
    if (!isScannable(f.path)) continue;
    for (const hit of collectHits(f.content)) {
      const interpolated = isInterpolated(hit.raw);
      const probe = normalizeTarget(interpolated ? toPattern(hit.raw) : hit.raw);
      if (probe === null) continue;
      if (routeExists(probe, table)) continue;
      out.push({
        file: f.path,
        target: hit.raw,
        kind: hit.kind,
        fixedTo: bestRouteMatch(probe, table) || "/",
        interpolated,
      });
    }
  }
  return out;
}

// ─── Réparation ──────────────────────────────────────────────────────────────

/** Échappe une chaîne pour un usage littéral dans une RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface LinkRepairResult {
  changed: ScaffoldFile[];
  fixes: BrokenLink[];
  /** Cibles interpolées non réparables automatiquement (pour information). */
  skipped: BrokenLink[];
  /** Navigations « dures » rendues compatibles avec le basename (cf. rebaseHardNavigations). */
  rebased: number;
}

/**
 * [2026-10-03] `window.location.href = "/signup"` ignore le `basename` du
 * router : sous l'aperçu (`/api/companies/<id>/preview/`) il sort de l'app et
 * tombe en 404 (HTTP 404 sur http://localhost:52xx/signup). Le QA live envoyait
 * ce bug à l'IA, qui « corrigeait » en inventant `/register` — et cassait au
 * passage un lien qui marchait, re-détecté au tour suivant. Réparation
 * DÉTERMINISTE : on préfixe la base Vite, correcte en aperçu comme en export
 * (base "/" → identique à avant). Idempotent (le motif ne matche plus après).
 */
export function rebaseHardNavigations(content: string): { code: string; count: number } {
  let count = 0;
  const re = /\b((?:window\.)?location\.(?:href\s*=\s*|assign\(\s*|replace\(\s*))(["'`])(\/(?!\/|api\/)[^"'`$]*)\2/g;
  const code = content.replace(re, (_m, head: string, q: string, path: string) => {
    count++;
    return `${head}import.meta.env.BASE_URL.replace(/\\/$/, "") + ${q}${path}${q}`;
  });
  return { code, count };
}

/**
 * Réécrit sur place (mutation de `files`) tout lien interne pointant vers une
 * route inexistante, vers la route existante la plus proche — ou l'accueil.
 * Les cibles interpolées sont signalées mais jamais modifiées (risque de casser
 * une vraie route dynamique côté données).
 */
export function repairInternalLinks(files: ScaffoldFile[], appTsxContent?: string): LinkRepairResult {
  const appTsx = appTsxContent ?? files.find(f => f.path === "src/App.tsx")?.content ?? "";
  const broken = findBrokenLinks(files, appTsx);
  const fixes: BrokenLink[] = [];
  const skipped: BrokenLink[] = [];
  const changedPaths = new Set<string>();

  for (const b of broken) {
    if (b.interpolated) { skipped.push(b); continue; }
    const f = files.find(x => x.path === b.file);
    if (!f) continue;
    const before = f.content;
    // Remplace uniquement la cible EXACTE à l'intérieur d'un attribut/appel de
    // navigation — jamais une occurrence quelconque de la chaîne dans le texte.
    const t = esc(b.target);
    const replaced = before
      .replace(new RegExp(`(\\bto=)(["'])${t}\\2`, "g"), `$1$2${b.fixedTo}$2`)
      .replace(new RegExp(`(\\bto=\\{\\s*)(["'\`])${t}\\2`, "g"), `$1$2${b.fixedTo}$2`)
      .replace(new RegExp(`(\\bhref=)(["'])${t}\\2`, "g"), `$1$2${b.fixedTo}$2`)
      .replace(new RegExp(`(\\bhref=\\{\\s*)(["'\`])${t}\\2`, "g"), `$1$2${b.fixedTo}$2`)
      .replace(new RegExp(`(\\bnavigate\\(\\s*)(["'\`])${t}\\2`, "g"), `$1$2${b.fixedTo}$2`)
      .replace(new RegExp(`(\\b(?:to|href):\\s*)(["'\`])${t}\\2`, "g"), `$1$2${b.fixedTo}$2`)
      .replace(new RegExp(`(\\blocation\\.(?:href\\s*=\\s*|assign\\(\\s*|replace\\(\\s*))(["'\`])${t}\\2`, "g"), `$1$2${b.fixedTo}$2`);
    if (replaced !== before) {
      f.content = replaced;
      changedPaths.add(f.path);
      fixes.push(b);
    }
  }

  // Après le recâblage des cibles : navigations dures → compatibles basename.
  let rebased = 0;
  for (const f of files) {
    if (!isScannable(f.path)) continue;
    const r = rebaseHardNavigations(f.content);
    if (r.count && r.code !== f.content) {
      f.content = r.code;
      changedPaths.add(f.path);
      rebased += r.count;
    }
  }

  const changed = files.filter(f => changedPaths.has(f.path)).map(f => ({ path: f.path, content: f.content }));
  return { changed, fixes, skipped, rebased };
}

/** Résumé lisible pour le flux de progression (une ligne, jamais alarmiste). */
export function linkRepairSummary(r: LinkRepairResult): string | null {
  const parts: string[] = [];
  if (r.fixes.length) {
    const sample = r.fixes.slice(0, 3).map(f => `${f.target} → ${f.fixedTo}`).join(", ");
    const more = r.fixes.length > 3 ? `, +${r.fixes.length - 3}` : "";
    parts.push(`${r.fixes.length} lien(s) interne(s) recâblé(s) vers une vraie page (${sample}${more})`);
  }
  if (r.rebased) parts.push(`${r.rebased} redirection(s) rendue(s) compatibles avec l'adresse du site`);
  return parts.length ? `🔗 ${parts.join(" · ")}` : null;
}
