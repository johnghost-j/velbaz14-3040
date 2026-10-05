import { describe, expect, test } from "bun:test";
import { catalogWiringInstruction, pickShopTargets, routedPageFiles, siteCatalogState, type SiteFile } from "./catalog-sync";

// App.tsx réel d'AtelierRue (le projet du bug) : pages routées en JSX.
const APP_TSX = `import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import { ProtectedRoute } from "./lib/auth";
import Login from "./pages/Login";
import Profile from "./pages/Profile";
import Terms from "./pages/Terms";
import NotFound from "./pages/NotFound";
import Showroom from "./pages/Showroom";
import Produit from "./pages/Produit";
import Panier from "./pages/Panier";
import Commande from "./pages/Commande";
import Confirmation from "./pages/Confirmation";
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Showroom />} />
        <Route path="/produit" element={<Produit />} />
        <Route path="/panier" element={<Panier />} />
        <Route path="/commande" element={<Commande />} />
        <Route path="/confirmation" element={<Confirmation />} />
        <Route path="/login" element={<Login />} />
        <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
        <Route path="/terms" element={<Terms />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}`;

const DEMO_PRODUCT_PAGE = `import { data } from "../lib/api";
export default function Produit() {
  const products = data.list("products");
  return <div>{products.map((p) => <div key={p.id}>{p.name} {p.price} € <span>Exemple</span> <button>Ajouter au panier</button></div>)}</div>;
}`;

function site(extra: SiteFile[] = []): SiteFile[] {
  return [
    { path: "src/App.tsx", content: APP_TSX },
    { path: "src/pages/Showroom.tsx", content: `export default function Showroom(){ return <section>Collection — voir les produits, prix dès 25 €</section> }` },
    { path: "src/pages/Produit.tsx", content: DEMO_PRODUCT_PAGE },
    { path: "src/pages/Panier.tsx", content: `export default function Panier(){ return <div>Ton panier — total, commande</div> }` },
    { path: "src/pages/Commande.tsx", content: `export default function Commande(){ return <div>Commande : paiement de ta commande, prix total</div> }` },
    { path: "src/pages/Confirmation.tsx", content: `export default function Confirmation(){ return <div>Merci pour ta commande</div> }` },
    { path: "src/pages/Login.tsx", content: `export default function Login(){ return <div>Connexion — tes commandes, ton panier</div> }` },
    { path: "src/pages/Profile.tsx", content: `export default function Profile(){ return <div>Mes commandes</div> }` },
    { path: "src/pages/Terms.tsx", content: `export default function Terms(){ return <div>CGV : prix, commande, produits</div> }` },
    { path: "src/pages/NotFound.tsx", content: `export default function NotFound(){ return <div>404</div> }` },
    // Page orpheline (non routée) : ne doit jamais être réécrite.
    { path: "src/pages/Home.tsx", content: `export default function Home(){ return <div>products products products</div> }` },
    ...extra,
  ];
}

describe("routedPageFiles", () => {
  test("lit les pages routées d'App.tsx, y compris sous ProtectedRoute", () => {
    const pages = routedPageFiles(APP_TSX);
    expect(pages).toContain("src/pages/Showroom.tsx");
    expect(pages).toContain("src/pages/Produit.tsx");
    expect(pages).toContain("src/pages/Profile.tsx");
    expect(pages).not.toContain("src/pages/Home.tsx");
  });
  test("ignore un import jamais rendu", () => {
    expect(routedPageFiles(`import Home from "./pages/Home";\nexport default () => <div/>`)).toEqual([]);
  });
  test("App.tsx vide → aucune page", () => {
    expect(routedPageFiles("")).toEqual([]);
  });
});

