import { describe, it, expect } from "bun:test";
import { buildAppMap } from "./live-qa";

const APP_TSX = `import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Menu from "./pages/Menu";
import Login from "./pages/Login";
import Terms from "./pages/Terms";
import PlatDetail from "./pages/PlatDetail";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/menu" element={<Menu />} />
        <Route path="/plat/:id" element={<PlatDetail />} />
        <Route path="/login" element={<Login />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}`;

const files = [
  { path: "src/App.tsx", content: APP_TSX },
  { path: "src/pages/Home.tsx", content: "" },
  { path: "src/pages/Menu.tsx", content: "" },
  { path: "src/pages/Login.tsx", content: "" },
  { path: "src/pages/Terms.tsx", content: "" },
  { path: "src/pages/PlatDetail.tsx", content: "" },
];

describe("buildAppMap", () => {
  const plan = {
    appType: "restaurant",
    pages: [
      { name: "Accueil", route: "/", file: "Home.tsx", isCore: true },
      { name: "Menu", route: "/menu", file: "Menu.tsx", hasForm: false },
    ],
    entities: [{ collection: "plats", fields: "name, price" }],
  };

  it("keeps the plan pages with their source file resolved", () => {
    const map = buildAppMap(plan, files);
    const home = map.routes.find(r => r.route === "/")!;
    expect(home.name).toBe("Accueil");
    expect(home.file).toBe("src/pages/Home.tsx");
    expect(home.isCore).toBe(true);
  });

  it("adds routes wired in App.tsx but absent from the plan (they were never tested)", () => {
    const map = buildAppMap(plan, files);
    const routes = map.routes.map(r => r.route);
    expect(routes).toContain("/login");
    expect(routes).toContain("/terms");
    expect(routes).toContain("/plat/:id");
    expect(map.routes.find(r => r.route === "/login")!.file).toBe("src/pages/Login.tsx");
  });

  it("never duplicates a route present in both the plan and the router", () => {
    const map = buildAppMap(plan, files);
    expect(map.routes.filter(r => r.route === "/menu")).toHaveLength(1);
    expect(new Set(map.routes.map(r => r.route)).size).toBe(map.routes.length);
  });

  it("exposes the real route table and excludes the catch-all", () => {
    const map = buildAppMap(plan, files);
    expect(map.routeTable?.paths).toEqual(["/", "/menu", "/login", "/terms"]);
    expect(map.routeTable?.dynamic).toEqual(["/plat/:id"]);
    expect(map.routes.some(r => r.route === "*")).toBe(false);
  });

  it("flags dynamic routes as dynamic", () => {
    const map = buildAppMap(plan, files);
    expect(map.routes.find(r => r.route === "/plat/:id")!.dynamic).toBe(true);
    expect(map.routes.find(r => r.route === "/menu")!.dynamic).toBe(false);
  });

  it("works with no plan at all (router as the only source of truth)", () => {
    const map = buildAppMap(null, files);
    expect(map.appType).toBe("app");
    expect(map.routes.map(r => r.route).sort()).toEqual(["/", "/login", "/menu", "/plat/:id", "/terms"]);
  });

  it("degrades gracefully without App.tsx", () => {
    const map = buildAppMap(plan, [{ path: "src/pages/Home.tsx", content: "" }]);
    expect(map.routes.map(r => r.route)).toEqual(["/", "/menu"]);
    expect(map.routeTable).toEqual({ paths: [], dynamic: [] });
  });
});
