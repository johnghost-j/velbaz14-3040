import { describe, expect, test } from "bun:test";
import { bugSignature, planQaRound, type LiveBug } from "./live-qa";

const bug = (over: Partial<LiveBug> = {}): LiveBug => ({
  route: "/shop",
  page: "Shop",
  file: "src/pages/Shop.tsx",
  kind: "pageerror",
  message: "Cannot read properties of undefined (reading 'price')",
  ...over,
});

describe("anti-boucle du QA live", () => {
  test("signature stable malgré nombres, hashes, query strings et positions", () => {
    const a = bugSignature(bug({ kind: "http", message: "HTTP 500 sur http://localhost:5201/api/items?t=1790862431 at Shop.tsx:12:7" }));
    const b = bugSignature(bug({ kind: "http", message: "HTTP 500 sur http://localhost:5207/api/items?t=1790869999 at Shop.tsx:48:19" }));
    expect(a).toBe(b);
    expect(bugSignature(bug({ route: "/cart" }))).not.toBe(bugSignature(bug()));
  });

  test("un bug déjà tenté qui revient n'est jamais retenté → arrêt", () => {
    const attempted = new Set<string>();
    const r1 = planQaRound([bug(), bug({ route: "/cart" })], attempted);
    expect(r1.stop).toBe(false);
    expect(r1.toFix.length).toBe(2);

    // Même bugs après correction : rien de nouveau → stop, pas de 2e correction.
    const r2 = planQaRound([bug(), bug({ route: "/cart" })], attempted);
    expect(r2.stop).toBe(true);
    expect(r2.toFix.length).toBe(0);
    expect(r2.recurring).toBe(2);
  });

  test("seuls les bugs NOUVEAUX partent en correction", () => {
    const attempted = new Set<string>();
    planQaRound([bug()], attempted);
    const r = planQaRound([bug(), bug({ kind: "blank", message: "Page quasi vide" })], attempted);
    expect(r.stop).toBe(false);
    expect(r.toFix.map(b => b.kind)).toEqual(["blank"]);
    expect(r.recurring).toBe(1);
  });

  test("doublons dans un même tour comptés une seule fois", () => {
    const attempted = new Set<string>();
    const r = planQaRound([bug(), bug(), bug()], attempted);
    expect(r.toFix.length).toBe(1);
  });
});
