import { describe, it, expect } from "bun:test";
import {
  soldObjectType,
  soldObjectLabel,
  isGarmentType,
  packshotPrompt,
  objectAnglePrompt,
} from "./product-prompt";

/**
 * Bug couvert ici — compte de test, 2026-09-25 : « j'avais demandé une marque
 * de chaussure et les images sorties c'était pas l'image du produit lui-même,
 * c'était des images de autre chose. »
 *
 * Le prompt se branchait sur le secteur (« Fashion ») et demandait un vêtement
 * porté par un mannequin. Ces tests verrouillent la règle inverse : on décrit
 * l'OBJET vendu, et « porté par un mannequin » n'est réservé qu'aux vêtements.
 */
describe("soldObjectType / soldObjectLabel", () => {
  it("reconnaît la chaussure comme objet vendu d'une marque de baskets", () => {
    const input = { idea: "une marque de chaussures de sport haut de gamme", industry: "Fashion" };
    expect(soldObjectType(input)).toBe("shoe");
    expect(soldObjectLabel(input)).toContain("sneakers");
  });

  it("ne devine aucun objet quand l'activité n'en nomme pas", () => {
    const input = { idea: "un cabinet de conseil en stratégie", industry: "Consulting" };
    expect(soldObjectType(input)).toBeNull();
    // Chaîne vide : les appelants gardent leur formulation générique.
    expect(soldObjectLabel(input)).toBe("");
  });

  it("ne contraint pas le type quand le merch est demandé explicitement", () => {
    // 'explicit_request' → plusieurs types restent valides, donc pas de label.
    const input = { idea: "je veux vendre du merch avec mon logo", industry: "Music" };
    expect(soldObjectType(input)).toBeNull();
  });

  it("tolère une entrée vide", () => {
    expect(soldObjectType({})).toBeNull();
    expect(soldObjectLabel({})).toBe("");
  });
});

describe("isGarmentType", () => {
  it("traite le textile comme vêtement", () => {
    expect(isGarmentType("t-shirt")).toBe(true);
    expect(isGarmentType("hoodie")).toBe(true);
  });

  it("ne traite PAS la chaussure comme un vêtement", () => {
    // C'est le cœur du bug : une chaussure se porte, mais la photographier
    // « sur un mannequin » donne une personne en pied dont les chaussures
    // occupent 5 % de l'image.
    expect(isGarmentType("shoe")).toBe(false);
    expect(isGarmentType("mug")).toBe(false);
  });

  it("gère null / undefined", () => {
    expect(isGarmentType(null)).toBe(false);
    expect(isGarmentType(undefined)).toBe(false);
  });
});

describe("packshotPrompt", () => {
  const prompt = packshotPrompt({
    label: "pair of sneakers (footwear)",
    name: "Apex Runner",
    description: "low-top white leather sneaker with a red sole",
  });

  it("nomme l'objet vendu comme sujet de la photo", () => {
    expect(prompt).toContain("pair of sneakers (footwear)");
    expect(prompt).toContain("Apex Runner");
    expect(prompt).toContain("red sole");
  });

  it("interdit explicitement le mannequin et le vêtement de substitution", () => {
    expect(prompt).toContain("NO model or person");
    expect(prompt).toContain("NO garment");
    expect(prompt).toContain("NO mannequin");
  });

  it("interdit la planche technique et le swatch — ce que la vitrine affichait", () => {
    expect(prompt).toContain("technical drawing");
    expect(prompt.toLowerCase()).toContain("swatch");
  });

  it("n'évoque le coloris que s'il est fourni", () => {
    expect(prompt).not.toContain("colorway:");
    const withConcept = packshotPrompt({
      label: "pair of sneakers (footwear)",
      name: "Apex Runner",
      concept: "matte black with gold lace tips",
    });
    expect(withConcept).toContain("matte black with gold lace tips");
  });
});

describe("objectAnglePrompt", () => {
  const label = "pair of sneakers (footwear)";
  const desc = "low-top white leather sneaker";

  it("angle model : l'objet est porté mais cadré serré, pas un portrait mode", () => {
    const p = objectAnglePrompt("model", label, desc);
    expect(p).toContain("camera is close on the");
    expect(p).toContain("no full-body fashion portrait");
  });

  it("chaque angle nomme l'objet et bannit le vêtement de substitution", () => {
    for (const angle of ["model", "studio", "lifestyle", "flat"]) {
      const p = objectAnglePrompt(angle, label, desc);
      expect(p).toContain(label);
      expect(p).toContain("NO garment substitution");
      expect(p).toContain("NO technical drawing");
    }
  });

  it("un angle inconnu retombe sur le packshot studio", () => {
    expect(objectAnglePrompt("nawak", label, desc)).toBe(
      objectAnglePrompt("studio", label, desc),
    );
  });
});
