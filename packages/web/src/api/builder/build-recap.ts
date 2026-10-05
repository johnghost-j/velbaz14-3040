// ─── Récap de fin de build, écrit DANS LE CHAT ──────────────────────────────
//
// [2026-10-04 — demande utilisateur] À la fin d'un gros build, l'IA « ne
// disait rien » : le chat affichait seulement « Your project is ready! 🎉 »,
// une phrase codée en dur côté navigateur, jamais enregistrée. Aucun texte ne
// racontait ce qui avait été construit, et les messages écrits par le serveur
// pendant la fin du build (stratégie marketing, pack visibilité, propositions)
// n'apparaissaient pas en direct : seul le message marketing était relu.
//
// Ici : un récap composé à partir des FAITS du build (pages réelles, fichiers,
// résultat du test navigateur, produits branchés, documents produits), posté
// comme DERNIER message assistant du build. Aucun appel IA : il ne peut ni
// échouer ni inventer quelque chose qui n'a pas été fait.

import { db } from "../database/index";
import * as schema from "../database/schema";
import { dbRetry } from "../db-retry";

export interface BuildRecapFacts {
  companyName: string;
  lang?: string | null;
  /** Type d'app du plan (ecommerce, saas, …). */
  appType?: string | null;
  /** Pages réellement construites (plan). */
  pages: Array<{ name: string; route?: string }>;
  fileCount: number;
  /** Résultat du test navigateur, ou `unavailable` si le navigateur n'a pas pu tourner. */
  qa?:
    | { routesTested: number; found: number; fixed: number; unresolved: number }
    | { unavailable: true };
  /** Produits réels branchés au site pendant ce build. */
  realProducts?: number;
  /** Le site affiche du contenu d'exemple (aucun produit réel fourni). */
  demoContent?: boolean;
  /** Documents produits pendant le build (marketing/…, visibilite/…). */
  docs?: { marketing: number; visibility: number };
  /** Build mobile demandé : résultat. */
  mobile?: "built" | "failed" | "declined";
  /** Site multi-pages HTML (chemin « SITE ») plutôt qu'une app React. */
  staticSite?: boolean;
}

const APP_TYPE_FR: Record<string, string> = {
  ecommerce: "une boutique en ligne",
  brand: "le site de ta marque",
  configurator: "un site avec configurateur",
  service: "un site de service",
  saas: "une application SaaS",
  marketplace: "une marketplace",
  productivity: "une application",
  social: "une application communautaire",
  dashboard: "un tableau de bord",
  tool: "un outil en ligne",
  game: "un jeu",
  tracker: "une application de suivi",
  static: "une page",
};
const APP_TYPE_EN: Record<string, string> = {
  ecommerce: "an online store",
  brand: "your brand's website",
  configurator: "a site with a configurator",
  service: "a service website",
  saas: "a SaaS app",
  marketplace: "a marketplace",
  productivity: "an app",
  social: "a community app",
  dashboard: "a dashboard",
  tool: "an online tool",
  game: "a game",
  tracker: "a tracking app",
  static: "a page",
};

const isFrench = (lang?: string | null) => !lang || /^fr/i.test(lang);

/** « A, B, C… et 4 autres » — les noms affichés tels quels, sans doublon. */
function listPages(pages: BuildRecapFacts["pages"], fr: boolean, max = 6): string {
  const names = [...new Set(pages.map((p) => String(p.name || "").trim()).filter(Boolean))];
  if (!names.length) return "";
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest <= 0) return shown.join(", ");
  return fr ? `${shown.join(", ")} et ${rest} autre${rest > 1 ? "s" : ""}` : `${shown.join(", ")} and ${rest} more`;
}

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

