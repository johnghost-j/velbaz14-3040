// ─── QA LIVE de fin de build ─────────────────────────────────────────────────
// Le QA statique (qa.ts) analyse le CODE. Ce module teste l'APP QUI TOURNE:
// après le build, on dresse une "carte" de l'app (routes, pages, actions),
// puis un vrai navigateur (Chrome headless via playwright-core) visite chaque
// page via le lien de prévisualisation, clique les boutons, remplit les
// formulaires, et collecte les bugs RÉELS (erreurs JS, pages blanches,
// requêtes HTTP échouées). Les bugs sont ensuite envoyés à l'IA qui les
// corrige en diffs ciblés (SEARCH/REPLACE), appliqués à chaud (HMR).
// UNE seule passe : carte → test → correction → fin (pas de re-test en boucle).

import { generateText } from "ai";
import { gateway } from "../agent/gateway";
import { applySearchReplace } from "./qa";
import { extractRouteTable, normalizeTarget, routeExists, repairInternalLinks, linkRepairSummary } from "./link-guard";
/** Forme structurelle minimale d'un plan, derivee de ce que ce module LIT
 *  reellement (buildAppMap). Pas d'import depuis engine.ts : n'importe quel
 *  producteur de site qui expose ces champs satisfait ce type. Le typage
 *  structurel de TS fait que le plan du planner continue de passer sans
 *  aucune annotation cote appelant. */
export type LiveQAPlan = {
  appType?: string;
  pages?: Array<{
    name: string;
    route: string;
    file: string;
    purpose?: string;
    hasForm?: boolean;
    isCore?: boolean;
  }>;
  entities?: Array<{ collection: string; fields: string }>;
};
import type { ScaffoldFile } from "./scaffold";
import { importOptional } from '../lib/optional-import';
import {
  QA_CLICK_TIMEOUT_MS, QA_FILL_TIMEOUT_MS, QA_INTERACTION_BUDGET_MS, QA_PROBE_TIMEOUT_MS,
  QA_PAGE_CONCURRENCY, actionTimeout, clickDecision, forEachConcurrent, interactionBudget, probeButtonInPage,
  type ButtonProbe,
} from "./live-qa-interaction";

const QA_MODEL = "anthropic/claude-sonnet-4.6";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AppMapRoute {
  name: string;
  route: string;
  file: string;
  purpose?: string;
  hasForm?: boolean;
  isCore?: boolean;
  /** Route dynamique (:param) → non testable en accès direct. */
  dynamic: boolean;
}

export interface AppMap {
  appType: string;
  routes: AppMapRoute[];
  entities: Array<{ collection: string; fields: string }>;
  builtAt: string;
  /** Table de routes RÉELLE lue dans src/App.tsx (source de vérité du router). */
  routeTable?: { paths: string[]; dynamic: string[] };
}

export interface LiveBug {
  route: string;
  page: string; // nom de la page (plan)
  file: string; // fichier source probable
  kind: "pageerror" | "console" | "http" | "blank" | "interaction" | "link" | "notfound";
  message: string;
  detail?: string;
}

export interface LiveQAResult {
  routesTested: number;
  /** Tous les bugs trouvés par l'unique passe de test. */
  found: LiveBug[];
  /** Bugs restés sans correction (fichier non corrigé). */
  bugs: LiveBug[];
  rounds: number;
  fixedFiles: string[];
}

type Progress = (msg: string) => void;

// ─── 1. Carte de l'app ───────────────────────────────────────────────────────

