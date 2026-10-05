// ─── APPLICATION DU LOGO GÉNÉRÉ AU SITE CONSTRUIT ───────────────────────────
//
// Pourquoi ce module existe (bug réel constaté le 2026-09-19) :
//
// Le logo de marque est généré EN PARALLÈLE de la construction du site (~40 s
// en tâche de fond). Le build, lui, lit le logo UNE SEULE FOIS à son démarrage
// (`getCompanyLogoUrl`). Sur les 3 projets réels en base, le build démarrait
// 10-20 s AVANT que le logo soit enregistré :
//
//   14:07:35  ⚙️ démarrage du build   → lit le logo : rien en base
//   14:07:46  🎨 génération du logo
//   14:07:52  ✅ logo enregistré      → trop tard, le site est déjà figé
//
// Résultat : `src/lib/brand.ts` gardait un LOGO_URL vide et `index.html` gardait
// le favicon de secours (rectangle de couleur + initiale). Le logo n'apparaissait
// donc NI dans l'onglet du navigateur, NI dans le header/footer — définitivement,
// alors que le build affichait « il sera appliqué dès qu'il est prêt ».
//
// Ce module tient cette promesse : dès qu'un logo est disponible (fin de
// génération à l'init, changement de logo validé, ou fin de build si le logo est
// arrivé entre-temps), on remet le vrai logo dans les fichiers du projet.
//
// Volontairement SANS attente bloquante : sonder la base en bloquant le build
// le ralentirait pour tout le monde. Ici on ne fait que rattraper, après coup,
// un logo déjà prêt.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../database/index";
import * as schema from "../database/schema";
import { buildFaviconSet, type FaviconSet } from "./favicon-square";

/** Fichiers du site qui portent le logo. */
const BRAND_RE = /(^|\/)src\/lib\/brand\.ts$/;
const INDEX_HTML_RE = /(^|\/)index\.html$/;

/**
 * Remplace la constante LOGO_URL dans `src/lib/brand.ts`.
 * Renvoie le contenu inchangé s'il n'y a rien à faire.
 *
 * Remplacement LIGNE PAR LIGNE, via une fonction de remplacement. Deux pièges
 * évités ici :
 *  1. un motif non-gourmand jusqu'au prochain point-virgule s'arrêtait au
 *     premier point-virgule de la valeur — celui de "data:image/jpeg;base64,…" —
 *     et laissait la fin de la data URI derrière lui : le fichier devenait du
 *     TypeScript invalide et l'aperçu cassait. JSON.stringify échappe les
 *     retours ligne, donc la constante tient toujours sur UNE ligne.
 *  2. une chaîne de remplacement interprète les motifs à dollar ; une fonction
 *     de remplacement pose la valeur telle quelle.
 */
export function patchBrandFile(content: string, logoUrl: string): string {
  const next = JSON.stringify(logoUrl);
  if (/^[ \t]*export const LOGO_URL\s*=/m.test(content)) {
    return content.replace(
      /^([ \t]*)export const LOGO_URL\s*=.*$/m,
      (_m, indent: string) => `${indent}export const LOGO_URL = ${next};`,
    );
  }
  return `${content.trimEnd()}\nexport const LOGO_URL = ${next};\n`;
}

/**
 * Remplace le favicon de l'onglet dans `index.html` (rel="icon" et
 * rel="apple-touch-icon") par la version CARRÉE du logo (`buildFaviconSet`).
 *
 * [2026-10-04] Prend un `FaviconSet`, plus le logo brut : un logo non carré
 * posé tel quel était étiré par le navigateur dans l'onglet.
 *
 * Le href est posé en attribut HTML : une data URI base64 ne contient jamais de
 * guillemet double, donc pas d'échappement à prévoir. On refuse quand même toute
 * valeur qui en contiendrait, plutôt que de produire un HTML cassé.
 */
export function patchIndexHtml(content: string, favicon: FaviconSet): string {
  if (favicon.icon.includes('"') || favicon.appleTouch.includes('"')) return content;
  const hrefFor = (rel: string) => (rel === "apple-touch-icon" ? favicon.appleTouch : favicon.icon);
  let out = content;
  let replaced = false;
  // `rel` peut précéder ou suivre `href` selon l'écriture — on gère les deux.
  out = out.replace(
    /<link\s+rel="(icon|apple-touch-icon)"\s+href="[^"]*"\s*\/?>/g,
    (_m, rel: string) => { replaced = true; return `<link rel="${rel}" href="${hrefFor(rel)}" />`; },
  );
  out = out.replace(
    /<link\s+href="[^"]*"\s+rel="(icon|apple-touch-icon)"\s*\/?>/g,
    (_m, rel: string) => { replaced = true; return `<link rel="${rel}" href="${hrefFor(rel)}" />`; },
  );
  // Aucun lien d'icône dans le document : on l'insère dans le <head>, sinon le
  // navigateur retomberait sur l'icône par défaut de Vite.
  if (!replaced && /<head>/.test(out)) {
    out = out.replace(
      /<head>/,
      () => `<head>\n    <link rel="icon" href="${favicon.icon}" />\n    <link rel="apple-touch-icon" href="${favicon.appleTouch}" />`,
    );
  }
  return out;
}

/** Le fichier utilise-t-il déjà ce logo ? (évite une révision inutile) */
export function siteAlreadyUsesLogo(brandContent: string, logoUrl: string): boolean {
  return brandContent.includes(JSON.stringify(logoUrl));
}

