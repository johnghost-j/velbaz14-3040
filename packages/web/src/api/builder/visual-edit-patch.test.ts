import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyStrictPatches, patchFileForVisualEdit } from "./visual-edit-patch";

const FILE = `export default function Contact() {
  return (
    <section>
      <h1 className="text-gray-900">Contactez-nous</h1>
      <p className="text-gray-500">Réponse sous 24 h</p>
      <p className="text-gray-500">Réponse sous 24 h</p>
    </section>
  );
}
`;

const block = (s: string, r: string) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

describe("applyStrictPatches", () => {
  it("applique un bloc unique", () => {
    const r = applyStrictPatches(FILE, block(`      <h1 className="text-gray-900">Contactez-nous</h1>`, `      <h1 className="text-teal-600">Contactez-nous</h1>`));
    expect(r.applied).toBe(1);
    expect(r.failed).toEqual([]);
    expect(r.code).toContain(`text-teal-600">Contactez-nous`);
    expect(r.code.replace("text-teal-600", "text-gray-900")).toBe(FILE);
  });

  it("refuse un extrait ambigu au lieu de modifier la première occurrence", () => {
    const r = applyStrictPatches(FILE, block(`      <p className="text-gray-500">Réponse sous 24 h</p>`, `      <p>x</p>`));
    expect(r.applied).toBe(0);
    expect(r.failed[0].reason).toBe("ambigu");
    expect(r.code).toBe(FILE);
  });

  it("signale un extrait introuvable", () => {
    const r = applyStrictPatches(FILE, block(`<h2>nope</h2>`, `<h2>x</h2>`));
    expect(r.failed[0].reason).toBe("introuvable");
  });

  it("tolère les espaces en fin de ligne", () => {
    const r = applyStrictPatches(FILE, block(`      <h1 className="text-gray-900">Contactez-nous</h1>   `, `      <h1>Écrivez-nous</h1>`));
    expect(r.applied).toBe(1);
    expect(r.code).toContain("<h1>Écrivez-nous</h1>");
  });

  it("garde les $ du remplacement tels quels", () => {
    const r = applyStrictPatches(FILE, block(`      <h1 className="text-gray-900">Contactez-nous</h1>`, "      <h1>{`$& ${price} $1`}</h1>"));
    expect(r.code).toContain("<h1>{`$& ${price} $1`}</h1>");
  });

  it("accepte un remplacement vide (suppression)", () => {
    const r = applyStrictPatches(FILE, `<<<<<<< SEARCH\n    <section>\n      <h1 className="text-gray-900">Contactez-nous</h1>\n=======\n    <section>\n>>>>>>> REPLACE`);
    expect(r.applied).toBe(1);
    expect(r.code).not.toContain("Contactez-nous");
  });
});

describe("patchFileForVisualEdit", () => {
  it("un seul appel IA quand le diff s'applique", async () => {
    let calls = 0;
    const out = await patchFileForVisualEdit({
      path: "src/pages/Contact.tsx", current: FILE, instruction: "titre en vert", lang: "fr",
      generate: async () => { calls++; return block(`      <h1 className="text-gray-900">Contactez-nous</h1>`, `      <h1 className="text-green-600">Contactez-nous</h1>`); },
    });
    expect(calls).toBe(1);
    expect(out?.code).toContain("text-green-600");
  });

  it("renvoie les blocs ratés au modèle puis réussit", async () => {
    const prompts: string[] = [];
    const out = await patchFileForVisualEdit({
      path: "src/pages/Contact.tsx", current: FILE, instruction: "x", lang: "fr",
      generate: async (_s, p) => {
        prompts.push(p);
        return prompts.length === 1
          ? block(`<h1>pas là</h1>`, `<h1>x</h1>`)
          : block(`      <h1 className="text-gray-900">Contactez-nous</h1>`, `      <h1>OK</h1>`);
      },
    });
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("<h1>pas là</h1>");
    expect(out?.attempts).toBe(2);
  });

  it("null après deux échecs (l'appelant réécrit le fichier)", async () => {
    const out = await patchFileForVisualEdit({
      path: "a.tsx", current: FILE, instruction: "x", lang: "fr",
      generate: async () => "je ne sais pas",
    });
    expect(out).toBeNull();
  });

  it("tout ou rien : un bloc raté sur deux n'applique rien", async () => {
    const out = await patchFileForVisualEdit({
      path: "a.tsx", current: FILE, instruction: "x", lang: "fr",
      generate: async () => block(`      <h1 className="text-gray-900">Contactez-nous</h1>`, `      <h1>OK</h1>`) + "\n" + block(`<nope/>`, `<x/>`),
    });
    expect(out).toBeNull();
  });
});

describe("route /project-edit (câblage)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
  const route = src.slice(src.indexOf("app.post('/companies/:id/project-edit'"), src.indexOf("// ─── Project files (React app source of truth)"));

  it("garde de crédits avant l'appel IA, sur le payeur du projet", () => {
    const guard = route.indexOf("deductTokens(billingUserId(company), 'site_ai_call')");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(route.indexOf("await editApp("));
    expect(route).toContain("needCredits: true");
  });

  it("édition visuelle en diff ciblé", () => {
    expect(route).toContain("patch: !!element");
  });

  it("plus de double redémarrage du serveur d'aperçu", () => {
    expect(route).toContain("const hmrEnough");
    expect(route).not.toMatch(/healed && healed\.ok/);
  });
});

describe("édition depuis le chat (câblage)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
  const chat = src.slice(src.indexOf("app.post('/chat/stream'"));

  it("garde de crédits avant streamAppEdit / streamMobileAppEdit / streamSiteEdit", () => {
    const guard = chat.indexOf("deductTokens(billingUserId(projectCompany), 'site_ai_call')");
    expect(guard).toBeGreaterThan(-1);
    for (const fn of ["return await streamAppEdit(c, sid", "return await streamMobileAppEdit(c, sid", "return await streamSiteEdit(c, sid"]) {
      const at = chat.indexOf(fn);
      expect(at).toBeGreaterThan(guard);
      expect(at - guard).toBeLessThan(1500);
    }
  });
});
