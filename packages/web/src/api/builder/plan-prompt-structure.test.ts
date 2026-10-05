import { describe, expect, test } from "bun:test";
import { PLAN_PROMPT, PLAN_PROMPT_LIGHT, type BuildContext } from "./prompts";
import { PAGE_STRUCTURE_RULES } from "./page-structure-rules";

// [2026-10-04] Les prompts de planification imposaient « Showroom = page
// principale (route "/") » pour toute marque → l'IA mettait le Showroom en
// accueil. On vérifie que ce défaut a disparu et que les règles OUI / NON
// sont bien envoyées au modèle.
const ctx: BuildContext = { companyName: "Test", idea: "crée-moi une marque de chaussures", lang: "fr" };

describe("prompts de plan — structure des pages", () => {
  for (const [name, fn] of [["PLAN_PROMPT", PLAN_PROMPT], ["PLAN_PROMPT_LIGHT", PLAN_PROMPT_LIGHT]] as const) {
    test(`${name} contient les règles OUI / NON`, () => {
      expect(fn(ctx)).toContain(PAGE_STRUCTURE_RULES);
    });
    test(`${name} ne propose plus le Showroom comme page par défaut`, () => {
      const withoutRules = fn(ctx).replace(PAGE_STRUCTURE_RULES, "");
      expect(withoutRules.toLowerCase()).not.toContain("showroom");
    });
    test(`${name} met l'Accueil en "/" pour une marque`, () => {
      expect(fn(ctx)).toMatch(/Accueil[^\n]*"\/"/);
    });
  }

  test("les règles interdisent le Showroom sauf demande explicite", () => {
    expect(PAGE_STRUCTURE_RULES).toContain("JAMAIS de page « Showroom »");
    expect(PAGE_STRUCTURE_RULES).toContain("sauf si l'utilisateur a écrit lui-même « showroom »");
    expect(PAGE_STRUCTURE_RULES).toContain("✅ OUI");
    expect(PAGE_STRUCTURE_RULES).toContain("❌ NON");
  });
});