/** Logo de marque le plus récent de l'entreprise, "" s'il n'y en a pas. */
export async function latestLogo(companyId: string): Promise<string> {
  try {
    const asset = await db
      .select()
      .from(schema.designAssets)
      .where(and(eq(schema.designAssets.companyId, companyId), eq(schema.designAssets.type, "logo")))
      .orderBy(desc(schema.designAssets.createdAt))
      .get();
    return asset?.content?.trim() || "";
  } catch {
    return "";
  }
}

export interface AppliedLogoFile { path: string; content: string }

/**
 * Pose `logoUrl` dans les fichiers du projet, en base.
 *
 * - `src/lib/brand.ts` → constante LOGO_URL (header, footer, partout)
 * - `index.html`       → favicon de l'onglet
 *
 * Renvoie la liste des fichiers réellement modifiés (vide = rien à faire).
 */
export async function applyLogoToProjectFiles(
  companyId: string,
  logoUrl: string,
): Promise<AppliedLogoFile[]> {
  const url = (logoUrl || "").trim();
  if (!url) return [];

  const rows = await db
    .select()
    .from(schema.projectFiles)
    .where(eq(schema.projectFiles.companyId, companyId))
    .all()
    .catch(() => [] as any[]);
  if (!rows.length) return [];

  const targets = rows.filter((r: any) => BRAND_RE.test(r.filePath) || INDEX_HTML_RE.test(r.filePath));
  if (!targets.length) return [];

  // Favicon carré calculé une fois, seulement si le projet a un index.html.
  // Échec (logo illisible) → index.html n'est pas touché, et on le dit : on ne
  // pose jamais le logo brut, qui serait étiré dans l'onglet.
  let favicon: FaviconSet | null = null;
  if (targets.some((r: any) => INDEX_HTML_RE.test(r.filePath))) {
    try {
      favicon = await buildFaviconSet(url);
    } catch (e) {
      console.error(`[favicon] ${companyId} : favicon carré impossible, index.html inchangé —`, e);
    }
  }

  const now = new Date().toISOString();
  const changed: AppliedLogoFile[] = [];
  for (const row of targets) {
    const before: string = row.content || "";
    const isIndex = INDEX_HTML_RE.test(row.filePath);
    const after = isIndex
      ? (favicon ? patchIndexHtml(before, favicon) : before)
      : patchBrandFile(before, url);
    if (after === before) continue;
    await db
      .update(schema.projectFiles)
      .set({ content: after, updatedAt: now, version: (row.version || 1) + 1 })
      .where(eq(schema.projectFiles.id, row.id))
      .catch(() => {});
    changed.push({ path: row.filePath, content: after });
  }
  return changed;
}

/**
 * Rattrapage complet côté web : patch des fichiers + écriture disque + reload de
 * l'aperçu. Best-effort de bout en bout — on ne casse jamais l'appelant (init,
 * build, édition) parce qu'un logo n'a pas pu être posé.
 *
 * `logoUrl` omis → on lit le logo le plus récent de l'entreprise.
 */
export async function applyLogoToSite(
  companyId: string,
  logoUrl?: string,
  push?: (msg: string) => void,
): Promise<AppliedLogoFile[]> {
  try {
    const url = (logoUrl || (await latestLogo(companyId))).trim();
    if (!url) return [];
    const changed = await applyLogoToProjectFiles(companyId, url);
    if (!changed.length) return [];

    // Seuls les fichiers web vont sur le disque de l'aperçu web.
    const web = changed.filter((f) => !f.path.startsWith("mobile/"));
    if (web.length) {
      try {
        const { writeFilesIncremental, getRunningApp, startDevServer } = await import("./runner");
        const dir = await writeFilesIncremental(
          companyId,
          web.map((f) => ({ path: f.path, content: f.content })),
        );
        // `index.html` est lu au démarrage de Vite : le HMR ne le reprend pas.
        // On relance le serveur pour que l'onglet affiche vraiment le logo.
        if (web.some((f) => INDEX_HTML_RE.test(f.path)) && getRunningApp(companyId)) {
          await startDevServer(companyId, dir);
        }
      } catch {
        /* aperçu best-effort */
      }
    }
    push?.("🎨 Logo de marque appliqué au site (onglet, en-tête, pied de page)");
    return changed;
  } catch {
    return [];
  }
}

// Une seule tentative de réparation par entreprise et par process : l'aperçu
// passe par ici à CHAQUE requête proxifiée (HTML, assets, HMR), il est donc
// exclu d'interroger la base à chaque fois. Un test de Set suffit ensuite.
const healed = new Set<string>();

/**
 * Répare une fois les projets construits AVANT ce correctif : favicon de
 * secours dans l'onglet et LOGO_URL vide, alors qu'un logo existe en base.
 * Renvoie true si des fichiers ont réellement été corrigés.
 */
export async function healLogoOnce(companyId: string): Promise<boolean> {
  if (healed.has(companyId)) return false;
  try {
    const changed = await applyLogoToSite(companyId);
    // [2026-09-20] On ne marque "réparé" QUE si un fichier a vraiment été
    // corrigé. Avant, `healed.add` avait lieu inconditionnellement AVANT
    // l'appel : si ce premier passage tombait trop tôt (aperçu live démarré
    // avant même que le logo soit généré, ~40 s), `applyLogoToSite` ne
    // trouvait rien à faire (logo pas encore en base) et la SEULE tentative
    // autorisée par ce process était consommée pour rien — plus aucun essai
    // ultérieur ne pouvait réparer le favicon même une fois le logo prêt.
    if (changed.length > 0) healed.add(companyId);
    return changed.length > 0;
  } catch {
    return false;
  }
}
