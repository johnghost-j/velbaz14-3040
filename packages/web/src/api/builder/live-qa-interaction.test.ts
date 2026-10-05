import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QA_MAX_CLICK_FAILURES, actionTimeout, clickDecision, forEachConcurrent, interactionBudget,
} from "./live-qa-interaction";

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("budget de la passe d'interaction", () => {
  test("décompte le temps restant et expire", () => {
    const c = clock();
    const b = interactionBudget(12_000, c.now);
    expect(b.left()).toBe(12_000);
    expect(b.over()).toBe(false);
    c.advance(11_999);
    expect(b.left()).toBe(1);
    c.advance(5_000);
    expect(b.left()).toBe(0);
    expect(b.over()).toBe(true);
  });

  test("le timeout d'une action ne dépasse jamais le budget restant", () => {
    const c = clock();
    const b = interactionBudget(2_000, c.now);
    expect(actionTimeout(1_500, b)).toBe(1_500);
    c.advance(1_800);
    expect(actionTimeout(1_500, b)).toBe(200);
  });

  test("jamais 0 : pour Playwright 0 = attente infinie", () => {
    const c = clock();
    const b = interactionBudget(100, c.now);
    c.advance(10_000);
    expect(actionTimeout(1_500, b)).toBe(1);
  });
});

describe("décision de clic", () => {
  const base = { budgetLeftMs: 5_000, consecutiveFailures: 0, label: "Ajouter au panier", covered: false };

  test("clique un bouton sain", () => {
    expect(clickDecision(base)).toBe("click");
  });

  test("saute un bouton recouvert par une modale / un bandeau sans attendre", () => {
    expect(clickDecision({ ...base, covered: true })).toBe("skip");
  });

  test("saute les actions destructrices ou de déconnexion", () => {
    for (const label of ["Supprimer", "Delete account", "Se déconnecter", "Logout", "Sign out"]) {
      expect(clickDecision({ ...base, label })).toBe("skip");
    }
  });

  test("s'arrête quand le budget est épuisé", () => {
    expect(clickDecision({ ...base, budgetLeftMs: 0 })).toBe("stop");
  });

  test("s'arrête après N échecs consécutifs", () => {
    expect(clickDecision({ ...base, consecutiveFailures: QA_MAX_CLICK_FAILURES - 1 })).toBe("click");
    expect(clickDecision({ ...base, consecutiveFailures: QA_MAX_CLICK_FAILURES })).toBe("stop");
  });
});

describe("runLiveQA n'a plus d'attente sans borne", () => {
  const src = readFileSync(join(import.meta.dir, "live-qa.ts"), "utf8");
  const start = src.indexOf("export async function runLiveQA(");
  const body = src.slice(start, src.indexOf("\n}\n", start));

  test("aucun innerText() sans timeout (défaut Playwright = 30 s)", () => {
    expect(body).not.toContain("innerText()");
  });

  test("la passe d'interaction est bornée par un budget", () => {
    expect(body).toContain("interactionBudget(QA_INTERACTION_BUDGET_MS)");
    expect(body).toContain("clickDecision(");
  });
});

describe("forEachConcurrent", () => {
  const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

  test("traite tout, sans dépasser la limite de parallélisme", async () => {
    let running = 0, peak = 0;
    const done: number[] = [];
    await forEachConcurrent([1, 2, 3, 4, 5], 2, async n => {
      running++; peak = Math.max(peak, running);
      await tick(5);
      done.push(n);
      running--;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  test("l'annulation empêche de démarrer de nouveaux éléments", async () => {
    const done: number[] = [];
    let stop = false;
    await forEachConcurrent([1, 2, 3, 4], 1, async n => { done.push(n); if (n === 2) stop = true; }, () => stop);
    expect(done).toEqual([1, 2]);
  });

  test("propage l'erreur d'un élément", async () => {
    await expect(forEachConcurrent([1], 2, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  test("liste vide : ne fait rien", async () => {
    let calls = 0;
    await forEachConcurrent([], 2, async () => { calls++; });
    expect(calls).toBe(0);
  });
});
