import { describe, expect, it } from "bun:test";
import { extractJSONObject } from "./extract-json";

describe("extractJSONObject", () => {
  it("lit un JSON dont les chaînes contiennent des blocs de code (cas réel du pack visibilité)", () => {
    const obj = {
      intro: "Voici le pack",
      files: [{ name: "Sites de Référence", content: "Page :\n```html\n<style>body{margin:0}</style>\n<h1>Paséo</h1>\n```\nFin." }],
    };
    expect(extractJSONObject(JSON.stringify(obj))).toEqual(obj);
  });

  it("enlève une enveloppe ```json qui entoure la réponse", () => {
    expect(extractJSONObject('```json\n{"a":1,"b":"```x```"}\n```')).toEqual({ a: 1, b: "```x```" });
  });

  it("tolère du texte autour et une virgule finale", () => {
    expect(extractJSONObject('Voici :\n{"a":[1,2,],}\nMerci')).toEqual({ a: [1, 2] });
  });

  it("renvoie null sans objet lisible", () => {
    expect(extractJSONObject("")).toBeNull();
    expect(extractJSONObject("pas de json")).toBeNull();
    expect(extractJSONObject('{"a":')).toBeNull();
    expect(extractJSONObject("[1,2]")).toBeNull();
  });
});
