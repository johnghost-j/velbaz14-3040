import { describe, expect, it } from "bun:test";
import { composeBuildRecap } from "./build-recap";

const pages = [
  { name: "Accueil", route: "/" },
  { name: "Boutique", route: "/shop" },
  { name: "Produit", route: "/product/:id" },
  { name: "Panier", route: "/cart" },
];

describe("composeBuildRecap", () => {
  it("raconte en français ce qui a été construit, à partir des faits", () => {
    const t = composeBuildRecap({
      companyName: "Paséo", lang: "fr", appType: "ecommerce", pages, fileCount: 55,
      qa: { routesTested: 18, found: 0, fixed: 0, unresolved: 0 },
      realProducts: 3, docs: { marketing: 5, visibility: 6 },
    });
    expect(t).toContain("**Paséo est prêt**");
    expect(t).toContain("une boutique en ligne de 4 pages : Accueil, Boutique, Produit, Panier.");
    expect(t).toContain("55 fichiers de code écrits");
    expect(t).toContain("18 pages testées dans un vrai navigateur : aucun bug trouvé");
    expect(t).toContain("3 produits réels branchés");
    expect(t).toContain("11 documents prêts (stratégie marketing et pack presse & visibilité)");
    expect(t).not.toContain("Your project is ready");
  });

  it("passe en anglais quand le projet est en anglais", () => {
    const t = composeBuildRecap({ companyName: "MailFlow", lang: "en-US", appType: "saas", pages: pages.slice(0, 1), fileCount: 30 });
    expect(t).toContain("**MailFlow is ready**");
    expect(t).toContain("I built a SaaS app with 1 page: Accueil.");
    expect(t).toContain("30 code files written");
  });

  it("dit honnêtement quand le test navigateur n'a pas pu tourner", () => {
    const t = composeBuildRecap({ companyName: "X", lang: "fr", pages, fileCount: 10, qa: { unavailable: true } });
    expect(t).toContain("n'a pas pu tourner");
    expect(t).not.toContain("aucun bug");
  });

  it("annonce les bugs restants sans prétendre que tout est corrigé", () => {
    const t = composeBuildRecap({ companyName: "X", lang: "fr", pages, fileCount: 10, qa: { routesTested: 4, found: 3, fixed: 1, unresolved: 2 } });
    expect(t).toContain("3 bugs trouvés, 2 encore à corriger");
    const ok = composeBuildRecap({ companyName: "X", lang: "fr", pages, fileCount: 10, qa: { routesTested: 1, found: 1, fixed: 1, unresolved: 0 } });
    expect(ok).toContain("1 page testée dans un vrai navigateur : 1 bug trouvé, corrigé");
    const all = composeBuildRecap({ companyName: "X", lang: "fr", pages, fileCount: 10, qa: { routesTested: 4, found: 2, fixed: 2, unresolved: 0 } });
    expect(all).toContain("2 bugs trouvés, tous corrigés");
  });

  it("propose de remplacer le contenu d'exemple quand il y en a", () => {
    const t = composeBuildRecap({ companyName: "X", lang: "fr", pages, fileCount: 10, demoContent: true });
    expect(t).toContain("remplace le contenu d'exemple");
  });

  it("reste correct sans pages, sans faits, et pour un site HTML multi-pages", () => {
    const t = composeBuildRecap({ companyName: "  ", lang: "fr", pages: [], fileCount: 0 });
    expect(t).toContain("**Ton projet est prêt**");
    expect(t).toContain("J'ai construit une application web.");
    expect(t).not.toContain("Ce que j'ai fait");
    const s = composeBuildRecap({ companyName: "Y", lang: "fr", pages, fileCount: 4, staticSite: true });
    expect(s).toContain("J'ai construit un site de 4 pages");
    expect(s).not.toContain("fichiers de code");
  });

  it("résume les longues listes de pages et dédoublonne", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `P${i}` })).concat([{ name: "P0" }]);
    const t = composeBuildRecap({ companyName: "X", lang: "fr", pages: many, fileCount: 1 });
    expect(t).toContain("9 pages : P0, P1, P2, P3, P4, P5 et 3 autres.");
  });

  it("signale l'app mobile", () => {
    expect(composeBuildRecap({ companyName: "X", lang: "fr", pages, fileCount: 1, mobile: "built" })).toContain("l'app mobile est construite aussi");
    expect(composeBuildRecap({ companyName: "X", lang: "en", pages, fileCount: 1, mobile: "failed" })).toContain("the mobile app failed");
  });
});