describe("pickShopTargets", () => {
  test("choisit les pages boutique routées, pas le compte / le légal / l'orpheline", () => {
    const t = pickShopTargets(site());
    expect(t).toContain("src/pages/Produit.tsx");
    expect(t).toContain("src/pages/Showroom.tsx");
    expect(t).toContain("src/pages/Panier.tsx");
    expect(t).not.toContain("src/pages/Login.tsx");
    expect(t).not.toContain("src/pages/Profile.tsx");
    expect(t).not.toContain("src/pages/Terms.tsx");
    expect(t).not.toContain("src/pages/NotFound.tsx");
    expect(t).not.toContain("src/pages/Home.tsx");
  });
  test("la page d'accueil (vitrine) passe en priorité", () => {
    expect(pickShopTargets(site())[0]).toBe("src/pages/Showroom.tsx");
  });
  test("borne le nombre de pages réécrites", () => {
    expect(pickShopTargets(site(), 2).length).toBe(2);
  });
  test("sans App.tsx exploitable, retombe sur les fichiers de pages", () => {
    const files = site().filter((f) => f.path !== "src/App.tsx");
    const t = pickShopTargets(files);
    expect(t).toContain("src/pages/Produit.tsx");
    expect(t).not.toContain("src/pages/Login.tsx");
  });
});

describe("siteCatalogState", () => {
  const ids = ["prod-tee", "prod-hoodie"];
  const fresh = `export const CATALOG = [{ id: "prod-tee" }, { id: "prod-hoodie" }];`;

  test("cas du bug : produits réels, site sans catalog.ts → à brancher", () => {
    const s = siteCatalogState(site(), ids, fresh);
    expect(s.hasFile).toBe(false);
    expect(s.consumers).toEqual([]);
    expect(s.missingIds).toEqual(ids);
    expect(s.needsWiring).toBe(true);
  });

  test("catalog.ts présent mais aucune page ne l'importe → à brancher", () => {
    const s = siteCatalogState(site([{ path: "src/lib/catalog.ts", content: fresh }]), ids, fresh);
    expect(s.hasFile).toBe(true);
    expect(s.fileStale).toBe(false);
    expect(s.needsWiring).toBe(true);
  });

  test("pages branchées + fichier à jour → rien à faire", () => {
    const files = site([
      { path: "src/lib/catalog.ts", content: fresh },
      { path: "src/pages/Boutique.tsx", content: `import { CATALOG } from "../lib/catalog";` },
    ]);
    const s = siteCatalogState(files, ids, fresh);
    expect(s.consumers).toEqual(["src/pages/Boutique.tsx"]);
    expect(s.needsWiring).toBe(false);
    expect(s.fileStale).toBe(false);
  });

  test("pages branchées, un produit ajouté → fichier seul à réécrire (pas d'IA)", () => {
    const old = `export const CATALOG = [{ id: "prod-tee" }];`;
    const files = site([
      { path: "src/lib/catalog.ts", content: old },
      { path: "src/pages/Boutique.tsx", content: `import { CATALOG, findProduct } from '../lib/catalog'` },
    ]);
    const s = siteCatalogState(files, ids, fresh);
    expect(s.missingIds).toEqual(["prod-hoodie"]);
    expect(s.fileStale).toBe(true);
    expect(s.needsWiring).toBe(false);
  });

  test("ancien catalogue sans AUCUN des vrais produits → rebranchement complet", () => {
    const files = site([
      { path: "src/lib/catalog.ts", content: `export const CATALOG = [{ id: "demo-1" }];` },
      { path: "src/pages/Boutique.tsx", content: `import { CATALOG } from "@/lib/catalog";` },
    ]);
    expect(siteCatalogState(files, ids, fresh).needsWiring).toBe(true);
  });

  test("aucun produit réel → jamais de réécriture des pages", () => {
    expect(siteCatalogState(site(), [], "").needsWiring).toBe(false);
  });
});

describe("catalogWiringInstruction", () => {
  test("demande de remplacer les produits d'exemple par CATALOG, design gardé", () => {
    const s = catalogWiringInstruction("PRODUITS: AtelierRue Tee 25 €");
    expect(s).toContain('data.list("products")');
    expect(s).toContain("CATALOG");
    expect(s).toContain("../lib/catalog");
    expect(s).toContain("findProduct");
    expect(s).toContain("checkout()");
    expect(s).toMatch(/GARDE le design/);
    expect(s).toContain("PRODUITS: AtelierRue Tee 25 €");
  });
});
