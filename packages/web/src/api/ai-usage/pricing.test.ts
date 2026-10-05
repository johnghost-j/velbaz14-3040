import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_PRICES, computeCostUsd, usdToCredits } from "./pricing";

// [2026-10-03] Tarifs relevés dans le catalogue du Runable Gateway
// (getAvailableModels → pricing, USD/token × 1e6). La table avait dérivé :
// gpt-5.4-mini y valait 0,25/2 au lieu de 0,75/4,5, l'appel le plus fréquent
// de la plateforme était donc ~3× sous-facturé.
const GATEWAY_2026_10_03: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "anthropic/claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15, cacheRead: 0.3 },
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "anthropic/claude-opus-4.6": { input: 5, output: 25, cacheRead: 0.5 },
  "anthropic/claude-opus-4.7": { input: 5, output: 25, cacheRead: 0.5 },
  "openai/gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "openai/gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02 },
  "openai/gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "deepseek/deepseek-v4-flash": { input: 0.22, output: 0.66, cacheRead: 0.022 },
  "google/gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05 },
  "google/gemini-2.5-flash-image": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "google/gemini-3-pro-image": { input: 2, output: 12, cacheRead: 0.2 },
  "google/gemini-3.1-flash-lite-image": { input: 0.25, output: 1.5, cacheRead: 0.03 },
  "google/gemini-3.1-flash-image": { input: 0.5, output: 3, cacheRead: 0.05 },
};

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

describe("tarifs IA = catalogue du gateway", () => {
  for (const [id, p] of Object.entries(GATEWAY_2026_10_03)) {
    it(id, () => {
      const t = MODEL_PRICES[id];
      expect(t).toBeTruthy();
      expect(t.input).toBe(p.input);
      expect(t.output).toBe(p.output);
      if (p.cacheRead != null) expect(t.cacheRead).toBe(p.cacheRead);
    });
  }

  it("1 M tokens d'entrée + 1 M de sortie sur mini = 5,25 $", () => {
    expect(computeCostUsd("openai/gpt-5.4-mini", { ...ZERO, input: 1e6, output: 1e6 })).toBe(5.25);
    expect(usdToCredits(5.25)).toBe(15750);
  });

  it("pas de surcoût d'écriture de cache inventé pour OpenAI/Google", () => {
    for (const id of ["openai/gpt-5.4-mini", "google/gemini-3-flash"]) {
      expect(computeCostUsd(id, { ...ZERO, cacheWrite: 1e6 })).toBe(MODEL_PRICES[id].input);
    }
  });

  // Contrôle en direct contre le gateway : AI_PRICING_LIVE=1 bun --env-file=../../.env test pricing
  it.skipIf(!process.env.AI_PRICING_LIVE)("correspond au catalogue en direct", async () => {
    const { createGateway } = await import("@ai-sdk/gateway");
    const g = createGateway({ baseURL: process.env.AI_GATEWAY_BASE_URL, apiKey: process.env.AI_GATEWAY_API_KEY });
    const { models } = await g.getAvailableModels();
    const usd = (x: unknown) => Math.round(Number(x) * 1e6 * 1e4) / 1e4;
    const drift: string[] = [];
    for (const [id, t] of Object.entries(MODEL_PRICES)) {
      const m: any = models.find((x: any) => x.id === id);
      if (!m?.pricing) continue; // absent du gateway (ex. gemini-2.0-flash-001)
      if (usd(m.pricing.input) !== t.input || usd(m.pricing.output) !== t.output) {
        drift.push(`${id}: table ${t.input}/${t.output}, gateway ${usd(m.pricing.input)}/${usd(m.pricing.output)}`);
      }
    }
    expect(drift).toEqual([]);
  }, 60_000);
});

describe("gardes de crédits (TOKEN_COSTS)", () => {
  const src = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");
  const block = src.slice(src.indexOf("const TOKEN_COSTS"), src.indexOf("};", src.indexOf("const TOKEN_COSTS")));
  const cost = (k: string) => Number(block.match(new RegExp(`\\b${k}: (\\d+)`))?.[1]);
  const credits = (model: string, inTok: number, outTok: number) =>
    usdToCredits(computeCostUsd(model, { ...ZERO, input: inTok, output: outTok }));

  it("un message de chat (10k/1k sur mini) est couvert", () => {
    expect(cost("chat")).toBeGreaterThanOrEqual(credits("openai/gpt-5.4-mini", 10_000, 1_000));
  });

  it("un build (6 appels Sonnet 20k/8k) est couvert", () => {
    expect(cost("website_build")).toBeGreaterThanOrEqual(6 * credits("anthropic/claude-sonnet-4.6", 20_000, 8_000));
  });

  it("le solde de départ (5000) permet toujours création + build", () => {
    expect(cost("company_create") + cost("website_build")).toBeLessThanOrEqual(5000);
  });
});
