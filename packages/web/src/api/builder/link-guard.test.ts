import { describe, it, expect } from "bun:test";
import {
  extractRouteTable,
  normalizeTarget,
  routeExists,
  routeSimilarity,
  bestRouteMatch,
  findBrokenLinks,
  repairInternalLinks,
  linkRepairSummary,
} from "./link-guard";

const APP_TSX = `import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Services from "./pages/Services";
import Contact from "./pages/Contact";
import ProductDetail from "./pages/ProductDetail";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/services" element={<Services />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/produit/:id" element={<ProductDetail />} />
        <Route path="/login" element={<Login />} />
        <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}`;

describe("extractRouteTable", () => {
  it("reads static, dynamic and catch-all routes from App.tsx", () => {
    const t = extractRouteTable(APP_TSX);
    expect(t.paths).toContain("/");
    expect(t.paths).toContain("/services");
    expect(t.paths).toContain("/login");
    expect(t.paths).toContain("/profile");
    expect(t.dynamic).toEqual(["/produit/:id"]);
    expect(t.hasCatchAll).toBe(true);
    expect(t.paths).not.toContain("*");
  });

  it("returns an empty table for empty input", () => {
    const t = extractRouteTable("");
    expect(t.paths).toEqual([]);
    expect(t.dynamic).toEqual([]);
    expect(t.hasCatchAll).toBe(false);
  });
});

describe("normalizeTarget", () => {
  it("ignores everything that is not an internal router path", () => {
    for (const raw of ["https://x.com/a", "mailto:a@b.c", "tel:+33", "#section", "", "  ", "./rel", "../up", "relative/x", "//cdn.x/y"]) {
      expect(normalizeTarget(raw)).toBeNull();
    }
  });

  it("strips query, hash and trailing slash", () => {
    expect(normalizeTarget("/services/")).toBe("/services");
    expect(normalizeTarget("/services?x=1")).toBe("/services");
    expect(normalizeTarget("/services#top")).toBe("/services");
    expect(normalizeTarget("/#pricing")).toBe("/");
    expect(normalizeTarget("/")).toBe("/");
  });
});

describe("routeExists", () => {
  const t = extractRouteTable(APP_TSX);
  it("matches static routes", () => {
    expect(routeExists("/", t)).toBe(true);
    expect(routeExists("/contact", t)).toBe(true);
  });
  it("matches dynamic routes on segment count", () => {
    expect(routeExists("/produit/abc", t)).toBe(true);
    expect(routeExists("/produit/abc/avis", t)).toBe(false);
    expect(routeExists("/produit", t)).toBe(false);
  });
  it("rejects unknown routes", () => {
    expect(routeExists("/tarifs", t)).toBe(false);
    expect(routeExists("/blog", t)).toBe(false);
  });
});

describe("routeSimilarity / bestRouteMatch", () => {
  const t = extractRouteTable(APP_TSX);
  it("scores derived slugs as close", () => {
    expect(routeSimilarity("/nos-services", "/services")).toBeGreaterThanOrEqual(0.5);
    expect(routeSimilarity("/contactez-nous", "/contact")).toBeGreaterThanOrEqual(0.5);
  });
  it("scores unrelated slugs as far", () => {
    expect(routeSimilarity("/blog", "/services")).toBeLessThan(0.5);
  });
  it("picks the closest existing route", () => {
    expect(bestRouteMatch("/nos-services", t)).toBe("/services");
    expect(bestRouteMatch("/contactez-nous", t)).toBe("/contact");
  });
  it("returns null when nothing is close (caller falls back to home)", () => {
    expect(bestRouteMatch("/blog", t)).toBeNull();
  });
});

describe("findBrokenLinks", () => {
  it("flags Link/navigate/href targets that have no route", () => {
    const files = [
      { path: "src/App.tsx", content: APP_TSX },
      {
        path: "src/components/Header.tsx",
        content: `import { Link } from "react-router-dom";
export default function Header() {
  return (<nav>
    <Link to="/">Accueil</Link>
    <Link to="/services">Services</Link>
    <Link to="/tarifs">Tarifs</Link>
    <a href="/blog">Blog</a>
    <a href="https://instagram.com/x">Insta</a>
    <a href="#top">Haut</a>
  </nav>);
}`,
      },
      {
        path: "src/pages/Home.tsx",
        content: `import { useNavigate } from "react-router-dom";
export default function Home() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/reservation")}>Réserver</button>;
}`,
      },
    ];
    const broken = findBrokenLinks(files, APP_TSX);
    const targets = broken.map(b => b.target).sort();
    expect(targets).toEqual(["/blog", "/reservation", "/tarifs"]);
    expect(broken.every(b => !b.interpolated)).toBe(true);
  });

  it("does not flag valid dynamic links and reports interpolated ones without fixing", () => {
    const files = [
      { path: "src/App.tsx", content: APP_TSX },
      {
        path: "src/pages/Services.tsx",
        content: `import { Link } from "react-router-dom";
export default function Services({ items }: any) {
  return (<div>
    {items.map((i: any) => <Link key={i.id} to={\`/produit/\${i.id}\`}>{i.name}</Link>)}
    <Link to={\`/inconnu/\${1}\`}>Cassé</Link>
  </div>);
}`,
      },
    ];
    const broken = findBrokenLinks(files, APP_TSX);
    expect(broken).toHaveLength(1);
    expect(broken[0].interpolated).toBe(true);
    expect(broken[0].target).toContain("/inconnu/");
  });

  it("does nothing when the router cannot be read", () => {
    expect(findBrokenLinks([{ path: "src/pages/Home.tsx", content: `<Link to="/x" />` }], "")).toEqual([]);
  });

  it("skips test files", () => {
    const files = [{ path: "src/pages/Home.test.tsx", content: `<Link to="/nope" />` }];
    expect(findBrokenLinks(files, APP_TSX)).toEqual([]);
  });
});

