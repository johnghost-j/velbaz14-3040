import { describe, expect, test } from "bun:test";
import { detectFeatures, humanizePageName, pickEmailLang, renderProjectReadyEmail, summarizeReactPages } from "./project-ready";

const base = {
  projectName: "SoulStride",
  ownerName: "Sam",
  description: "Des sneakers pensées pour marcher loin.",
  projectUrl: "https://velbaz.com/chat/abc",
  pages: ["Accueil", "Détail produit", "Panier", "Accueil"],
  features: ["Catalogue produits", "Panier persistant"],
  baseUrl: "https://velbaz.com/",
};

describe("email « projet prêt »", () => {
  test("email complet en français : sujet, titre, pages, CTA, étapes, texte", () => {
    const m = renderProjectReadyEmail(base);
    expect(m.subject).toContain("SoulStride est prêt");
    expect(m.html).toContain("<!DOCTYPE html>");
    expect(m.html).toContain('lang="fr"');
    expect(m.html).toContain("Ouvrir mon projet");
    expect(m.html).toContain('href="https://velbaz.com/chat/abc"');
    expect(m.html).toContain("Prochaines étapes");
    expect(m.html).toContain("Détail produit");
    expect(m.html).toContain("3 pages"); // doublon « Accueil » retiré
    expect(m.html).toContain("https://velbaz.com/velbaz-logo-120-dark.png");
    expect(m.text).toContain("Ouvrir mon projet : https://velbaz.com/chat/abc");
    expect(m.text).toContain("✓ Panier");
    expect(m.text).not.toContain("<");
  });

  test("échappe le HTML venant de l'utilisateur", () => {
    const m = renderProjectReadyEmail({ ...base, projectName: "<script>x</script>", ownerName: '"><img>' });
    expect(m.html).not.toContain("<script>x</script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).not.toContain('"><img>');
  });

  test("anglais + lien du site en ligne", () => {
    const m = renderProjectReadyEmail({ ...base, lang: "en", liveUrl: "https://soulstride.com" });
    expect(m.subject).toContain("is ready");
    expect(m.html).toContain("Open my project");
    expect(m.html).toContain("View the live site");
    expect(m.html).toContain('href="https://soulstride.com"');
  });

  test("helpers", () => {
    expect(pickEmailLang('["en","fr"]')).toBe("en");
    expect(pickEmailLang('["nl"]')).toBe("fr");
    expect(pickEmailLang(null)).toBe("fr");
    // '["en"]' est le défaut de la colonne → pas un signal : français sauf texte nettement anglais
    expect(pickEmailLang('["en"]', "Marque de chaussures vendant directement à ses clients")).toBe("fr");
    expect(pickEmailLang('["en"]', "A shoe brand that sells directly to the customers with a great app")).toBe("en");
    expect(pickEmailLang('["en"]', "")).toBe("fr");
    expect(pickEmailLang('["fr","en"]', "A shoe brand that sells to the customers")).toBe("fr");
    expect(humanizePageName("ProductDetail.tsx")).toBe("Product Detail");
    expect(humanizePageName("mes-commandes")).toBe("Mes commandes");
    const f = detectFeatures(["src/lib/catalog.ts", "src/pages/Cart.tsx", "src/pages/Checkout.tsx", "src/pages/Login.tsx"]);
    expect(f).toContain("Catalogue produits");
    expect(f).toContain("Paiement sécurisé");
    expect(f).toContain("Comptes clients");
  });

  test("pages React : traduites, connexion et légal regroupés, NotFound masqué", () => {
    const p = summarizeReactPages(["src/pages/Orders.tsx", "src/pages/Home.tsx", "src/pages/ProductDetail.tsx",
      "src/pages/Login.tsx", "src/pages/Signup.tsx", "src/pages/Privacy.tsx", "src/pages/Terms.tsx",
      "src/pages/NotFound.tsx", "src/pages/Settings.tsx", "src/pages/Support.tsx"]);
    expect(p).toEqual(["Accueil", "Mes commandes", "Fiche produit", "Support", "Connexion & inscription",
      "Pages légales (mentions, confidentialité, CGU, cookies)"]);
  });
});