export function buildAppMap(plan: LiveQAPlan | undefined | null, files: ScaffoldFile[]): AppMap {
  const pages = plan?.pages || [];
  const fileSet = new Set(files.map(f => f.path));
  const routes: AppMapRoute[] = pages.map(p => ({
    name: p.name,
    route: p.route,
    file: fileSet.has(`src/pages/${p.file}`) ? `src/pages/${p.file}` : p.file,
    purpose: p.purpose,
    hasForm: p.hasForm,
    isCore: p.isCore,
    dynamic: p.route.includes(":"),
  }));

  // Le plan n'est PAS la vérité du routage : des pages standard (login, légal,
  // paiement) et des routes ajoutées en cours de build sont câblées dans
  // src/App.tsx sans figurer dans plan.pages. Elles échappaient donc au QA live
  // — donc aux bugs vus par l'utilisateur. On complète la carte depuis le
  // router réel, qui est généré par code (jamais par l'IA).
  const appTsx = files.find(f => f.path === "src/App.tsx")?.content || "";
  const table = extractRouteTable(appTsx);
  const compToFile = new Map<string, string>();
  const importRe = /import\s+(\w+)\s+from\s+["'](?:\.\/|\.\.\/)*pages\/(\w+)["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(appTsx))) compToFile.set(im[1], im[2]);
  const routeToFile = new Map<string, string>();
  const routeRe = /<Route\s+path=["']([^"']+)["'][^>]*element=\{<(\w+)/g;
  while ((im = routeRe.exec(appTsx))) {
    const file = compToFile.get(im[2]);
    if (file) routeToFile.set(im[1].startsWith("/") ? im[1] : `/${im[1]}`, `src/pages/${file}.tsx`);
  }
  const known = new Set(routes.map(r => r.route));
  for (const p of [...table.paths, ...table.dynamic]) {
    if (known.has(p)) continue;
    known.add(p);
    const file = routeToFile.get(p) || "src/App.tsx";
    routes.push({
      name: file === "src/App.tsx" ? p : (file.split("/").pop() || p).replace(/\.tsx$/, ""),
      route: p,
      file,
      dynamic: p.includes(":"),
    });
  }

  return {
    appType: plan?.appType || "app",
    routes,
    entities: (plan?.entities || []).map(e => ({ collection: e.collection, fields: e.fields })),
    builtAt: new Date().toISOString(),
    routeTable: { paths: table.paths, dynamic: table.dynamic },
  };
}

// ─── 2. Test live d'une app qui tourne ───────────────────────────────────────

const CHROME_PATHS = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];

async function launchBrowser() {
  const { chromium } = await importOptional<typeof import('playwright-core')>('playwright-core');
  const { existsSync } = await import("node:fs");
  const executablePath = CHROME_PATHS.find(p => existsSync(p));
  if (!executablePath) throw new Error("Chrome introuvable pour le QA live");
  return chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
}

/** Filtre le bruit: erreurs qui ne viennent pas de l'app elle-même. */
export function isNoise(msg: string): boolean {
  const noise = [
    "favicon", "net::ERR_ABORTED", "Download the React DevTools",
    "was preloaded using link preload", "third-party cookie",
    "[vite] connecting", "[vite] connected", "ResizeObserver loop",
    // Les échecs réseau sont déjà captés proprement (avec l'URL) par le
    // listener "response" — la version console est du bruit dupliqué.
    "Failed to load resource",
    // HMR / websocket du serveur de preview : jamais un bug du site, et
    // l'IA ne peut pas le « corriger » → il revenait à chaque passe.
    "[vite]", "[hmr]", "WebSocket connection", "server connection lost",
    // Avertissements de dev React (clé manquante, act(), etc.) : pas des
    // crashs. Les « corriger » relançait des tours pour rien.
    "Warning: ", "Download the Apollo DevTools",
    // [2026-10-03] Client HMR de Vite sous l'aperçu (clientPort 443, injoignable
    // depuis le Chrome du QA) : rejet non catché « WebSocket closed without
    // opened. » sur CHAQUE page. Ce n'est pas le site — l'IA « corrigeait »
    // donc les 17 pages pour rien, puis le retrouvait au re-test.
    "WebSocket closed without opened",
  ];
  return noise.some(n => msg.includes(n));
}

// ─── Anti-boucle ─────────────────────────────────────────────────────────────
// Bug signalé : « quand l'IA a fini le site, elle travaille à l'infini : elle
// trouve des bugs, se corrige, et ça remet la même chose ». Cause : un bug que
// la correction ne résout pas (souvent hors du fichier corrigé, ou du bruit)
// revenait à CHAQUE passe → mêmes annonces « N bugs détectés / correction… »
// encore et encore. On identifie donc chaque bug par une SIGNATURE stable et
// on ne retente jamais deux fois la même.

