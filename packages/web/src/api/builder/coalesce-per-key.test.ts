import { describe, expect, test } from "bun:test";
import { coalescePerKey } from "./coalesce-per-key";

describe("coalescePerKey", () => {
  test("appels pendant une exécution → une seule relance, jamais en parallèle", async () => {
    let active = 0;
    let maxActive = 0;
    const runs: string[] = [];
    let release!: () => void;
    let first = true;
    const run = coalescePerKey(async (key: string, tag: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      runs.push(`${key}:${tag}`);
      if (first) {
        first = false;
        await new Promise<void>((r) => { release = r; });
      }
      active--;
    });
    const a = run("c1", "a");
    const b = run("c1", "b");
    const c = run("c1", "c");
    release();
    await Promise.all([a, b, c]);
    expect(runs).toEqual(["c1:a", "c1:c"]);
    expect(maxActive).toBe(1);
  });

  test("clés différentes indépendantes, et nouvelle exécution après la fin", async () => {
    const runs: string[] = [];
    const run = coalescePerKey(async (key: string) => { runs.push(key); });
    await Promise.all([run("x"), run("y")]);
    await run("x");
    expect(runs).toEqual(["x", "y", "x"]);
  });

  test("une erreur libère la clé", async () => {
    let n = 0;
    const run = coalescePerKey(async () => { n++; if (n === 1) throw new Error("boom"); });
    await expect(run("k")).rejects.toThrow("boom");
    await run("k");
    expect(n).toBe(2);
  });
});
