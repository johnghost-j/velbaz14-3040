// Tests de non-régression du bug « crée-moi une marque de vêtement » (2026-09-16).
//
// Deux causes cumulées, testées ici :
//   1. un bloc [QUESTIONS] TRONQUÉ était jeté (parse strict) → on injectait un
//      questionnaire de repli générique ;
//   2. ce questionnaire de repli était calibré SaaS (« Petites entreprises »,
//      « Abonnement mensuel ») → l'utilisateur décrivait sans le vouloir une
//      offre B2B et le build produisait une agence qui crée des marques POUR
//      LES AUTRES au lieu de SA marque.

import { describe, expect, test } from "bun:test";
import { salvageQuestions, repairQuestionsBlock } from "./questions-salvage";

const strictParse = (reply: string) => {
  const m = reply.match(/\[QUESTIONS\]([\s\S]*?)\[\/QUESTIONS\]/);
  if (!m) return null;
  return JSON.parse(m[1]);
};

describe("salvageQuestions", () => {
  test("lit un bloc complet", () => {
    const q = salvageQuestions('[QUESTIONS][{"q":"Pays ?","options":[{"id":"fr","label":"France"}]}][/QUESTIONS]');
    expect(q).toHaveLength(1);
    expect(q![0].q).toBe("Pays ?");
  });

  test("renvoie null sans bloc", () => {
    expect(salvageQuestions("juste du texte")).toBeNull();
    expect(salvageQuestions("")).toBeNull();
  });

  test("récupère les questions d'un bloc coupé net (sans balise fermante)", () => {
    const truncated =
      '[QUESTIONS][{"q":"Pays ?","options":[{"id":"fr","label":"France"}]},' +
      '{"q":"Quel style de vêtements ?","options":[{"id":"street","label":"Streetwear"},{"id":"mini","label":"Minimaliste"},{"id":"lux","label":"Premi';
    const q = salvageQuestions(truncated);
    expect(q).toHaveLength(2);
    expect(q![1].q).toBe("Quel style de vêtements ?");
    // L'option coupée en plein mot est retirée, pas affichée mutilée.
    expect(q![1].options!.map((o) => o.label)).toEqual(["Streetwear", "Minimaliste"]);
  });

  test("abandonne une question dont le libellé est coupé en plein mot", () => {
    const q = salvageQuestions('[QUESTIONS][{"q":"Pays ?"},{"q":"Quel prix par pièc');
    expect(q).toHaveLength(1);
    expect(q![0].q).toBe("Pays ?");
  });

  test("passe en champ libre une question dont il ne reste pas assez d'options", () => {
    const q = salvageQuestions('[QUESTIONS][{"q":"Pays ?"},{"q":"Quel style ?","options":[{"id":"a","label":"Street');
    expect(q).toHaveLength(2);
    expect(q![1].options).toBeUndefined();
    expect(q![1].kind).toBe("text");
  });

  test("ignore les accolades présentes dans les libellés", () => {
    const q = salvageQuestions('[QUESTIONS][{"q":"Un nom entre { et } ?","kind":"text"}][/QUESTIONS]');
    expect(q).toHaveLength(1);
    expect(q![0].q).toBe("Un nom entre { et } ?");
  });
});

describe("repairQuestionsBlock", () => {
  test("reconstruit un bloc strictement parsable en gardant l'intro du modèle", () => {
    const truncated =
      "Super, on lance ta marque !\n\n[QUESTIONS][{\"q\":\"Pays ?\",\"options\":[{\"id\":\"fr\",\"label\":\"France\"}]},{\"q\":\"Quel style de vêtements ?\",\"options\":[{\"id\":\"a\",\"label\":\"Streetwear\"},{\"id\":\"b\",\"label\":\"Minimaliste\"},{\"id\":\"c\",\"label\":\"Prem";
    // Avant le correctif : sans balise fermante, la lecture stricte ne voyait
    // RIEN ⇒ bloc considéré absent ⇒ questionnaire générique injecté.
    expect(strictParse(truncated)).toBeNull();

    const rep = repairQuestionsBlock(truncated)!;
    expect(rep.reply.startsWith("Super, on lance ta marque !")).toBe(true);
    const parsed = strictParse(rep.reply);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(rep.questions).toHaveLength(2);
  });

  test("renvoie null quand il n'y a rien à récupérer", () => {
    expect(repairQuestionsBlock("aucune question ici")).toBeNull();
    expect(repairQuestionsBlock("[QUESTIONS][{\"q\":\"ab")).toBeNull();
  });
});