describe("repairInternalLinks", () => {
  it("rewires broken links to the closest route, or home", () => {
    const files = [
      { path: "src/App.tsx", content: APP_TSX },
      {
        path: "src/components/Header.tsx",
        content: `import { Link } from "react-router-dom";
export default function Header() {
  return (<nav>
    <Link to="/nos-services">Services</Link>
    <a href="/blog">Blog</a>
  </nav>);
}`,
      },
    ];
    const r = repairInternalLinks(files);
    expect(r.fixes).toHaveLength(2);
    const header = files.find(f => f.path === "src/components/Header.tsx")!.content;
    expect(header).toContain(`to="/services"`);
    expect(header).toContain(`href="/"`);
    expect(header).not.toContain("/nos-services");
    expect(header).not.toContain("/blog");
    expect(r.changed.map(c => c.path)).toEqual(["src/components/Header.tsx"]);
    // Idempotent: a second pass finds nothing left to fix.
    expect(repairInternalLinks(files).fixes).toHaveLength(0);
  });

  it("rewrites navigate() and to={...} forms", () => {
    const files = [
      { path: "src/App.tsx", content: APP_TSX },
      {
        path: "src/pages/Home.tsx",
        content: `export default function Home() {
  const navigate = useNavigate();
  return (<div>
    <Link to={"/contactez-nous"}>Contact</Link>
    <button onClick={() => navigate("/tarifs")}>Tarifs</button>
  </div>);
}`,
      },
    ];
    repairInternalLinks(files);
    const home = files.find(f => f.path === "src/pages/Home.tsx")!.content;
    expect(home).toContain(`to={"/contact"}`);
    expect(home).toContain(`navigate("/")`);
  });

  it("never touches external links, anchors or valid routes", () => {
    const original = `import { Link } from "react-router-dom";
export default function Footer() {
  return (<footer>
    <Link to="/services">Services</Link>
    <Link to="/produit/42">Produit</Link>
    <a href="https://x.com/velbaz">X</a>
    <a href="mailto:hello@velbaz.app">Mail</a>
    <a href="#top">Haut</a>
  </footer>);
}`;
    const files = [
      { path: "src/App.tsx", content: APP_TSX },
      { path: "src/components/Footer.tsx", content: original },
    ];
    const r = repairInternalLinks(files);
    expect(r.fixes).toHaveLength(0);
    expect(r.changed).toHaveLength(0);
    expect(files[1].content).toBe(original);
  });

  it("catches auth links when the project has no auth routes", () => {
    const noAuthApp = `<Routes><Route path="/" element={<Home />} /><Route path="*" element={<NotFound />} /></Routes>`;
    const files = [
      { path: "src/App.tsx", content: noAuthApp },
      { path: "src/components/Header.tsx", content: `<Link to="/login">Connexion</Link>` },
    ];
    const r = repairInternalLinks(files);
    expect(r.fixes).toHaveLength(1);
    expect(files[1].content).toContain(`to="/"`);
  });

  it("leaves interpolated targets alone but reports them as skipped", () => {
    const files = [
      { path: "src/App.tsx", content: APP_TSX },
      { path: "src/pages/Home.tsx", content: "<Link to={`/inconnu/${id}`}>x</Link>" },
    ];
    const r = repairInternalLinks(files);
    expect(r.fixes).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(files[1].content).toContain("/inconnu/");
  });

  it("summarizes only when something was fixed", () => {
    expect(linkRepairSummary({ changed: [], fixes: [], skipped: [] })).toBeNull();
    const s = linkRepairSummary({
      changed: [],
      skipped: [],
      fixes: [{ file: "a", target: "/tarifs", kind: "link", fixedTo: "/", interpolated: false }],
    });
    expect(s).toContain("/tarifs → /");
  });
});
