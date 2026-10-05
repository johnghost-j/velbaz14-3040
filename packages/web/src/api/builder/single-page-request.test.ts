import { describe, expect, test } from "bun:test";
import { isSinglePageRequest } from "./single-page-request";

// [2026-10-04] « … avec une page showroom » donnait un plan d'UNE page blanche.
describe("isSinglePageRequest — « une page X » n'est pas un site d'une page", () => {
  for (const t of [
    "une marque de meubles avec une page showroom",
    "crée-moi une marque de chaussures et ajoute une page showroom",
    "je veux une page contact et une page FAQ en plus",
    "un restaurant avec une autre page pour le menu",
    "a furniture brand with a page for the showroom",
  ]) test(`non : ${t}`, () => expect(isSinglePageRequest(t)).toBe(false));

  for (const t of [
    "une page blanche",
    "crée un site avec une page blanche",
    "juste une page",
    "une seule page pour mon café",
    "fais-moi une page de vente pour mon livre",
    "a single page site",
    "blank page",
  ]) test(`oui : ${t}`, () => expect(isSinglePageRequest(t)).toBe(true));
});
