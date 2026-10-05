import { describe, expect, test } from "bun:test";
import { isHttpBug, isNoise, toAppPath } from "./live-qa";
import { ensureHomeRoute } from "./engine";

// Cas réel (projet MailFlow, 2026-10-03) : 15 « bugs » identiques sur chacune
// des 17 pages → le QA live tournait sur des faux positifs sans fin.
const BASE = "/api/companies/547d2b5d-c696-4e33-b85e-32486bd8d7c8/preview/";

describe("QA live — faux positifs de l'aperçu", () => {
  test("les liens rendus avec le basename du router sont ramenés à la route de l'app", () => {
    expect(toAppPath(`${BASE}contact`, BASE)).toBe("/contact");
    expect(toAppPath(BASE.replace(/\/$/, ""), BASE)).toBe("/");
    expect(toAppPath(BASE, BASE)).toBe("/");
    expect(toAppPath(`${BASE}services?x=1#top`, BASE)).toBe("/services");
    // Sans préfixe (export / base "/"), rien ne change.
    expect(toAppPath("/tarifs", "/")).toBe("/tarifs");
    // Un vrai lien mort reste un lien mort.
    expect(toAppPath(`${BASE}page-inexistante`, BASE)).toBe("/page-inexistante");
    // Externe / ancre : hors périmètre.
    expect(toAppPath("https://exemple.com", BASE)).toBeNull();
    expect(toAppPath("#faq", BASE)).toBeNull();
  });

  test("le WebSocket HMR de Vite n'est pas un bug du site", () => {
    expect(isNoise("WebSocket closed without opened.")).toBe(true);
    expect(isNoise("Cannot read properties of undefined (reading 'price')")).toBe(false);
  });

  test("401/403 = réponse normale au robot non connecté, pas un bug", () => {
    expect(isHttpBug(401)).toBe(false);
    expect(isHttpBug(403)).toBe(false);
    expect(isHttpBug(404)).toBe(true);
    expect(isHttpBug(500)).toBe(true);
    expect(isHttpBug(200)).toBe(false);
  });
});

describe("plan — une page est toujours servie sur /", () => {
  const p = (name: string, route: string) => ({ name, route });

  test("l'accueil planifié sur /accueil devient /", () => {
    const out = ensureHomeRoute([p("Contact", "/contact"), p("Accueil", "/accueil"), p("Tarifs", "/tarifs")]);
    expect(out.map(x => x.route)).toEqual(["/contact", "/", "/tarifs"]);
  });

  test("sans page « accueil », la première page statique prend /", () => {
    const out = ensureHomeRoute([p("Produit", "/produit/:id"), p("Catalogue", "/catalogue")]);
    expect(out.map(x => x.route)).toEqual(["/produit/:id", "/"]);
  });

  test("un plan qui a déjà / n'est pas touché", () => {
    const pages = [p("Home", "/"), p("Accueil", "/accueil")];
    expect(ensureHomeRoute(pages)).toBe(pages);
  });
});

describe("liens des tableaux de navigation (Header/Footer)", () => {
  const APP = `<Routes><Route element={<Layout />}>
    <Route path="/" element={<Accueil />} />
    <Route path="/contact" element={<Contact />} />
    <Route path="*" element={<NotFound />} />
  </Route></Routes>`;

  test("{ to: \"/accueil\" } est détecté puis recâblé vers une vraie route", async () => {
    const { findBrokenLinks, repairInternalLinks } = await import("./link-guard");
    const header = {
      path: "src/components/Header.tsx",
      content: `const NAV = [\n  { label: "Accueil", to: "/accueil" },\n  { label: "Contact", to: "/contact" },\n  { label: "Mail", to: "contact@x.be" },\n];`,
    };
    expect(findBrokenLinks([header], APP).map(b => b.target)).toEqual(["/accueil"]);
    const r = repairInternalLinks([header], APP);
    expect(r.changed.length).toBe(1);
    expect(header.content).toContain(`to: "/"`);
    expect(header.content).toContain(`to: "/contact"`);
    expect(header.content).toContain(`to: "contact@x.be"`);
    // Une fois réparé, plus rien à corriger → le QA ne reboucle pas dessus.
    expect(findBrokenLinks([header], APP)).toEqual([]);
  });
});

describe("navigations dures hors basename (window.location.href)", () => {
  const APP = `<Routes><Route element={<Layout />}>
    <Route path="/" element={<Accueil />} />
    <Route path="/signup" element={<Signup />} />
    <Route path="*" element={<NotFound />} />
  </Route></Routes>`;

  test("réécrites avec la base Vite, une seule fois (idempotent)", async () => {
    const { rebaseHardNavigations } = await import("./link-guard");
    const src = `if (!user) { window.location.href = "/signup"; }\nlocation.assign('/');\nwindow.location.href = "https://stripe.com/x";\nfetch("/api/x");\nif (window.location.href === "/") {}`;
    const r = rebaseHardNavigations(src);
    expect(r.count).toBe(2);
    expect(r.code).toContain(`window.location.href = import.meta.env.BASE_URL.replace(/\\/$/, "") + "/signup"`);
    expect(r.code).toContain(`location.assign(import.meta.env.BASE_URL.replace(/\\/$/, "") + '/')`);
    expect(r.code).toContain(`"https://stripe.com/x"`);
    expect(rebaseHardNavigations(r.code).count).toBe(0);
  });

  test("repairInternalLinks recâble la cible inexistante puis la rend compatible", async () => {
    const { repairInternalLinks, linkRepairSummary } = await import("./link-guard");
    const page = { path: "src/pages/Tarifs.tsx", content: `const go = () => { window.location.href = "/register"; };` };
    const r = repairInternalLinks([page], APP);
    expect(r.rebased).toBe(1);
    expect(page.content).not.toContain("/register");
    expect(page.content).toContain("import.meta.env.BASE_URL");
    expect(linkRepairSummary(r)).toContain("redirection");
    // Deuxième passe : plus rien à faire → aucune boucle.
    const again = repairInternalLinks([page], APP);
    expect(again.changed.length).toBe(0);
  });

  test("le 404 d'une sortie de base est classé déterministe, pas envoyé à l'IA", async () => {
    const { isBaseEscapeHttp } = await import("./live-qa");
    const base = `http://localhost:5299${BASE}`;
    expect(isBaseEscapeHttp({ kind: "http", message: "HTTP 404 sur http://localhost:5299/signup" }, base)).toBe(true);
    expect(isBaseEscapeHttp({ kind: "http", message: `HTTP 500 sur http://localhost:5299${BASE}api/items` }, base)).toBe(false);
    expect(isBaseEscapeHttp({ kind: "http", message: "HTTP 404 sur http://localhost:5299/api/auth/me" }, base)).toBe(false);
    expect(isBaseEscapeHttp({ kind: "http", message: "HTTP 404 sur http://localhost:5299/signup" }, "http://localhost:5299/")).toBe(false);
  });
});
