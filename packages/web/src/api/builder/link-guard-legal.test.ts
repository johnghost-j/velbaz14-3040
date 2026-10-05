import { describe, expect, test } from "bun:test";
import { bestRouteMatch, extractRouteTable } from "./link-guard";

const app = `<Route path="/" /><Route path="/produit" /><Route path="/livraison-express" /><Route path="/terms" /><Route path="/privacy" /><Route path="/legal-notice" /><Route path="/cookies" />`;
const table = extractRouteTable(app);

describe("liens légaux inventés → vraie page légale (plus l'accueil)", () => {
  test.each([
    ["/legal/cgv", "/terms"],
    ["/legal/retours", "/terms"],
    ["/conditions-generales", "/terms"],
    ["/legal/confidentialite", "/privacy"],
    ["/politique-de-confidentialité", "/privacy"],
    ["/legal/cookies", "/cookies"],
    ["/mentions-legales", "/legal-notice"],
    ["/legal", "/legal-notice"],
  ])("%s → %s", (target, route) => {
    expect(bestRouteMatch(target, table)).toBe(route);
  });

  test("une vraie route proche reste prioritaire", () => {
    expect(bestRouteMatch("/livraison-express-info", table)).toBe("/livraison-express");
  });

  test("sans page légale dans le routeur → rien (repli accueil inchangé)", () => {
    expect(bestRouteMatch("/legal/cgv", extractRouteTable(`<Route path="/" /><Route path="/shop" />`))).toBeNull();
  });

  test("lien non légal sans route proche → null", () => {
    expect(bestRouteMatch("/blog", table)).toBeNull();
  });
});
