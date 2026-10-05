import { describe, expect, test } from "bun:test";
import { fixShopCtas, isShopSite, shopCtaRules } from "./shop-cta";

describe("isShopSite", () => {
  test("boutique de chaussures / catalogue réel → boutique", () => {
    expect(isShopSite({ appType: "brand", idea: "Crée-moi une marque de chaussures" })).toBe(true);
    expect(isShopSite({ appType: "ecommerce", idea: "x" })).toBe(true);
    expect(isShopSite({ appType: "saas", hasCatalog: true })).toBe(true);
  });
  test("marque auto, SaaS, service → pas une boutique", () => {
    expect(isShopSite({ appType: "brand", idea: "Marque de voitures électriques premium" })).toBe(false);
    expect(isShopSite({ appType: "saas", idea: "outil de gestion de projets" })).toBe(false);
    expect(isShopSite({ appType: "service", idea: "salon de coiffure" })).toBe(false);
  });
});

describe("fixShopCtas", () => {
  test("Header : Get started vers /signup → Créer un compte / Create account", () => {
    const src = `<Link to="/signup" className="btn">
                    Get started
                  </Link>
<Link to="/signup" className="btn">Commencer</Link>`;
    const r = fixShopCtas(src);
    expect(r.code).toContain("Create account");
    expect(r.code).toContain(">Créer un compte<");
    expect(r.code).not.toContain("Get started");
    expect(r.replaced).toBe(2);
  });
  test("essai / démo → boutique, produit ou panier selon la cible", () => {
    const src = [
      `<button onClick={() => setOpen(true)}>Réserver un essai</button>`,
      `<Link to={\`/product/\${p.id}\`}><Eye size={16} /> Essayer</Link>`,
      `<button onClick={handleAddToCart} disabled={!variant}>Try it now</button>`,
      `<a href="/collections">Start free trial</a>`,
      `const hero = { title: "x", cta: "Essai gratuit" };`,
    ].join("\n");
    const r = fixShopCtas(src);
    expect(r.code).toContain(">Voir la boutique</button>");
    expect(r.code).toContain(`<Eye size={16} /> Voir le produit</Link>`);
    expect(r.code).toContain(`disabled={!variant}>Add to cart</button>`);
    expect(r.code).toContain(">Shop now</a>");
    expect(r.code).toContain(`cta: "Voir la boutique"`);
    expect(r.replaced).toBe(5);
  });
  test("Link avec onClick fléché + icône", () => {
    const src = `<Link to="/signup" onClick={() => setMenu(false)} className="b">Get started <ArrowRight className="h-4" /></Link>`;
    const r = fixShopCtas(src);
    expect(r.code).toBe(`<Link to="/signup" onClick={() => setMenu(false)} className="b">Create account <ArrowRight className="h-4" /></Link>`);
  });
  test("ne touche ni à la prose, ni aux boutons d'erreur, ni aux vrais boutons d'achat", () => {
    const src = [
      `<button onClick={retry}>Try again</button>`,
      `<button onClick={retry}>Réessayer</button>`,
      `<p>Commencer votre journée avec style.</p>`,
      `<button onClick={add}>Ajouter au panier</button>`,
      `<p className="x">Try adjusting your search or filters.</p>`,
    ].join("\n");
    expect(fixShopCtas(src)).toEqual({ code: src, replaced: 0 });
  });
});

test("shopCtaRules interdit les CTA d'essai et impose le panier", () => {
  const fr = shopCtaRules("fr");
  expect(fr).toContain("Ajouter au panier");
  expect(fr).toContain("Réserver un essai");
  expect(shopCtaRules("en")).toContain("Add to cart");
});