/**
 * Chemin d'un lien du DOM RELATIF À L'APP. Sous l'aperçu, le router a un
 * `basename` (= base Vite, `/api/companies/<id>/preview`) : un `<Link to="/contact">`
 * est rendu `href="/api/companies/<id>/preview/contact"`. Sans retirer ce
 * préfixe, CHAQUE lien du menu était signalé « route inexistante » sur CHAQUE
 * page (14 faux bugs × 17 pages), et le QA tournait sans fin sur des liens
 * qui marchent. `basePath` = chemin de l'URL de base (ex. `/api/.../preview/`).
 */
export function toAppPath(raw: string, basePath: string): string | null {
  const t = normalizeTarget(raw);
  if (t === null) return null;
  const base = (basePath || "/").replace(/\/+$/, "");
  if (!base) return t;
  if (t === base) return "/";
  if (t.startsWith(`${base}/`)) return t.slice(base.length) || "/";
  return t;
}

/**
 * Un statut HTTP est-il un vrai bug ? 401/403 = « non connecté / non autorisé » :
 * c'est la réponse NORMALE d'une API protégée au robot de test anonyme (et du
 * login quand il soumet des identifiants de test). Ce n'est pas corrigeable
 * dans le code et revenait à chaque passe.
 */
export function isHttpBug(status: number): boolean {
  return status >= 400 && status !== 401 && status !== 403;
}

/**
 * Requête HTTP en échec qui SORT de l'app (même origine, hors de la base de
 * l'aperçu et hors API) : signature d'une navigation dure
 * `window.location.href = "/x"` qui ignore le basename. Réparée de façon
 * déterministe (link-guard), jamais envoyée à l'IA — qui inventait une autre
 * route et cassait des liens justes.
 */
export function isBaseEscapeHttp(b: Pick<LiveBug, "kind" | "message">, baseUrl: string): boolean {
  if (b.kind !== "http") return false;
  const m = b.message.match(/https?:\/\/\S+/);
  if (!m) return false;
  try {
    const base = new URL(baseUrl);
    const u = new URL(m[0]);
    if (u.origin !== base.origin) return false;
    const basePath = base.pathname.replace(/\/+$/, "");
    if (!basePath) return false; // base "/" : rien ne peut en sortir
    return !(u.pathname === basePath || u.pathname.startsWith(`${basePath}/`)) && !u.pathname.startsWith("/api/");
  } catch { return false; }
}

