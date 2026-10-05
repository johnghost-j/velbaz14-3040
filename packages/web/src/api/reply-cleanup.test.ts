import { describe, expect, it } from "bun:test";
import { cleanReply, sanitizeStepLabel, stripLeakedContext } from "./agents/reply-cleanup";
import { createStepNarrator, type NarratedStep } from "./agents/step-narrator";

describe("stripLeakedContext", () => {
  it("retire la ligne de contexte système en tête", () => {
    const out = stripLeakedContext("Current date: 2026-09-19\n\nVoilà le plan pour ton site.");
    expect(out).toBe("Voilà le plan pour ton site.");
  });

  it("retire la variante française et l'heure", () => {
    const out = stripLeakedContext(
      "DATE ACTUELLE : samedi 19 septembre 2026 (nous sommes en 2026).\nCurrent time (UTC): 09:12\nOn démarre.",
    );
    expect(out).toBe("On démarre.");
  });

  it("retire la ligne en fin de réponse", () => {
    const out = stripLeakedContext("Ton site est prêt.\n\n- Current date: 2026-09-19");
    expect(out).toBe("Ton site est prêt.");
  });

  it("garde une phrase normale qui mentionne la date", () => {
    const txt = "Aujourd'hui, 19 septembre, on lance la campagne.";
    expect(stripLeakedContext(txt)).toBe(txt);
  });

  it("ne mange pas une ligne de contexte au milieu du corps", () => {
    const txt = "Résumé du brief :\nCurrent date: 2026-09-19\nSuite du texte.";
    expect(stripLeakedContext(txt)).toBe(txt);
  });

  it("renvoie du vide quand la réponse n'était QUE du contexte système", () => {
    // Cas signalé par l'utilisateur : le message affiché valait exactement ça.
    expect(stripLeakedContext("Current date: 2026-09-19")).toBe("");
    expect(stripLeakedContext("- Current date: 2026-09-19\n\nCurrent time (UTC): 09:12")).toBe("");
    expect(stripLeakedContext("")).toBe("");
  });
});

describe("cleanReply", () => {
  it("remplace une réponse 100 % contexte système par un message lisible (FR)", () => {
    const out = cleanReply("Current date: 2026-09-19", "corrige mon site stp");
    expect(out).not.toContain("Current date");
    expect(out.length).toBeGreaterThan(10);
    expect(out).toContain("vide");
  });

  it("choisit l'anglais quand la demande est en anglais", () => {
    const out = cleanReply("Current date: 2026-09-19", "fix my landing page now");
    expect(out).not.toContain("Current date");
    expect(out).toContain("empty");
  });

  it("laisse une vraie réponse intacte", () => {
    expect(cleanReply("Ton site est prêt.", "ok")).toBe("Ton site est prêt.");
  });
});

describe("sanitizeStepLabel", () => {
  it("coupe le contexte système collé au libellé", () => {
    expect(sanitizeStepLabel("Analyse du contexte du projetCurrent date: 2026-09-19"))
      .toBe("Analyse du contexte du projet");
  });

  it("coupe le caractère orphelin laissé par la fuite", () => {
    expect(sanitizeStepLabel("Analyse du contexte du projetùCurrent date: 2026-09-19"))
      .toBe("Analyse du contexte du projet");
  });

  it("ne garde qu'une seule ligne", () => {
    expect(sanitizeStepLabel("Compréhension de la demande\nDATE ACTUELLE : samedi"))
      .toBe("Compréhension de la demande");
  });

  it("laisse un libellé propre intact", () => {
    expect(sanitizeStepLabel("Rédaction du contenu")).toBe("Rédaction du contenu");
  });
});

describe("createStepNarrator", () => {
  it("relaie l'étape sans ajouter de phrase de narration", () => {
    const seen: NarratedStep[] = [];
    const narrate = createStepNarrator((s) => seen.push(s));
    narrate({ id: "understand", label: "Compréhension de la demande" });
    narrate.finish();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.label).toBe("Compréhension de la demande");
    expect(seen[0]!.note).toBeUndefined();
  });

  it("ne duplique pas la même étape consécutive", () => {
    const seen: NarratedStep[] = [];
    const narrate = createStepNarrator((s) => seen.push(s));
    narrate({ id: "understand", label: "Compréhension de la demande" });
    narrate({ id: "understand", label: "Compréhension de la demande" });
    narrate({ id: "understand-bis", label: "  compréhension de la demande  " });
    narrate({ id: "analyze", label: "Analyse du contexte du projet" });
    expect(seen.map((s) => s.id)).toEqual(["understand", "analyze"]);
  });

  it("laisse passer un même id avec un libellé différent", () => {
    const seen: NarratedStep[] = [];
    const narrate = createStepNarrator((s) => seen.push(s));
    narrate({ id: "write", label: "Rédaction de la réponse" });
    narrate({ id: "write", label: "Recherche et rédaction de la réponse" });
    expect(seen).toHaveLength(2);
  });

  it("nettoie le libellé émis", () => {
    const seen: NarratedStep[] = [];
    const narrate = createStepNarrator((s) => seen.push(s));
    narrate({ id: "analyze", label: "Analyse du contexte du projetCurrent date: 2026-09-19" });
    expect(seen[0]!.label).toBe("Analyse du contexte du projet");
  });
});
