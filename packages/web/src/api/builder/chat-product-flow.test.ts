import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANDIDATE_TTL_MS, designKind, fileCandidateStore, runChatProductFlow,
  type CandidateStore, type ProductCandidate, type ProductFlowDeps,
} from "./chat-product-flow";
import { detectProductAddRequest } from "./product-intent";

const MOCKUP = "https://images-api.printify.com/mockup/pf-1/front.png";

function memoryStore(): CandidateStore & { data: Map<string, ProductCandidate> } {
  const data = new Map<string, ProductCandidate>();
  return { data, load: (id) => data.get(id) ?? null, save: (id, c) => { data.set(id, c); }, clear: (id) => { data.delete(id); } };
}

function harness(over: Partial<ProductFlowDeps<{ token: string }>> = {}) {
  const calls = { created: [] as any[], deleted: [] as string[], saved: [] as ProductCandidate[], synced: [] as string[], prompts: [] as string[], designOpts: [] as any[] };
  const store = memoryStore();
  let clock = 1_000_000;
  const deps: ProductFlowDeps<{ token: string }> = {
    workingPrintifyConfig: async () => ({ token: "t" }),
    resolveBlueprint: async (_c, _t, podType) => (podType === "t-shirt" ? 6 : podType === "mug" ? 68 : podType === "shoe" ? 291 : null),
    generateDesign: async (p, o) => { calls.prompts.push(p); calls.designOpts.push(o); return "data:image/png;base64,AAAA"; },
    createMockup: async (_c, input) => {
      calls.created.push(input);
      return { printifyProductId: `pf-${calls.created.length}`, title: input.title, description: input.description, imageUrl: MOCKUP, blueprintId: input.blueprintId, providerId: 99, priceCents: 2990, costPrice: 12.5, margin: 58, variants: [{ vid: 1, label: "M", price: 29.9 }] };
    },
    deletePrintifyProducts: async (_id, ids) => { calls.deleted.push(...ids); },
    saveApprovedProduct: async (_id, c) => { calls.saved.push(c); return { productId: "local-1", retailPrice: 29.9 }; },
    syncSite: (id) => { calls.synced.push(id); },
    chargeImage: async () => ({ ok: true }),
    palette: async () => "#111111, #e11d48",
    store,
    now: () => clock,
    ...over,
  };
  const replies: string[] = [];
  const steps: string[] = [];
  const io = { step: (m: string) => { steps.push(m); }, reply: async (t: string) => { replies.push(t); } };
  const run = (message: string) => runChatProductFlow(deps, io, {
    companyId: "co", companyName: "PasStride", idea: "marque de vêtements de running", industry: "Fashion",
    message, intent: detectProductAddRequest(message),
  });
  return { calls, store, replies, steps, run, tick: (ms: number) => { clock += ms; } };
}