/** Signature stable d'un bug (insensible aux nombres, ids, query strings, lignes:colonnes). */
export function bugSignature(b: Pick<LiveBug, "kind" | "route" | "message">): string {
  const msg = String(b.message || "")
    .replace(/\?[^\s"')]*/g, "")          // query strings (?t=123, ?v=hash)
    .replace(/:\d+:\d+/g, "")                 // positions fichier:ligne:col
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")        // hashes / ids
    .replace(/\d+/g, "0")                     // nombres
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    .toLowerCase();
  return `${b.kind}|${b.route}|${msg}`;
}

export interface QaRoundDecision {
  /** Bugs à envoyer en correction ce tour-ci (jamais tentés auparavant). */
  toFix: LiveBug[];
  /** Vrai : on s'arrête (plus rien de NOUVEAU à corriger). */
  stop: boolean;
  /** Bugs déjà tentés qui reviennent (non résolus par la correction précédente). */
  recurring: number;
}

/**
 * Décide du tour suivant à partir des bugs observés et des signatures déjà
 * tentées. Pure (testable) ; met à jour `attempted` avec ce qui sera tenté.
 */
export function planQaRound(bugs: LiveBug[], attempted: Set<string>): QaRoundDecision {
  const toFix: LiveBug[] = [];
  let recurring = 0;
  const thisRound = new Set<string>();
  for (const b of bugs) {
    const sig = bugSignature(b);
    if (attempted.has(sig)) { recurring++; continue; }
    if (thisRound.has(sig)) continue;
    thisRound.add(sig);
    toFix.push(b);
  }
  thisRound.forEach(s => attempted.add(s));
  return { toFix, stop: toFix.length === 0, recurring };
}

/**
 * Visite chaque route de la carte via le navigateur, collecte les erreurs JS,
 * les pages blanches et les requêtes échouées, puis fait une passe
 * d'interaction bornée (clics de boutons, remplissage de formulaires).
 */
export async function runLiveQA(
  baseUrl: string, // ex: http://localhost:5200/api/companies/<id>/preview/
  map: AppMap,
  onProgress?: Progress,
  isCancelled?: () => boolean,
): Promise<LiveBug[]> {
  const bugs: LiveBug[] = [];
  const statics = map.routes.filter(r => !r.dynamic);
  const dynamics = map.routes.filter(r => r.dynamic);
  // Table de routes pour valider les liens réellement présents dans le DOM.
  const table = {
    paths: map.routeTable?.paths ?? statics.map(r => r.route),
    dynamic: map.routeTable?.dynamic ?? dynamics.map(r => r.route),
    hasCatchAll: true,
  };
  /** route dynamique → URL concrète trouvée dans un vrai lien de l'app. */
  const discovered = new Map<string, string>();
  let basePath = "/";
  try { basePath = new URL(baseUrl).pathname; } catch { /* baseUrl relative : pas de préfixe */ }
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });

    // Teste UNE route (chemin concret `routePath`, qui peut être l'instance
    // réelle d'une route dynamique comme /produit/abc pour /produit/:id).
    const visit = async (r: AppMapRoute, routePath: string) => {
      const pageBugs: LiveBug[] = [];
      const page = await ctx.newPage();
      const seen = new Set<string>();
      const add = (kind: LiveBug["kind"], message: string, detail?: string) => {
        const key = `${kind}|${message.slice(0, 160)}`;
        if (seen.has(key) || isNoise(message)) return;
        seen.add(key);
        pageBugs.push({ route: routePath, page: r.name, file: r.file, kind, message: message.slice(0, 500), detail });
      };
      page.on("pageerror", err => add("pageerror", String(err?.message || err)));
      page.on("console", msg => { if (msg.type() === "error") add("console", msg.text()); });
      page.on("response", res => {
        const s = res.status();
        if (isHttpBug(s) && res.url().startsWith(baseUrl.replace(/\/api\/.*/, ""))) {
          const u = res.url();
          if (!u.includes("favicon")) add("http", `HTTP ${s} sur ${u.slice(0, 200)}`);
        }
      });

      const target = baseUrl.replace(/\/$/, "") + routePath;
      try {
        await page.goto(target, { waitUntil: "networkidle", timeout: 15000 });
      } catch (e: any) {
        add("blank", `Navigation échouée vers ${routePath}: ${String(e?.message || e).slice(0, 200)}`);
      }
      await page.waitForTimeout(600);

      // Page blanche = le rendu React a planté (souvent une erreur non catchée).
      let bodyText = "";
      try {
        bodyText = (await page.evaluate(() => document.body?.innerText || "")) as string;
        if (bodyText.trim().length < 20) add("blank", `Page "${r.name}" (${routePath}) quasi vide — rendu React probablement planté`);
      } catch { /* page fermée/crashée */ }

      // Une route CÂBLÉE qui affiche pourtant la page 404 = routage cassé.
      if (bodyText && bodyText.trim().length < 600 && /page introuvable|page not found|404/i.test(bodyText)) {
        add("notfound", `La route ${routePath} affiche la page 404 alors qu'elle est câblée dans le router — la page attendue ne se rend pas`);
      }

      // ── Vérification des liens internes RÉELLEMENT présents dans le DOM ──
      // Un lien vers une route inexistante = clic utilisateur → page 404. C'est
      // le bug « site cassé » le plus visible, et il était invisible pour le QA
      // (qui ne cliquait que des <button>, jamais des liens).
      try {
        const hrefs = (await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]")).map(a => a.getAttribute("href") || ""),
        )) as string[];
        for (const raw of hrefs) {
          const t = toAppPath(raw, basePath);
          if (t === null) continue;
          if (routeExists(t, table)) {
            // Sert d'échantillon réel pour tester les routes dynamiques.
            for (const d of table.dynamic) {
              if (discovered.has(d)) continue;
              const ds = d.split("/").filter(Boolean);
              const ts = t.split("/").filter(Boolean);
              if (ds.length === ts.length && ds.every((s, i) => s.startsWith(":") || s === ts[i])) discovered.set(d, t);
            }
            continue;
          }
          add("link", `Lien interne vers "${t}" — cette route n'existe pas dans le router, le clic mène à la page 404`,
            `Routes existantes: ${[...table.paths, ...table.dynamic].join(", ")}`);
        }
      } catch { /* page crashée — déjà signalé */ }

      // ── Passe d'interaction bornée (budget total par page) ──
      // Voir live-qa-interaction.ts : avant, une page couverte par une modale
      // ou un bandeau cookies coûtait ~80 s (30 s par libellé de bouton
      // détaché + 2 s par clic masqué).
      const budget = interactionBudget(QA_INTERACTION_BUDGET_MS);
      try {
        // Remplir les champs texte visibles avant de cliquer (les submits testent
        // alors le vrai chemin "création").
        const inputs = page.locator('input:visible:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea:visible');
        const nInputs = Math.min(await inputs.count(), 8);
        for (let i = 0; i < nInputs && !budget.over(); i++) {
          try {
            const el = inputs.nth(i);
            const type = (await el.getAttribute("type", { timeout: actionTimeout(QA_PROBE_TIMEOUT_MS, budget) })) || "text";
            const val = type === "email" ? "test@velbaz.app" : type === "number" ? "3" : type === "date" ? "2026-07-14" : "Test";
            await el.fill(val, { timeout: actionTimeout(QA_FILL_TIMEOUT_MS, budget) });
          } catch { /* champ readonly/disabled/détaché — pas un bug en soi */ }
        }
        // Cliquer jusqu'à ~12 boutons par page. On reste sur la page (on re-goto
        // si un clic a navigué) pour garder le contexte de test.
        const buttons = page.locator("button:visible");
        const nBtns = Math.min(await buttons.count(), 12);
        let failures = 0;
        for (let i = 0; i < nBtns; i++) {
          if (isCancelled?.()) break;
          const el = buttons.nth(i);
          let probe: ButtonProbe;
          try {
            probe = await el.evaluate(probeButtonInPage, undefined, { timeout: actionTimeout(QA_PROBE_TIMEOUT_MS, budget) });
          } catch {
            // Bouton disparu (re-rendu par le clic précédent) : un échec.
            failures++;
            if (clickDecision({ budgetLeftMs: budget.left(), consecutiveFailures: failures, label: "", covered: false }) === "stop") break;
            continue;
          }
          const decision = clickDecision({ budgetLeftMs: budget.left(), consecutiveFailures: failures, label: probe.label, covered: probe.covered });
          if (decision === "stop") break;
          if (decision === "skip") continue;
          try {
            await el.click({ timeout: actionTimeout(QA_CLICK_TIMEOUT_MS, budget) });
            failures = 0;
          } catch {
            failures++; // bouton détaché/instable — pas un bug en soi
            continue;
          }
          await page.waitForTimeout(350);
          if (!page.url().startsWith(target)) {
            if (budget.over()) break;
            await page.goto(target, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(300);
          }
        }
      } catch { /* la page a crashé pendant l'interaction — les listeners ont capté l'erreur */ }

      await page.close().catch(() => {});
      if (pageBugs.length) {
        onProgress?.(`🐛 ${r.name} (${routePath}) — ${pageBugs.length} problème(s) détecté(s)`);
        bugs.push(...pageBugs);
      } else {
        onProgress?.(`✔️ ${r.name} (${routePath}) — OK`);
      }
    };

    // Plusieurs onglets à la fois : l'essentiel du temps d'une page est de
    // l'attente (réseau, animations), qui se recouvre.
    await forEachConcurrent(statics, QA_PAGE_CONCURRENCY, r => visit(r, r.route), isCancelled);
    // Routes dynamiques (/produit/:id) : testées avec une URL réelle relevée
    // dans les liens de l'app. Ces pages de détail concentrent les crashs
    // (accès à un objet introuvable) et n'étaient jamais testées. Après les
    // routes statiques : c'est là que les vrais liens sont relevés.
    const testableDynamics: Array<{ r: AppMapRoute; concrete: string }> = [];
    for (const r of dynamics) {
      const concrete = discovered.get(r.route);
      if (!concrete) { onProgress?.(`↷ ${r.name} (${r.route}) — aucun lien réel trouvé, non testable`); continue; }
      testableDynamics.push({ r, concrete });
    }
    await forEachConcurrent(testableDynamics, QA_PAGE_CONCURRENCY, d => visit(d.r, d.concrete), isCancelled);
    await ctx.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  return bugs;
}

