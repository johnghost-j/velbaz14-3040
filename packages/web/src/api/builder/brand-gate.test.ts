import { describe, expect, test } from "bun:test";
import {
  BRAND_AUTO_VALIDATE_MS,
  BRAND_GATE_GRACE_MS,
  BRAND_GATE_MAX_WAIT_MS,
  beginBrandPreviewWork,
  brandGateState,
  isBrandPreviewWorkInFlight,
  waitForBrandGate,
  type BrandGateProbe,
} from "./brand-gate";

// Horloge simulée : chaque sommeil fait avancer le temps, sans attendre.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

describe("brandGateState", () => {
  test("requête en vol → working, même sans cache", () => {
    expect(brandGateState({ inFlight: true, cacheWrittenAt: null }, 0)).toBe("working");
  });
  test("ni requête ni cache → none", () => {
    expect(brandGateState({ inFlight: false, cacheWrittenAt: null }, 0)).toBe("none");
  });
  test("cache récent → en attente de validation, cache trop vieux → abandonné", () => {
    const now = 10_000_000;
    expect(brandGateState({ inFlight: false, cacheWrittenAt: now - BRAND_AUTO_VALIDATE_MS }, now)).toBe("awaiting_validation");
    expect(brandGateState({ inFlight: false, cacheWrittenAt: now - BRAND_AUTO_VALIDATE_MS - BRAND_GATE_GRACE_MS - 1 }, now)).toBe("abandoned");
  });
});

describe("beginBrandPreviewWork", () => {
  test("compte les requêtes parallèles et ignore une double fin", () => {
    const id = "co-inflight";
    const a = beginBrandPreviewWork(id);
    const b = beginBrandPreviewWork(id);
    a(); a();
    expect(isBrandPreviewWorkInFlight(id)).toBe(true);
    b();
    expect(isBrandPreviewWorkInFlight(id)).toBe(false);
  });
});

describe("waitForBrandGate", () => {
  test("cas Paséo : /brand-preview en vol SANS cache → le build attend jusqu'à la validation", async () => {
    const clock = fakeClock();
    const t0 = clock.now();
    // 0–42 s : génération en vol (pas encore de cache) ; 42 s : cache écrit ;
    // 43–80 s : /products en vol ; 85 s : validation → cache effacé.
    const probe = (): BrandGateProbe => {
      const dt = clock.now() - t0;
      if (dt < 42_000) return { inFlight: true, cacheWrittenAt: null };
      if (dt < 43_000) return { inFlight: false, cacheWrittenAt: t0 + 42_000 };
      if (dt < 80_000) return { inFlight: true, cacheWrittenAt: t0 + 42_000 };
      if (dt < 85_000) return { inFlight: false, cacheWrittenAt: t0 + 80_000 };
      return { inFlight: false, cacheWrittenAt: null };
    };
    const waits: string[] = [];
    const r = await waitForBrandGate({ probe, now: clock.now, sleep: clock.sleep, onWait: (s) => waits.push(s) });
    expect(r.outcome).toBe("resolved");
    expect(r.waitedMs).toBeGreaterThanOrEqual(85_000);
    expect(waits[0]).toBe("working");
    expect(waits).toContain("awaiting_validation");
  });

  test("aucun aperçu → aucune attente", async () => {
    const clock = fakeClock();
    let slept = 0;
    const r = await waitForBrandGate({
      probe: () => ({ inFlight: false, cacheWrittenAt: null }),
      now: clock.now,
      sleep: async (ms) => { slept += ms; },
    });
    expect(r).toEqual({ outcome: "no_preview", waitedMs: 0 });
    expect(slept).toBe(0);
  });

  test("cache périmé (onglet fermé) → abandonné sans attendre", async () => {
    const clock = fakeClock(100_000_000);
    const r = await waitForBrandGate({
      probe: () => ({ inFlight: false, cacheWrittenAt: clock.now() - 60 * 60 * 1000 }),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r.outcome).toBe("abandoned");
    expect(r.waitedMs).toBe(0);
  });

  test("proposition affichée jamais validée → abandon après le délai d'auto-validation", async () => {
    const clock = fakeClock();
    const written = clock.now();
    const r = await waitForBrandGate({ probe: () => ({ inFlight: false, cacheWrittenAt: written }), now: clock.now, sleep: clock.sleep });
    expect(r.outcome).toBe("abandoned");
    expect(r.waitedMs).toBeGreaterThan(BRAND_AUTO_VALIDATE_MS + BRAND_GATE_GRACE_MS);
  });

  test("requête bloquée indéfiniment → borne dure", async () => {
    const clock = fakeClock();
    const r = await waitForBrandGate({ probe: () => ({ inFlight: true, cacheWrittenAt: null }), now: clock.now, sleep: clock.sleep });
    expect(r.outcome).toBe("timeout");
    expect(r.waitedMs).toBeGreaterThan(BRAND_GATE_MAX_WAIT_MS);
  });

  test("build annulé → on arrête d'attendre", async () => {
    const clock = fakeClock();
    let n = 0;
    const r = await waitForBrandGate({
      probe: () => ({ inFlight: true, cacheWrittenAt: null }),
      isCancelled: () => ++n > 3,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r.outcome).toBe("cancelled");
  });
});

describe("trackBrandPreviewWork (vraies routes Hono)", () => {
  test("les 3 POST de l'aperçu sont « en vol » pendant leur traitement, pas les autres routes", async () => {
    const { Hono } = await import("hono");
    const { trackBrandPreviewWork } = await import("./brand-gate");
    const app = new Hono().basePath("api");
    app.use("/companies/:id/brand-preview", trackBrandPreviewWork);
    app.use("/companies/:id/brand-preview/products", trackBrandPreviewWork);
    app.use("/companies/:id/brand-preview/approve", trackBrandPreviewWork);
    const seen: Record<string, boolean> = {};
    const handler = (name: string) => (c: any) => {
      seen[name] = isBrandPreviewWorkInFlight(c.req.param("id"));
      return c.json({ ok: true });
    };
    app.post("/companies/:id/brand-preview", handler("preview"));
    app.post("/companies/:id/brand-preview/products", handler("products"));
    app.post("/companies/:id/brand-preview/approve", handler("approve"));
    app.post("/companies/:id/brand-preview/discard", handler("discard"));
    for (const path of ["", "/products", "/approve", "/discard"]) {
      const res = await app.request(`/api/companies/co-hono/brand-preview${path}`, { method: "POST" });
      expect(res.status).toBe(200);
    }
    expect(seen).toEqual({ preview: true, products: true, approve: true, discard: false });
    expect(isBrandPreviewWorkInFlight("co-hono")).toBe(false);
  });
});