export function composeBuildRecap(f: BuildRecapFacts): string {
  const fr = isFrench(f.lang);
  const name = f.companyName.trim() || (fr ? "Ton projet" : "Your project");
  const nPages = new Set(f.pages.map((p) => p.name)).size;
  const kind = (fr ? APP_TYPE_FR : APP_TYPE_EN)[String(f.appType || "").toLowerCase()]
    || (fr ? (f.staticSite ? "un site" : "une application web") : (f.staticSite ? "a website" : "a web app"));
  const pageList = listPages(f.pages, fr);

  const lines: string[] = [];
  if (fr) {
    lines.push(`✅ **${name} est prêt** — tu peux le parcourir dans l'aperçu à droite.`);
    lines.push("");
    lines.push(nPages
      ? `J'ai construit ${kind} de ${nPages} ${plural(nPages, "page", "pages")} : ${pageList}.`
      : `J'ai construit ${kind}.`);
  } else {
    lines.push(`✅ **${name} is ready** — you can browse it in the preview on the right.`);
    lines.push("");
    lines.push(nPages
      ? `I built ${kind} with ${nPages} ${plural(nPages, "page", "pages")}: ${pageList}.`
      : `I built ${kind}.`);
  }

  const done: string[] = [];
  if (f.fileCount > 0 && !f.staticSite) {
    done.push(fr ? `${f.fileCount} fichiers de code écrits` : `${f.fileCount} code files written`);
  }
  if (f.qa) {
    if ("unavailable" in f.qa) {
      done.push(fr
        ? "le test dans un vrai navigateur n'a pas pu tourner — j'ai vérifié les liens et le routage directement dans le code"
        : "the real-browser test could not run — I checked links and routing directly in the code");
    } else {
      const q = f.qa;
      if (q.found === 0) {
        done.push(fr
          ? `${q.routesTested} ${plural(q.routesTested, "page testée", "pages testées")} dans un vrai navigateur : aucun bug trouvé`
          : `${q.routesTested} ${plural(q.routesTested, "page", "pages")} tested in a real browser: no bugs found`);
      } else {
        const tail = q.unresolved > 0
          ? (fr ? `, ${q.unresolved} encore à corriger` : `, ${q.unresolved} still to fix`)
          : (fr ? (q.found > 1 ? ", tous corrigés" : ", corrigé") : (q.found > 1 ? ", all fixed" : ", fixed"));
        done.push(fr
          ? `${q.routesTested} ${plural(q.routesTested, "page testée", "pages testées")} dans un vrai navigateur : ${q.found} ${plural(q.found, "bug trouvé", "bugs trouvés")}${tail}`
          : `${q.routesTested} ${plural(q.routesTested, "page", "pages")} tested in a real browser: ${q.found} ${plural(q.found, "bug", "bugs")} found${tail}`);
      }
    }
  }
  if (f.realProducts && f.realProducts > 0) {
    done.push(fr
      ? `${f.realProducts} ${plural(f.realProducts, "produit réel branché", "produits réels branchés")} à la boutique, prêts à être achetés`
      : `${f.realProducts} real ${plural(f.realProducts, "product", "products")} wired into the store, ready to buy`);
  }
  const nDocs = (f.docs?.marketing || 0) + (f.docs?.visibility || 0);
  if (nDocs > 0) {
    const what = [
      f.docs?.marketing ? (fr ? "stratégie marketing" : "marketing strategy") : "",
      f.docs?.visibility ? (fr ? "pack presse & visibilité" : "press & visibility pack") : "",
    ].filter(Boolean).join(fr ? " et " : " and ");
    done.push(fr
      ? `${nDocs} ${plural(nDocs, "document prêt", "documents prêts")} (${what}) — à télécharger ci-dessous`
      : `${nDocs} ${plural(nDocs, "document", "documents")} ready (${what}) — download them below`);
  }
  if (f.mobile === "built") done.push(fr ? "l'app mobile est construite aussi" : "the mobile app is built too");
  if (f.mobile === "failed") done.push(fr ? "l'app mobile a échoué — le site web, lui, est livré" : "the mobile app failed — the website is delivered");

  if (done.length) {
    lines.push("");
    lines.push(fr ? "Ce que j'ai fait :" : "What I did:");
    for (const d of done) lines.push(`• ${d}`);
  }

  lines.push("");
  if (f.demoContent) {
    lines.push(fr
      ? "Prochaine étape : remplace le contenu d'exemple par tes vrais produits, puis publie le site."
      : "Next step: replace the sample content with your real products, then publish the site.");
  } else {
    lines.push(fr
      ? "Dis-moi ce que tu veux changer, ou publie le site quand il te plaît."
      : "Tell me what you'd like to change, or publish the site when you're happy with it.");
  }
  return lines.join("\n");
}

/**
 * Poste le récap comme message assistant du chat du projet
 * (`sessionId === companyId`). Id déterministe : un rebuild remplace le récap
 * précédent et le redescend en bas du fil au lieu d'en empiler un second.
 * Les erreurs base (après les reprises de dbRetry) remontent à l'appelant.
 */
export async function postBuildRecap(companyId: string, facts: BuildRecapFacts): Promise<string> {
  const content = composeBuildRecap(facts);
  const id = `build-recap-${companyId}`;
  const createdAt = new Date();
  await dbRetry(() => db.insert(schema.chatMessages)
    .values({ id, sessionId: companyId, role: "assistant", content, model: "velbaz", createdAt } as any)
    .onConflictDoUpdate({ target: schema.chatMessages.id, set: { content, createdAt } as any }));
  return content;
}

/**
 * Comme `postBuildRecap`, pour la fin d'un build : le site est déjà livré, donc
 * un échec base (après reprises) ne fait pas échouer le job — mais il n'est
 * pas caché non plus : trace serveur + ligne visible dans le déroulé du build.
 */
export async function postBuildRecapVisible(
  companyId: string,
  warn: (msg: string) => void | Promise<void>,
  facts: BuildRecapFacts,
): Promise<void> {
  try {
    await postBuildRecap(companyId, facts);
  } catch (e: any) {
    console.error("[build-recap] récap non posté:", e);
    await warn(`⚠️ Récap final non enregistré dans le chat (${String(e?.message || e).slice(0, 120)})`);
  }
}