// ─── 3. Correction automatique des bugs détectés ─────────────────────────────

/**
 * Regroupe les bugs par fichier source, envoie code + bugs au modèle QA qui
 * renvoie des diffs SEARCH/REPLACE, applique localement. Retourne les fichiers
 * modifiés (à réécrire sur disque + re-persister en DB).
 */
export async function fixBugsLive(
  bugs: LiveBug[],
  files: ScaffoldFile[],
  onProgress?: Progress,
  isCancelled?: () => boolean,
  /** Routes réelles du router : l'IA ne doit jamais en inventer d'autres. */
  knownRoutes?: string[],
): Promise<ScaffoldFile[]> {
  const byFile = new Map<string, LiveBug[]>();
  for (const b of bugs) {
    const key = b.file;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(b);
  }
  const changed: ScaffoldFile[] = [];
  for (const [filePath, fileBugs] of byFile) {
    // Arrêt demandé : on ne lance plus aucun appel IA (avant, la correction des
    // 17 fichiers continuait après le clic sur « Arrêter »).
    if (isCancelled?.()) break;
    const file = files.find(f => f.path === filePath || f.path.endsWith(`/${filePath}`));
    if (!file) continue;
    onProgress?.(`🔧 Correction de ${filePath} (${fileBugs.length} bug(s))…`);
    const bugList = fileBugs.map((b, i) =>
      `${i + 1}. [${b.kind}] sur ${b.route}: ${b.message}${b.detail ? `\n   Détail: ${b.detail}` : ""}`).join("\n");
    const prompt = `Un test AUTOMATISÉ dans un vrai navigateur (Chrome) a détecté ces bugs RÉELS à l'exécution sur la page "${fileBugs[0].page}":

## BUGS DÉTECTÉS EN LIVE
${bugList}

## CODE ACTUEL (${filePath})
\`\`\`tsx
${file.content}
\`\`\`

${knownRoutes?.length ? `## ROUTES EXISTANTES (router de l'app)
${knownRoutes.join(", ")}
Ne remplace JAMAIS un lien ou une redirection vers une route absente de cette liste, et ne modifie pas un lien qui pointe déjà vers une de ces routes.

` : ""}## MISSION
Corrige TOUS ces bugs. N'ajoute JAMAIS de route ni de lien contenant "/api/companies/" (c'est l'adresse interne de l'aperçu, pas une page du site). Causes fréquentes: accès à une propriété d'un objet undefined/null (ajouter des gardes ?. et des états de chargement), .map sur non-tableau, appel API vers une route inexistante (corriger l'URL ou gérer l'erreur), handler qui throw, état initial incorrect.

## FORMAT DE RÉPONSE — DIFFS CIBLÉS UNIQUEMENT
<<<<<<< SEARCH
(extrait EXACT du code actuel, copié caractère pour caractère, assez long pour être unique)
=======
(le remplacement corrigé)
>>>>>>> REPLACE

Règles: le SEARCH doit exister TEL QUEL dans le code. Un bloc par bug. Aucun texte hors des blocs.`;

    // Tentative 1 : diffs ciblés. Tentative 2 (si le diff ne s'applique pas ou
    // si l'appel échoue) : RÉÉCRITURE COMPLÈTE du fichier. Avant, un diff non
    // applicable ou une erreur réseau faisait abandonner le bug SILENCIEUSEMENT
    // — l'utilisateur recevait un site « vérifié » avec le bug intact.
    let done = false;
    for (const attempt of [1, 2] as const) {
      if (done) break;
      try {
        if (attempt === 1) {
          const { text } = await generateText({
            model: gateway(QA_MODEL),
            system: "Tu es un expert React/TypeScript qui corrige des bugs d'exécution détectés par des tests navigateur automatisés. Tu réponds UNIQUEMENT en blocs SEARCH/REPLACE.",
            prompt,
            maxOutputTokens: 8000,
          });
          const { code, applied } = applySearchReplace(file.content, text || "");
          if (applied > 0 && code !== file.content && leaksPreviewPath(file.content, code)) {
            onProgress?.(`⛔ ${filePath} — correction refusée : elle ajoutait un chemin interne de prévisualisation (/api/companies/…)`);
          } else if (applied > 0 && code !== file.content) {
            file.content = code; // mutation en place: le tableau `files` reste la source de vérité
            changed.push({ path: file.path, content: code });
            onProgress?.(`✅ ${filePath} — ${applied} correction(s) appliquée(s)`);
            done = true;
          }
        } else {
          onProgress?.(`🔁 ${filePath} — nouvelle tentative de correction (réécriture complète)…`);
          const { text } = await generateText({
            model: gateway(QA_MODEL),
            system: "Tu es un expert React/TypeScript. Tu corriges un fichier de composant et tu renvoies UNIQUEMENT le fichier complet corrigé, sans commentaire ni bloc de code markdown.",
            prompt: `${prompt}

⚠️ La réponse en diffs n'a pas pu être appliquée. Renvoie donc le FICHIER COMPLET corrigé (du premier import à la dernière ligne), en conservant STRICTEMENT le design, les textes, les imports existants et l'export par défaut. Ne change que ce qui est nécessaire pour supprimer les bugs listés. Aucun texte hors du code.`,
            maxOutputTokens: 16000,
          });
          const rewritten = stripCodeFence(text || "");
          // Garde-fous : un fichier tronqué ou vidé serait pire que le bug.
          const plausible =
            rewritten.length >= Math.floor(file.content.length * 0.6) &&
            /export default/.test(rewritten) &&
            (rewritten.match(/\{/g) || []).length === (rewritten.match(/\}/g) || []).length;
          if (plausible && rewritten !== file.content && leaksPreviewPath(file.content, rewritten)) {
            onProgress?.(`⛔ ${filePath} — réécriture refusée : elle ajoutait un chemin interne de prévisualisation (/api/companies/…)`);
          } else if (plausible && rewritten !== file.content) {
            file.content = rewritten;
            changed.push({ path: file.path, content: rewritten });
            onProgress?.(`✅ ${filePath} — fichier corrigé et réécrit`);
            done = true;
          }
        }
      } catch (e: any) {
        if (attempt === 2) onProgress?.(`⚠️ Correction de ${filePath} échouée: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    if (!done) onProgress?.(`⚠️ ${filePath} — bug(s) non corrigé(s) automatiquement, signalé(s) dans le rapport`);
  }
  return changed;
}

/** Vrai si la correction AJOUTE un chemin interne de l'aperçu Velbaz
 *  (`/api/companies/<id>/preview/...`) : l'IA « réparait » des 404 en créant
 *  des routes `/api/companies/:companyId/preview/profile` dans App.tsx — des
 *  pages fantômes qui n'existent pas sur le site publié. */
export function leaksPreviewPath(before: string, after: string): boolean {
  const count = (t: string) => (t.match(/\/api\/companies\//g) || []).length;
  return count(after) > count(before);
}

/** Retire une éventuelle clôture markdown autour d'un fichier renvoyé entier. */
function stripCodeFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:tsx?|jsx?|typescript|javascript)?\s*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}

// ─── 4. Passe unique : carte → test → correction → fin ───────────────────────

/** Bugs dont le fichier n'a reçu AUCUNE correction : ils restent ouverts. Les
 *  liens (réparés de façon déterministe) comptent comme traités si le fichier
 *  a été réécrit. Sans re-test, on ne peut rien affirmer de plus. */
export function unresolvedBugs(bugs: LiveBug[], fixedFiles: Iterable<string>): LiveBug[] {
  const fixed = [...fixedFiles];
  const isFixed = (file: string) => fixed.some(p => p === file || p.endsWith(`/${file}`) || file.endsWith(`/${p}`));
  return bugs.filter(b => !isFixed(b.file));
}

/** Ligne lisible d'un bug pour le fil de progression (le texte, pas un compteur). */
export function describeBug(b: LiveBug): string {
  const msg = b.message.replace(/\s+/g, " ").trim().slice(0, 160);
  return `• ${b.route} — [${b.kind}] ${msg}`;
}

/**
 * Une SEULE passe : on cherche les bugs une fois, on les corrige une fois, et
 * on s'arrête. Pas de re-test suivi d'une nouvelle correction : avant, la
 * boucle (jusqu'à 3 passes de test et 2 de correction) donnait l'impression
 * que l'IA « cherche des bugs à l'infini ». Le résultat dit honnêtement ce
 * qui a été corrigé et ce qui ne l'a pas été — sans prétendre avoir re-testé.
 */
export async function runLiveQAAndFix(opts: {
  baseUrl: string;
  plan: LiveQAPlan | undefined | null;
  files: ScaffoldFile[];
  /** Réécrit les fichiers modifiés sur disque (HMR Vite les recharge). */
  writeChanged: (changed: ScaffoldFile[]) => Promise<void>;
  onProgress?: Progress;
  isCancelled?: () => boolean;
}): Promise<LiveQAResult> {
  const { baseUrl, plan, files, writeChanged, onProgress, isCancelled } = opts;
  const map = buildAppMap(plan, files);

  // La carte est persistée dans les fichiers du projet (visible dans l'éditeur).
  const mapJson = JSON.stringify(map, null, 2);
  const existing = files.find(f => f.path === ".velbaz/app-map.json");
  if (existing) existing.content = mapJson;
  else files.push({ path: ".velbaz/app-map.json", content: mapJson });

  const testable = map.routes.filter(r => !r.dynamic).length;
  onProgress?.(`🗺️ Carte de l'app dressée — ${map.routes.length} pages, ${testable} testables en direct`);
  const result = (found: LiveBug[], bugs: LiveBug[], fixed: string[]): LiveQAResult =>
    ({ routesTested: testable, found, bugs, rounds: found.length ? 1 : 0, fixedFiles: fixed });

  if (isCancelled?.()) return result([], [], []);
  onProgress?.(`🧪 QA live — visite de chaque page dans un vrai navigateur (une seule passe)…`);
  const found = await runLiveQA(baseUrl, map, onProgress, isCancelled);
  if (!found.length) {
    onProgress?.(`🎉 QA live: toutes les pages fonctionnent — aucun bug détecté`);
    return result([], [], []);
  }
  if (isCancelled?.()) return result(found, found, []);

  // Doublons (même bug vu deux fois sur une page) : une seule correction.
  const { toFix } = planQaRound(found, new Set<string>());
  onProgress?.(`🐞 QA live: ${toFix.length} bug(s) à corriger sur ${new Set(toFix.map(b => b.route)).size} page(s)`);
  for (const b of toFix.slice(0, 25)) onProgress?.(describeBug(b));
  if (toFix.length > 25) onProgress?.(`… et ${toFix.length - 25} autre(s)`);

  const changed: ScaffoldFile[] = [];
  // 1) Liens morts → réparation DÉTERMINISTE (aucune IA) : on recâble vers la
  //    route existante la plus proche.
  const isDeterministic = (b: LiveBug) => b.kind === "link" || isBaseEscapeHttp(b, baseUrl);
  if (toFix.some(isDeterministic)) {
    const repair = repairInternalLinks(files);
    const summary = linkRepairSummary(repair);
    if (summary) onProgress?.(summary);
    changed.push(...repair.changed);
  }
  // 2) Le reste (crashs JS, pages blanches, 404 de routage, HTTP) → IA, une fois.
  const codeBugs = toFix.filter(b => !isDeterministic(b));
  if (codeBugs.length && !isCancelled?.()) changed.push(...(await fixBugsLive(codeBugs, files, onProgress, isCancelled,
    [...(map.routeTable?.paths ?? []), ...(map.routeTable?.dynamic ?? [])])));

  // Arrêt demandé pendant la correction : on n'écrit RIEN (sinon le QA
  // continuait d'écrire après « Arrêter » et écrasait d'autres écritures).
  if (isCancelled?.()) return result(found, found, []);

  const uniq = new Map<string, ScaffoldFile>();
  for (const f of changed) uniq.set(f.path, f);
  if (uniq.size) await writeChanged([...uniq.values()]);
  const fixed = [...uniq.keys()];
  const open = unresolvedBugs(found, fixed);
  onProgress?.(open.length
    ? `✅ QA terminé — ${fixed.length} fichier(s) corrigé(s), ${open.length} point(s) non corrigé(s) noté(s) dans le rapport`
    : `✅ QA terminé — ${fixed.length} fichier(s) corrigé(s)`);
  return result(found, open, fixed);
}
