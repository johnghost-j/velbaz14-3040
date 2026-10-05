import { describe, expect, test } from "bun:test";
import { printDesignPrompt, requestedDesignText } from "./print-design-prompt";

// Bug réel 2026-10-03 : « mug avec un loup minimaliste » → design avec un
// slogan inventé « SAUVAGES LOUPS ».
describe("texte du design : seulement celui demandé", () => {
  test.each([
    ["ajoute un mug avec un loup minimaliste", null],
    ["ajoute un t-shirt avec écrit Wolf Pack", "Wolf Pack"],
    ["ajoute un hoodie « Born to run »", "Born to run"],
    ['ajoute un mug "Coffee first"', "Coffee first"],
    ["ajoute une casquette avec notre logo", "PasStride"],
  ])("%s → %s", (msg, expected) => {
    expect(requestedDesignText(msg, "PasStride")).toBe(expected);
  });

  test("null → texte interdit dans le prompt", () => {
    const p = printDesignPrompt({ concept: "loup minimaliste", text: null });
    expect(p).toContain("ABSOLUTELY NO TEXT");
    expect(p).not.toContain("Typography, if any");
  });

  test("texte imposé → seul ce texte", () => {
    expect(printDesignPrompt({ concept: "loup", text: "Wolf Pack" })).toContain('exactly "Wolf Pack"');
  });

  test("option absente → comportement historique", () => {
    expect(printDesignPrompt({ concept: "loup" })).toContain("Typography, if any");
  });
});
