import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeBug, leaksPreviewPath, unresolvedBugs, type LiveBug } from "./live-qa";

const bug = (over: Partial<LiveBug>): LiveBug => ({
  route: "/", page: "Accueil", file: "src/pages/Home.tsx", kind: "pageerror", message: "boom", ...over,
});

describe("QA live — une seule passe", () => {
  test("runLiveQAAndFix teste UNE fois et ne boucle plus", () => {
    const src = readFileSync(join(import.meta.dir, "live-qa.ts"), "utf8");
    const start = src.indexOf("export async function runLiveQAAndFix");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    // Un seul appel au navigateur de test, une seule correction IA.
    expect(body.match(/await runLiveQA\(/g)?.length).toBe(1);
    expect(body.match(/fixBugsLive\(/g)?.length).toBe(1);
    // Plus de boucle de passes ni d'attente artificielle.
    expect(body).not.toMatch(/\bwhile\s*\(/);
    expect(body).not.toMatch(/for\s*\(\s*let\s+round/);
    expect(body).not.toMatch(/setTimeout/);
    expect(body).not.toMatch(/maxRounds/);
  });

  test("unresolvedBugs : seuls les bugs dont le fichier n'a pas été corrigé restent", () => {
    const a = bug({ file: "src/pages/Home.tsx" });
    const b = bug({ file: "src/pages/Shop.tsx", route: "/shop" });
    expect(unresolvedBugs([a, b], ["src/pages/Home.tsx"])).toEqual([b]);
    expect(unresolvedBugs([a, b], [])).toEqual([a, b]);
    // Chemins relatifs/absolus équivalents.
    expect(unresolvedBugs([a], ["/tmp/app/src/pages/Home.tsx"])).toEqual([]);
  });

  test("describeBug affiche le texte du bug, sur une ligne", () => {
    const line = describeBug(bug({ route: "/cart", kind: "console", message: "TypeError:\n  x is undefined" }));
    expect(line).toBe("• /cart — [console] TypeError: x is undefined");
    expect(describeBug(bug({ message: "a".repeat(400) })).length).toBeLessThan(200);
  });

  test("leaksPreviewPath refuse une correction qui ajoute un chemin interne d'aperçu", () => {
    const before = `<Route path="/profile" element={<Profile />} />`;
    const bad = `${before}\n<Route path="/api/companies/:companyId/preview/profile" element={<Profile />} />`;
    expect(leaksPreviewPath(before, bad)).toBe(true);
    expect(leaksPreviewPath(before, `${before}\n<Route path="/settings" element={<S />} />`)).toBe(false);
    // Une correction qui en RETIRE est acceptée.
    expect(leaksPreviewPath(bad, before)).toBe(false);
  });
});
