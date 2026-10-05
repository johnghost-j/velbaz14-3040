import { describe, expect, test } from "bun:test";
import {
  ensureHomeRoute, finalizePlanPages, pageRank, removeUnrequestedShowroom, routeSlug, userAskedForShowroom,
  type PlanPageLike,
} from "./page-order";

const p = (name: string, route: string, extra: Partial<PlanPageLike> = {}): PlanPageLike => ({
  name, route, file: `${name.replace(/[^a-zA-Z]/g, "")}.tsx`, purpose: "", sections: "", ...extra,
});
const routes = (ps: Array<{ route: string }>) => ps.map(x => x.route);
const names = (ps: Array<{ name: string }>) => ps.map(x => x.name);

describe("page-order — Showroom jamais proposé d'office", () => {
  test("cas PasStride : Showroom sur / → Boutique hors de /, vrai Accueil ajouté sur /", () => {
    const { pages, changes } = finalizePlanPages(
      [p("Showroom", "/", { isCore: true }), p("Produit", "/produit/:id"), p("Panier", "/panier"), p("Commande", "/commande")],
      { appType: "ecommerce", lang: "fr", requestText: "cret une entreprise de chaussure", stripShowroom: true },
    );
    expect(names(pages)).toEqual(["Accueil", "Boutique", "Produit", "Panier", "Commande"]);
    expect(routes(pages)).toEqual(["/", "/boutique", "/produit/:id", "/panier", "/commande"]);
    expect(pages.some(x => /showroom/i.test(`${x.name} ${x.route} ${x.file}`))).toBe(false);
    expect(pages[0]!.sections).toContain("VRAI ACCUEIL");
    expect(changes.length).toBeGreaterThan(0);
  });

  test("cas Paselle : Showroom en doublon d'une page Collection → supprimé", () => {
    const { pages } = finalizePlanPages(
      [p("Showroom", "/"), p("Collection", "/collection"), p("Détail du modèle", "/modele/:id")],
      { appType: "brand", lang: "fr", requestText: "cret moi une mark de chaussre", stripShowroom: true },
    );
    expect(names(pages)).toEqual(["Accueil", "Collection", "Détail du modèle"]);
  });

  test("le mot « showroom » disparaît aussi des descriptions des autres pages", () => {
    const { pages } = removeUnrequestedShowroom(
      [p("Showroom", "/showroom"), p("Fiche", "/fiche/:id", { purpose: "Ouverte depuis le showroom" })],
      "une marque de montres", "fr",
    );
    expect(pages[1]!.purpose).toBe("Ouverte depuis le catalogue");
  });

  test("véhicules : le catalogue s'appelle « Modèles »", () => {
    const { pages } = removeUnrequestedShowroom([p("Showroom", "/")], "une marque de voitures électriques", "fr");
    expect(pages[0]!.name).toBe("Modèles");
  });

  test("demandé par la personne → gardé, mais jamais comme accueil", () => {
    expect(userAskedForShowroom("ajoute une page show-room")).toBe(true);
    const { pages } = finalizePlanPages(
      [p("Showroom", "/"), p("Contact", "/contact")],
      { appType: "ecommerce", lang: "fr", requestText: "je veux une page showroom", stripShowroom: true },
    );
    expect(names(pages)).toEqual(["Accueil", "Showroom", "Contact"]);
    expect(routes(pages)).toEqual(["/", "/showroom", "/contact"]);
  });

  test("pages choisies au questionnaire (stripShowroom false) : Showroom gardé", () => {
    const { pages } = finalizePlanPages(
      [p("Accueil", "/"), p("Showroom", "/showroom")],
      { appType: "ecommerce", lang: "fr", requestText: "", stripShowroom: false },
    );
    expect(names(pages)).toEqual(["Accueil", "Showroom"]);
  });
});

describe("page-order — vrai accueil + ordre logique", () => {
  test("cas Paséo : aucune page sur / et Contact en tête → Accueil ajouté, Contact en dernier", () => {
    const { pages } = finalizePlanPages(
      [p("Contact", "/contact"), p("Showroom", "/showroom"), p("Détail du modèle", "/modele/:id"), p("Alertes de disponibilité", "/alertes")],
      { appType: "ecommerce", lang: "fr", requestText: "une marque de chaussures", stripShowroom: true },
    );
    expect(names(pages)).toEqual(["Accueil", "Boutique", "Alertes de disponibilité", "Détail du modèle", "Contact"]);
    expect(pages.find(x => x.name === "Détail du modèle")!.showInNav).toBe(false);
  });

  test("cas MailFlow : Accueil remis sur / et avant Contact", () => {
    const { pages } = finalizePlanPages(
      [p("Contact", "/contact"), p("Accueil", "/accueil"), p("Services", "/services"), p("Tarifs", "/tarifs"), p("Prendre rendez-vous", "/prendre-rendez-vous")],
      { appType: "service", lang: "fr", requestText: "agence emailing", stripShowroom: true },
    );
    expect(names(pages)).toEqual(["Accueil", "Services", "Prendre rendez-vous", "Tarifs", "Contact"]);
    expect(pages[0]!.route).toBe("/");
  });

  test("ordre e-commerce : accueil, boutique, fiche, panier, à propos, journal, contact, FAQ", () => {
    const { pages } = finalizePlanPages(
      [p("FAQ", "/faq"), p("À propos", "/a-propos"), p("Journal", "/journal"), p("Panier", "/panier"), p("Accueil", "/"), p("Fiche produit", "/produit/:id"), p("Boutique", "/boutique")],
      { appType: "ecommerce", lang: "fr", stripShowroom: true },
    );
    expect(names(pages)).toEqual(["Accueil", "Boutique", "Panier", "Fiche produit", "À propos", "Journal", "FAQ"]);
    expect(pages.filter(x => x.showInNav).map(x => x.name)).toEqual(["Accueil", "Boutique", "À propos", "Journal", "FAQ"]);
  });

  test("une boutique sur / devient une page à part, l'accueil est ajouté (anglais)", () => {
    const { pages } = finalizePlanPages([p("Shop", "/"), p("About", "/about")], { appType: "ecommerce", lang: "en" });
    expect(names(pages)).toEqual(["Home", "Shop", "About"]);
    expect(routes(pages)).toEqual(["/", "/shop", "/about"]);
  });

  test("logiciel : l'espace de travail reste sur / (pas d'accueil ajouté)", () => {
    const { pages } = finalizePlanPages(
      [p("Tarifs", "/tarifs"), p("Projets", "/"), p("Projet", "/projet/:id")],
      { appType: "saas", lang: "fr", stripShowroom: true },
    );
    expect(names(pages)).toEqual(["Projets", "Projet", "Tarifs"]);
  });

  test("mode clone (keepOrder) : ordre du site source conservé", () => {
    const { pages } = finalizePlanPages(
      [p("Contact", "/contact"), p("Showroom", "/")],
      { appType: "ecommerce", lang: "fr", keepOrder: true, stripShowroom: true },
    );
    expect(names(pages)).toEqual(["Showroom", "Contact"]);
  });

  test("ensureHomeRoute ne choisit plus Contact quand une page de contenu existe", () => {
    const out = ensureHomeRoute([p("Contact", "/contact"), p("Collection", "/collection")]);
    expect(routes(out)).toEqual(["/contact", "/"]);
  });

  test("rangs et slug sans accents", () => {
    expect(pageRank(p("Mentions légales", "/mentions-legales"))).toBe(7);
    expect(pageRank(p("Commander en ligne", "/commander"))).toBe(1);
    expect(routeSlug("Détail du modèle")).toBe("detail-du-modele");
  });
});
