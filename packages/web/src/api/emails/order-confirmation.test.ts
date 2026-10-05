import { describe, expect, test } from "bun:test";
import { renderOrderConfirmationEmail, formatMoney } from "./order-confirmation";
import { isRecentCheckout, orderConfirmationRowId, publicSiteUrl } from "./order-confirmation-send";

const base = {
  shopName: "AtelierRue",
  orderRef: "CMD-AB12CD34",
  date: new Date("2026-10-01T10:00:00Z"),
  customerName: "Marie Dupont",
  customerEmail: "marie@example.com",
  items: [{ name: "Tee brodé", quantity: 2, unitPrice: 25, variantLabel: "M / Noir" }],
  total: 54.9,
  currency: "EUR",
  shipping: { name: "Marie Dupont", line1: "1 rue de Paris", zip: "75001", city: "Paris", country: "FR" },
  receiptUrl: "https://pay.stripe.com/receipts/abc",
  siteUrl: "https://velbaz.com/s/atelierrue",
};

describe("e-mail de confirmation de commande", () => {
  test("fr : sujet, ref, total, articles, livraison, reçu", () => {
    const m = renderOrderConfirmationEmail({ ...base, lang: "fr" });
    expect(m.subject).toContain("CMD-AB12CD34");
    expect(m.subject).toContain("AtelierRue");
    expect(m.html).toContain("Merci");
    expect(m.html).toContain("Tee brodé");
    expect(m.html).toContain("M / Noir");
    expect(m.html).toContain(formatMoney(54.9, "EUR", "fr"));
    expect(m.html).toContain("75001 Paris");
    expect(m.html).toContain("https://pay.stripe.com/receipts/abc");
    expect(m.text).toContain("CMD-AB12CD34");
    expect(m.text).toContain("https://pay.stripe.com/receipts/abc");
  });

  test("en", () => {
    const m = renderOrderConfirmationEmail({ ...base, lang: "en", currency: "usd" });
    expect(m.subject).toMatch(/^Thanks for your order/);
    expect(m.html).toContain("Total paid");
    expect(m.html).toContain("$54.90");
  });

  test("échappe le HTML (nom client, produit, boutique)", () => {
    const m = renderOrderConfirmationEmail({
      ...base, shopName: "<b>Shop</b>", customerName: "<script>x</script>",
      items: [{ name: '<img src=x onerror="alert(1)">', quantity: 1, unitPrice: 1 }],
    });
    expect(m.html).not.toContain("<script>x</script>");
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).not.toContain("<b>Shop</b>");
    expect(m.html).toContain("&lt;b&gt;Shop&lt;/b&gt;");
  });

  test("sans reçu Stripe ni livraison ni lien : pas de bouton, pas de bloc vide", () => {
    const m = renderOrderConfirmationEmail({ ...base, receiptUrl: null, shipping: null, siteUrl: null });
    expect(m.html).not.toContain("Télécharger le reçu");
    expect(m.html).not.toContain("Livraison à");
    expect(m.html).not.toContain("Retour à la boutique");
  });

  test("URL de reçu non http(s) ignorée", () => {
    const m = renderOrderConfirmationEmail({ ...base, receiptUrl: "javascript:alert(1)" });
    expect(m.html).not.toContain("javascript:");
  });
});

describe("garde-fous d'envoi", () => {
  const now = 1_790_000_000;
  test("paiement récent → envoi ; ancien (synchro 30 j) → JAMAIS", () => {
    expect(isRecentCheckout({ created: now - 60 }, false, now)).toBe(true);
    expect(isRecentCheckout({ created: now - 23 * 3600 }, true, now)).toBe(true);
    expect(isRecentCheckout({ created: now - 25 * 3600 }, true, now)).toBe(false);
    expect(isRecentCheckout({ created: now - 10 * 86400 }, true, now)).toBe(false);
  });
  test("sans date Stripe : seulement une commande tout juste créée", () => {
    expect(isRecentCheckout({}, true, now)).toBe(true);
    expect(isRecentCheckout({}, false, now)).toBe(false);
    expect(isRecentCheckout(null, false, now)).toBe(false);
  });
  test("id de verrou stable", () => {
    expect(orderConfirmationRowId("abc")).toBe("ordconf-abc");
  });
  test("lien boutique : domaine perso > sous-domaine > aperçu", () => {
    expect(publicSiteUrl({ id: "c1", published: true, customDomain: "shop.fr", customDomainStatus: "live", subdomain: "s" }, "https://velbaz.com"))
      .toBe("https://shop.fr");
    expect(publicSiteUrl({ id: "c1", published: true, subdomain: "s" }, "https://velbaz.com/")).toBe("https://velbaz.com/s/s");
    expect(publicSiteUrl({ id: "c1", published: false }, "https://velbaz.com")).toBe("https://velbaz.com/api/companies/c1/preview/");
  });
});
