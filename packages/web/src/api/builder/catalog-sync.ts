// ─── Produits créés APRÈS le site → branchés dans le site ────────────────────
// [2026-10-01] Bug signalé : « l'IA a créé un design avec Printify mais après,
// le site fini ne met pas le produit dedans ». Mesuré sur un vrai projet
// (AtelierRue) :
//   +30 s  le build démarre et lit le catalogue → VIDE ;
//   +62 s  le moteur conclut « contenu d'exemple » (aucun produit réel) ;
//   +86 s  l'utilisateur valide la marque → les 2 produits Printify (t-shirt,
//          hoodie) sont insérés en base… mais le site est déjà écrit avec des
//          produits d'exemple (`data.list("products")`), sans `catalog.ts`.
// Rien ne rattrapait ce décalage : les produits existaient (Printify + base),
// le site ne les montrait jamais et ne pouvait pas les vendre.
//
// Ce module est le filet : après un build ET après la validation de la marque,
// il compare le catalogue réel au site. Catalogue absent du site → il injecte
// `src/lib/catalog.ts` + `src/lib/legal.ts` et fait réécrire les pages boutique
// pour qu'elles affichent et vendent CES produits. Catalogue juste périmé (prix,
// photo) → il réécrit seulement le fichier, sans IA.
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../database/index";
import * as schema from "../database/schema";

export interface SiteFile { path: string; content: string; type?: string }

export interface SiteCatalogState {
  /** `src/lib/catalog.ts` présent dans le projet. */
  hasFile: boolean;
  /** Le fichier présent diffère du catalogue réel (prix, photo, produit ajouté…). */
  fileStale: boolean;
  /** Fichiers du site qui importent réellement `lib/catalog`. */
  consumers: string[];
  /** Ids du catalogue réel absents du fichier présent. */
  missingIds: string[];
  /** Les pages n'utilisent pas le catalogue → réécriture IA nécessaire. */
  needsWiring: boolean;
}

const CATALOG_PATH = "src/lib/catalog.ts";
const CATALOG_IMPORT = /from\s+["'](?:\.{1,2}\/)+(?:lib\/)?catalog["']|from\s+["']@\/lib\/catalog["']/;

/** État du site par rapport au catalogue réel (pur, testable). */
export function siteCatalogState(
  files: SiteFile[],
  catalogIds: string[],
  freshCatalogContent: string,
): SiteCatalogState {
  const file = files.find((f) => f.path === CATALOG_PATH);
  const consumers = files
    .filter((f) => f.path !== CATALOG_PATH && /^src\/.+\.(tsx|ts|jsx|js)$/.test(f.path) && CATALOG_IMPORT.test(f.content || ""))
    .map((f) => f.path);
  const missingIds = file ? catalogIds.filter((id) => !file.content.includes(id)) : [...catalogIds];
  return {
    hasFile: !!file,
    fileStale: !file || file.content !== freshCatalogContent,
    consumers,
    missingIds,
    needsWiring: catalogIds.length > 0 && (consumers.length === 0 || missingIds.length === catalogIds.length),
  };
}

// Pages qui ne vendent jamais rien : comptes, légal, système.
const NON_SHOP_PAGE = /^(Login|Signup|Register|Profile|Settings|Account|Terms|Privacy|LegalNotice|Legal[A-Za-z]*|Cookies|Support|NotFound|Success|Cancel|Faq|About|Contact|Blog[A-Za-z]*)$/i;
const SHOP_TERMS = /\b(products?|produits?|catalog(?:ue)?|panier|cart|checkout|commande|order|boutique|shop|collection|prix|price|priceCents|acheter|buy|add to cart|ajouter au panier|variant|taille|size)\b/gi;

/** Pages routées d'App.tsx (fichier → nom de composant). */
export function routedPageFiles(appTsx: string): string[] {
  const out: string[] = [];
  const re = /import\s+(\w+)\s+from\s+["']\.\/pages\/([\w/-]+?)(?:\.tsx)?["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(appTsx || ""))) {
    const file = `src/pages/${m[2]}.tsx`;
    // Utilisé en JSX (`<Showroom />`, aussi sous `<ProtectedRoute>`) ou en `component={X}`.
    if (new RegExp(`<${m[1]}[\\s/>]|component=\\{\\s*${m[1]}\\b`).test(appTsx)) out.push(file);
  }
  return [...new Set(out)];
}