describe("chat → vrai produit Printify", () => {
  test("chaussure : design all-over large, imprimé bord à bord, sans nom de marque imposé", async () => {
    const h = harness();
    expect(await h.run("ajoute une chaussure printify avec des vagues néon")).toBe("previewed");
    expect(h.calls.created[0].blueprintId).toBe(291);
    expect(h.calls.created[0].placementStyle).toBe("all_over");
    expect(h.calls.created[0].keepBackground).toBe(true);
    expect(h.calls.designOpts[0]).toEqual({ aspectRatio: "21:9" });
    expect(h.calls.prompts[0]).toMatch(/all-over surface design/);
    expect(h.calls.prompts[0]).toMatch(/NO TEXT, NO LOGO/);
  });

  test("t-shirt : prompt habituel, aucun placement imposé", async () => {
    const h = harness();
    await h.run("ajoute moi un t-shirt printify avec un loup");
    expect(h.calls.created[0].placementStyle).toBeUndefined();
    expect(h.calls.designOpts[0]).toBeUndefined();
  });

  test("crée un VRAI produit Printify et montre son mockup réel (rien n'est enregistré avant validation)", async () => {
    const h = harness();
    expect(await h.run("ajoute moi un t-shirt printify avec un loup")).toBe("previewed");
    expect(h.calls.created).toHaveLength(1);
    expect(h.calls.created[0].blueprintId).toBe(6);
    expect(h.calls.prompts[0]).toContain("loup");
    expect(h.calls.saved).toHaveLength(0);
    expect(h.calls.synced).toHaveLength(0);
    const last = h.replies.at(-1)!;
    expect(last).toContain("[POPUP]");
    expect(last).toContain(MOCKUP);
    expect(last).toContain('"type":"preview"');
  });

  test("validation → catalogue PUIS site", async () => {
    const h = harness();
    await h.run("ajoute un produit t-shirt");
    expect(await h.run("[APERÇU VALIDÉ] Parfait, continue.")).toBe("added");
    expect(h.calls.saved).toHaveLength(1);
    expect(h.calls.saved[0].printifyProductId).toBe("pf-1");
    expect(h.calls.saved[0].imageUrl).toBe(MOCKUP);
    expect(h.calls.synced).toEqual(["co"]);
    expect(h.calls.deleted).toEqual([]);
    expect(h.store.load("co")).toBeNull();
  });

  test("« Modifier » supprime l'ancien produit Printify et en crée un nouveau avec le retour", async () => {
    const h = harness();
    await h.run("ajoute un produit t-shirt avec un loup");
    expect(await h.run("[APERÇU À MODIFIER] plutôt un mug, plus minimaliste")).toBe("previewed");
    expect(h.calls.deleted).toEqual(["pf-1"]);
    expect(h.calls.created).toHaveLength(2);
    expect(h.calls.created[1].blueprintId).toBe(68); // le mug demandé
    expect(h.calls.prompts[1]).toContain("minimaliste");
    expect(h.store.load("co")?.printifyProductId).toBe("pf-2");
  });

  test("Printify non connecté → aucun produit inventé, rien qui nomme le fabricant", async () => {
    const h = harness({ workingPrintifyConfig: async () => null });
    expect(await h.run("ajoute un produit t-shirt")).toBe("printify_missing");
    expect(h.calls.created).toHaveLength(0);
    expect(h.calls.prompts).toHaveLength(0);
    expect(h.replies[0]).toContain("fabrication n'est pas disponible");
    expect(h.replies[0]).not.toMatch(/printify|token|\[POPUP\]/i);
  });

  test("type absent chez Printify → refus clair, pas de substitut", async () => {
    const h = harness({ resolveBlueprint: async () => null });
    expect(await h.run("ajoute un produit t-shirt")).toBe("not_printable");
    expect(h.calls.created).toHaveLength(0);
    expect(h.replies[0]).toMatch(/rien créé|pas de produit de remplacement/);
  });

  test("type inconnu et activité sans objet précis → on demande le type", async () => {
    const h = harness();
    const out = await runChatProductFlow(harnessDeps(h), { step: () => {}, reply: async (t) => { h.replies.push(t); } }, {
      companyId: "x", companyName: "Conseil SA", idea: "cabinet de conseil", industry: "Consulting",
      message: "ajoute un produit", intent: detectProductAddRequest("ajoute un produit"),
    });
    expect(out).toBe("type_needed");
    expect(h.calls.created).toHaveLength(0);
    expect(h.replies[0]).toContain("Quel produit veux-tu ajouter");
  });

  test("Printify refuse / pas de mockup → rien ajouté", async () => {
    const h = harness({ createMockup: async () => null });
    expect(await h.run("ajoute un produit mug")).toBe("printify_failed");
    expect(h.store.load("co")).toBeNull();
  });

  test("aperçu expiré → brouillon Printify supprimé, rien d'ajouté", async () => {
    const h = harness();
    await h.run("ajoute un produit t-shirt");
    h.tick(CANDIDATE_TTL_MS + 1);
    expect(await h.run("[APERÇU VALIDÉ] Parfait, continue.")).toBe("no_candidate");
    expect(h.calls.deleted).toEqual(["pf-1"]);
    expect(h.calls.saved).toHaveLength(0);
  });

  test("une nouvelle demande remplace le brouillon précédent sur Printify", async () => {
    const h = harness();
    await h.run("ajoute un produit t-shirt");
    await h.run("ajoute un produit mug");
    expect(h.calls.deleted).toEqual(["pf-1"]);
  });

  test("composition du design selon l'objet", () => {
    expect(designKind("t-shirt")).toBe("apparel");
    expect(designKind("mug")).toBe("mug");
    expect(designKind("poster")).toBe("flat");
    expect(designKind("phone case")).toBe("accessory");
  });

  test("store fichier : aller-retour", () => {
    const dir = mkdtempSync(join(tmpdir(), "cand-"));
    try {
      const s = fileCandidateStore(join(dir, "sub"));
      expect(s.load("a/b")).toBeNull();
      const c = { printifyProductId: "1", title: "T", description: "", imageUrl: MOCKUP, podType: "mug", request: "r", concept: "", ts: 1 };
      s.save("a/b", c);
      expect(s.load("a/b")).toEqual(c);
      s.clear("a/b");
      expect(s.load("a/b")).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Deps minimales branchées sur les compteurs d'un harnais.
function harnessDeps(h: ReturnType<typeof harness>): ProductFlowDeps<{ token: string }> {
  return {
    workingPrintifyConfig: async () => ({ token: "t" }),
    resolveBlueprint: async () => 6,
    generateDesign: async () => "data:image/png;base64,AAAA",
    createMockup: async (_c, input) => { h.calls.created.push(input); return null; },
    deletePrintifyProducts: async () => {},
    saveApprovedProduct: async () => ({ productId: "x", retailPrice: 1 }),
    syncSite: () => {},
    chargeImage: async () => ({ ok: true }),
    palette: async () => "",
    store: memoryStore(),
  };
}