/**
 * Pages à réécrire pour brancher le catalogue : les pages ROUTÉES qui parlent
 * de produits / panier / commande, les plus « boutique » d'abord. La page
 * d'accueil est gardée même si elle en parle peu : c'est la vitrine.
 */
export function pickShopTargets(files: SiteFile[], max = 5): string[] {
  const byPath = new Map(files.map((f) => [f.path, f.content || ""]));
  const appTsx = byPath.get("src/App.tsx") || "";
  let pages = routedPageFiles(appTsx).filter((p) => byPath.has(p));
  if (!pages.length) pages = files.map((f) => f.path).filter((p) => /^src\/pages\/[\w-]+\.tsx$/.test(p));
  const homeFile = (() => {
    const m = appTsx.match(/<Route[^>]*path=["']\/["'][^>]*element=\{\s*<(\w+)/) || appTsx.match(/<Route[^>]*index[^>]*element=\{\s*<(\w+)/);
    if (!m) return null;
    const imp = appTsx.match(new RegExp(`import\\s+${m[1]}\\s+from\\s+["']\\./pages/([\\w/-]+?)(?:\\.tsx)?["']`));
    return imp ? `src/pages/${imp[1]}.tsx` : null;
  })();
  const scored = pages
    .filter((p) => !NON_SHOP_PAGE.test(p.split("/").pop()!.replace(/\.tsx$/, "")))
    .map((p) => ({ p, score: (byPath.get(p)!.match(SHOP_TERMS) || []).length + (p === homeFile ? 5 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.p);
}

/** Consigne de réécriture donnée au moteur d'édition. */
export function catalogWiringInstruction(catalogPrompt: string): string {
  return `BRANCHE LE VRAI CATALOGUE DE LA MARQUE SUR CETTE PAGE. Les produits réels de la marque (fabriqués à la demande, déjà en vente — ne nomme JAMAIS le fabricant ni un outil sur le site) viennent d'être ajoutés dans src/lib/catalog.ts, mais le site affiche encore des produits D'EXEMPLE.
À FAIRE :
- Remplace TOUTE source de produits d'exemple (\`data.list("products")\`, tableaux de produits écrits en dur, produits factices, badges « Exemple ») par \`CATALOG\` importé depuis "../lib/catalog" (\`import { CATALOG, findProduct, variantOptions, type CatalogProduct, type CatalogVariant } from "../lib/catalog"\`). Plus aucun produit inventé.
- Fiche / lien produit : identifie le produit par \`p.id\` (paramètre d'URL ou ?id=) et relis-le avec \`findProduct(id)\` ; sans id, montre le premier produit de CATALOG.
- Panier / commande / confirmation : chaque ligne référence un produit de CATALOG par \`p.id\` (+ la variante choisie), le prix vient de \`priceCents\` (variante puis produit). Le paiement passe par checkout() de "../lib/api" avec \`productId: p.id\` et \`vid\` de la variante.
- GARDE le design, la mise en page, la langue, les textes et les sections de la page : seule la SOURCE des produits change.
${catalogPrompt}`;
}

// ─── Exécution ───────────────────────────────────────────────────────────────

const running = new Set<string>();

export interface CatalogSyncResult {
  status: "no_catalog" | "no_site" | "busy" | "conflict" | "up_to_date" | "file_updated" | "wired" | "wiring_failed";
  products?: number;
  changed?: string[];
  error?: string;
}

async function activity(companyId: string, action: "executing" | "completed" | "error", message: string) {
  await db.insert(schema.agentActivity)
    .values({ id: uuidv4(), companyId, agentRole: "engineering", action, message })
    .catch(() => {});
}

async function upsertProjectFiles(companyId: string, files: SiteFile[]) {
  const now = new Date().toISOString();
  for (const f of files) {
    const existing = await db.select().from(schema.projectFiles)
      .where(and(eq(schema.projectFiles.companyId, companyId), eq(schema.projectFiles.filePath, f.path)))
      .get().catch(() => null);
    if (existing) {
      await db.update(schema.projectFiles)
        .set({ content: f.content, version: (existing.version || 1) + 1, updatedAt: now })
        .where(eq(schema.projectFiles.id, existing.id)).catch(() => {});
    } else {
      await db.insert(schema.projectFiles).values({
        id: uuidv4(), companyId, filePath: f.path, content: f.content,
        fileType: f.path.startsWith("src/pages/") ? "page" : f.path.startsWith("src/components/") ? "component" : "asset",
        version: 1, createdAt: now, updatedAt: now,
      }).catch(() => {});
    }
  }
}

/**
 * Met le site d'une entreprise en phase avec son catalogue réel.
 * Ne lève jamais : un échec est annoncé dans l'activité, avec sa raison.
 *
 * `isBuilding` : si un build est en cours, on ne touche à rien — c'est la fin
 * de ce build qui rappellera cette fonction (sinon deux écritures concurrentes).
 */
export async function syncCatalogIntoSite(
  companyId: string,
  opts: { isBuilding?: () => boolean; push?: (msg: string) => void; fileOnly?: boolean } = {},
): Promise<CatalogSyncResult> {
  // Attribution des appels IA (réécriture des pages) au projet : sans contexte,
  // l'appel tourne détaché d'une requête et n'est attribué à personne.
  const { runWithAiContext } = await import("../ai-usage/context");
  return runWithAiContext({ feature: "builder", label: "catalog-sync", companyId }, async () => {
    const first = await syncCatalogIntoSiteInner(companyId, opts);
    if (first.status !== "conflict") return first;
    // Un fichier a changé pendant la réécriture : UNE reprise sur la version à
    // jour (relue en base). Un second conflit est annoncé, jamais écrasé.
    opts.push?.(`🔄 Le site a été modifié pendant le branchement (${(first.changed || []).join(", ")}) — je reprends sur la version à jour…`);
    const second = await syncCatalogIntoSiteInner(companyId, opts);
    if (second.status === "conflict") {
      const msg = `⚠️ Produits non branchés : le site est modifié en continu (${(second.changed || []).join(", ")}) — rien n'a été écrasé, redemande « mets mes produits dans le site » une fois les modifications finies`;
      opts.push?.(msg);
      if (!opts.push) await activity(companyId, "error", msg);
    }
    return second;
  });
}

/** Fichiers dont le contenu en base a changé depuis la lecture `before`. */
async function changedSince(companyId: string, before: SiteFile[], paths: string[]): Promise<string[]> {
  const rows = await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.companyId, companyId));
  const now = new Map(rows.map((r) => [r.filePath, r.content]));
  return detectConflicts(before, now, paths);
}

/** Pur : chemins dont la version actuelle diffère de celle lue au départ
 *  (fichier ajouté ou supprimé entre-temps compris). */
export function detectConflicts(before: SiteFile[], now: Map<string, string>, paths: string[]): string[] {
  const start = new Map(before.map((f) => [f.path, f.content]));
  return paths.filter((p) => start.get(p) !== now.get(p));
}

async function syncCatalogIntoSiteInner(
  companyId: string,
  opts: { isBuilding?: () => boolean; push?: (msg: string) => void; fileOnly?: boolean },
): Promise<CatalogSyncResult> {
  if (running.has(companyId)) return { status: "busy" };
  if (opts.isBuilding?.()) return { status: "busy" };
  running.add(companyId);
  const say = async (action: "executing" | "completed" | "error", msg: string) => {
    opts.push?.(msg);
    if (!opts.push) await activity(companyId, action, msg);
  };
  try {
    const company = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
    if (!company) return { status: "no_site" };
    const { brandCatalogBundle } = await import("./routes");
    const bundle = await brandCatalogBundle(companyId, company.name || "");
    if (!bundle || !bundle.products.length) return { status: "no_catalog" };

    const rows = await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.companyId, companyId));
    const files: SiteFile[] = rows
      .filter((r) => !String(r.filePath).startsWith("mobile/"))
      .map((r) => ({ path: r.filePath, content: r.content, type: r.fileType || undefined }));
    if (!files.some((f) => f.path === "src/App.tsx")) return { status: "no_site" };
    // Instantané du contenu LU (avant toute mutation en place par editApp ou
    // la réparation des liens) : base de la détection de conflit.
    const snapshot: SiteFile[] = files.map((f) => ({ path: f.path, content: f.content }));

    const catalogFile = bundle.files.find((f) => f.path === CATALOG_PATH)!;
    const legalFile = bundle.files.find((f) => f.path === "src/lib/legal.ts");
    const state = siteCatalogState(files, bundle.products.map((p) => p.id), catalogFile.content);
    if (!state.needsWiring && !state.fileStale) return { status: "up_to_date", products: bundle.products.length };
    // Resync automatique (changement de prix) : jamais de réécriture IA des pages en arrière-plan.
    if (opts.fileOnly && state.needsWiring) return { status: "up_to_date", products: bundle.products.length };

    const { writeFilesIncremental, buildWithAutoFix } = await import("./runner");

    // Cas simple : les pages lisent déjà CATALOG, seul le contenu a changé.
    if (!state.needsWiring) {
      const changed: SiteFile[] = [catalogFile];
      if (legalFile && !files.some((f) => f.path === legalFile.path)) changed.push(legalFile);
      await writeFilesIncremental(companyId, changed);
      await upsertProjectFiles(companyId, changed);
      await say("completed", `🛒 Catalogue du site mis à jour — ${bundle.products.length} produit(s) réel(s)`);
      return { status: "file_updated", products: bundle.products.length, changed: changed.map((f) => f.path) };
    }

    const names = bundle.products.map((p) => `« ${p.name} »`).join(", ");
    await say("executing", `🛒 ${bundle.products.length} produit(s) réel(s) trouvé(s) (${names}) mais absents du site — je les branche dans la boutique…`);

    // 1) Fichiers catalogue + légal injectés (comme au build).
    const injected: SiteFile[] = [catalogFile, ...(legalFile ? [legalFile] : [])];
    // Copies : la réparation des liens mute en place, `files` doit rester la
    // version lue (référence de « fichiers corrigés par l'auto-réparation »).
    const working = new Map(files.map((f) => [f.path, { ...f }]));
    for (const f of injected) working.set(f.path, { path: f.path, content: f.content, type: "asset" });

    // 2) Pages boutique réécrites sur CATALOG.
    const targets = pickShopTargets([...working.values()]);
    if (!targets.length) {
      await writeFilesIncremental(companyId, injected);
      await upsertProjectFiles(companyId, injected);
      await say("error", `⚠️ Catalogue ajouté au site, mais aucune page boutique trouvée pour afficher les produits`);
      return { status: "wiring_failed", products: bundle.products.length, error: "no_shop_page" };
    }
    let design: any;
    try { design = JSON.parse(working.get(".velbaz/design.json")?.content || ""); } catch { design = undefined; }
    const { editApp } = await import("./engine");
    const result = await editApp(
      catalogWiringInstruction(bundle.prompt),
      [...working.values()],
      design,
      opts.push,
      undefined,
      { targetFiles: targets },
    );
    const changed: SiteFile[] = [...injected];
    const upsertChanged = (c: SiteFile) => {
      const i = changed.findIndex((x) => x.path === c.path);
      if (i >= 0) changed[i] = c; else changed.push(c);
    };
    for (const c of result.changed) {
      upsertChanged(c);
      working.set(c.path, { path: c.path, content: c.content });
    }

    // 2b) Liens recâblés de façon DÉTERMINISTE : la réécriture IA remettait des
    //     liens vers des pages absentes du routeur (/legal/cgv, /legal?slug=…).
    const { repairInternalLinks, linkRepairSummary } = await import("./link-guard");
    const repair = repairInternalLinks([...working.values()]);
    for (const c of repair.changed) upsertChanged(c);
    const linkSummary = linkRepairSummary(repair);
    if (linkSummary) opts.push?.(linkSummary);

    // 2c) Concurrence optimiste : la réécriture IA prend plusieurs minutes. Si
    //     un autre écrivain (édition chat, QA…) a modifié un de ces fichiers
    //     entre-temps, on n'écrase RIEN : on rejoue sur la version à jour.
    const conflicts = await changedSince(companyId, snapshot, changed.map((f) => f.path));
    if (conflicts.length) return { status: "conflict", products: bundle.products.length, changed: conflicts };

    // 3) Écriture + compilation (auto-réparation si la réécriture casse le build).
    const dir = await writeFilesIncremental(companyId, changed);
    const built = await buildWithAutoFix(dir, [...working.values()].map((f) => ({ path: f.path, content: f.content })), opts.push);
    const builtMap = new Map(built.files.map((f) => [f.path, f.content]));
    const toPersist = new Map<string, SiteFile>();
    for (const f of changed) toPersist.set(f.path, { path: f.path, content: builtMap.get(f.path) ?? f.content });
    // Fichiers corrigés par l'auto-réparation (hors fichiers déjà listés).
    for (const [path, content] of builtMap) {
      const before = files.find((f) => f.path === path)?.content;
      if (!toPersist.has(path) && before !== undefined && before !== content) toPersist.set(path, { path, content });
    }
    await upsertProjectFiles(companyId, [...toPersist.values()]);

    // 4) Vérification réelle : au moins une page lit maintenant CATALOG.
    const after = siteCatalogState([...working.values()].map((f) => ({ ...f, content: builtMap.get(f.path) ?? f.content })), bundle.products.map((p) => p.id), catalogFile.content);
    if (after.consumers.length === 0) {
      await say("error", `⚠️ Produits réels ajoutés au catalogue du site, mais les pages n'ont pas pu être rebranchées dessus${built.ok ? "" : " (build en erreur)"} — redemande « mets mes produits dans le site »`);
      return { status: "wiring_failed", products: bundle.products.length, changed: [...toPersist.keys()], error: built.lastError };
    }
    // Le site vend maintenant de vrais produits : l'avertissement « contenu
    // d'exemple » posté au build n'est plus vrai.
    try {
      const { clearDemoContentAnnouncement } = await import("./demo-notice-chat");
      await clearDemoContentAnnouncement(companyId);
    } catch { /* best-effort */ }
    const pages = after.consumers.filter((p) => p.startsWith("src/pages/")).map((p) => p.split("/").pop()!.replace(/\.tsx$/, ""));
    await say("completed", `✅ Produits réels branchés au site : ${names} — visibles et achetables${pages.length ? ` (pages : ${pages.join(", ")})` : ""}${built.ok ? "" : " — build à vérifier"}`);
    return { status: "wired", products: bundle.products.length, changed: [...toPersist.keys()] };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 200);
    console.error("[catalog-sync]", companyId, e);
    await say("error", `⚠️ Impossible de brancher les produits réels au site : ${msg}`);
    return { status: "wiring_failed", error: msg };
  } finally {
    running.delete(companyId);
  }
}
