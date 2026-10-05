import { describe, expect, it } from "bun:test";
import {
  defaultAuthCopy,
  detectAuthSector,
  loginPageTsx,
  pickAuthLayout,
  profilePageTsx,
  resolveAuthCopy,
  settingsPageTsx,
  signupPageTsx,
  type AuthPageMeta,
} from "./auth-pages";
import { buildScaffold } from "./scaffold";

const transpiler = new Bun.Transpiler({ loader: "tsx" });
/** Le code généré doit TOUJOURS compiler — c'est la garantie du scaffold. */
function compiles(src: string): boolean {
  transpiler.transformSync(src);
  return true;
}

const shop: AuthPageMeta = {
  companyName: "Atelier Lumière",
  slug: "atelier-lumiere",
  idea: "Boutique en ligne de produits artisanaux locaux",
  tagline: "L'artisanat local, livré chez toi",
  lang: "fr",
};
const clinic: AuthPageMeta = {
  companyName: "Clinique Voltaire",
  slug: "clinique-voltaire",
  idea: "Cabinet médical avec prise de rendez-vous en ligne",
  lang: "fr",
};
const saasEn: AuthPageMeta = {
  companyName: "Bordly",
  slug: "bordly",
  idea: "A SaaS platform to manage freelance invoices",
  lang: "en",
};

describe("detectAuthSector", () => {
  it("détecte la boutique, la santé/rdv et le saas", () => {
    expect(detectAuthSector(shop)).toBe("shop");
    expect(["booking", "health"]).toContain(detectAuthSector(clinic));
    expect(detectAuthSector(saasEn)).toBe("saas");
  });

  it("retombe sur 'services' quand rien ne correspond", () => {
    expect(detectAuthSector({ companyName: "Zzz", idea: "quelque chose d'indéfini" })).toBe("services");
  });
});

describe("defaultAuthCopy", () => {
  it("interpole le nom de l'entreprise dans le titre de connexion", () => {
    expect(defaultAuthCopy(shop).loginTitle).toContain("Atelier Lumière");
    expect(defaultAuthCopy(saasEn).loginTitle).toBe("Sign in to Bordly");
  });

  it("respecte la langue", () => {
    const fr = defaultAuthCopy(shop);
    const en = defaultAuthCopy({ ...shop, lang: "en" });
    expect(fr.loginCta).not.toBe(en.loginCta);
    expect(en.settingsTitle).toBe("Settings");
    expect(fr.settingsTitle).toBe("Réglages");
  });

  it("donne un texte métier différent pour deux secteurs différents", () => {
    const a = defaultAuthCopy(shop);
    const b = defaultAuthCopy(clinic);
    expect(a.loginSubtitle).not.toBe(b.loginSubtitle);
    expect(a.profileTitle).not.toBe(b.profileTitle);
    expect(a.signupCta).not.toBe(b.signupCta);
  });

  it("n'utilise jamais l'ancien texte générique", () => {
    const all = Object.values(defaultAuthCopy(shop)).join(" ");
    expect(all).not.toContain("Ravi de te revoir");
    expect(all).not.toContain("Gère ton compte et tes préférences");
  });
});

describe("resolveAuthCopy", () => {
  it("laisse l'IA surcharger le repli, champ par champ", () => {
    const copy = resolveAuthCopy({ ...shop, authCopy: { loginTitle: "Bienvenue à l'Atelier" } });
    expect(copy.loginTitle).toBe("Bienvenue à l'Atelier");
    expect(copy.loginCta).toBe(defaultAuthCopy(shop).loginCta); // le reste vient du repli
  });

  it("ignore les valeurs IA inutilisables sans perdre les autres", () => {
    const copy = resolveAuthCopy({
      ...shop,
      authCopy: {
        loginTitle: "",
        loginSubtitle: "...",
        loginCta: "x".repeat(200),
        profileTitle: "<div>Profil</div>",
        settingsTitle: "Préférences",
      } as any,
    });
    const base = defaultAuthCopy(shop);
    expect(copy.loginTitle).toBe(base.loginTitle);
    expect(copy.loginSubtitle).toBe(base.loginSubtitle);
    expect(copy.loginCta).toBe(base.loginCta);
    expect(copy.profileTitle).toBe(base.profileTitle);
    expect(copy.settingsTitle).toBe("Préférences");
  });
});

describe("pickAuthLayout", () => {
  it("respecte le gabarit demandé par l'IA", () => {
    expect(pickAuthLayout({ ...shop, authLayout: "Minimal" })).toBe("minimal");
    expect(pickAuthLayout({ ...shop, authLayout: "split" })).toBe("split");
  });

  it("ignore un gabarit inconnu et reste stable pour un même projet", () => {
    const a = pickAuthLayout({ ...shop, authLayout: "n'importe quoi" });
    const b = pickAuthLayout({ ...shop, authLayout: "n'importe quoi" });
    expect(a).toBe(b);
    expect(["split", "card", "minimal"]).toContain(a);
  });

  it("ne donne pas le même gabarit à tous les projets", () => {
    const projects = [
      "Atelier Lumière", "Clinique Voltaire", "Bordly", "Café Marceau", "Studio Nord",
      "Immo Rivage", "Academy Pulse", "Festival Onde", "Nova Fit", "Maison Sel",
    ];
    const layouts = new Set(projects.map((companyName) => pickAuthLayout({ companyName, slug: companyName })));
    expect(layouts.size).toBeGreaterThan(1);
  });
});

describe("pages de compte générées", () => {
  const metas = [shop, clinic, saasEn];

  it("compilent toujours, quel que soit le gabarit", () => {
    for (const layout of ["split", "card", "minimal"]) {
      for (const m of metas) {
        const meta = { ...m, authLayout: layout };
        expect(compiles(loginPageTsx(meta))).toBe(true);
        expect(compiles(signupPageTsx(meta))).toBe(true);
        expect(compiles(profilePageTsx(meta))).toBe(true);
        expect(compiles(settingsPageTsx(meta))).toBe(true);
      }
    }
  });

  it("ne sont PAS identiques d'un projet à l'autre (le bug corrigé)", () => {
    const logins = new Set(metas.map(loginPageTsx));
    const profiles = new Set(metas.map(profilePageTsx));
    const settings = new Set(metas.map(settingsPageTsx));
    expect(logins.size).toBe(metas.length);
    expect(profiles.size).toBe(metas.length);
    expect(settings.size).toBe(metas.length);
  });

  it("affichent le nom de l'entreprise sur la connexion", () => {
    expect(loginPageTsx(shop)).toContain("Atelier Lumière");
    expect(loginPageTsx(saasEn)).toContain("Bordly");
  });

  it("respectent la langue, y compris le format de date du profil", () => {
    expect(profilePageTsx(shop)).toContain('"fr-FR"');
    expect(profilePageTsx(saasEn)).toContain('"en-US"');
    expect(profilePageTsx(saasEn)).not.toContain("fr-FR");
    expect(settingsPageTsx(saasEn)).toContain("Appearance");
    expect(loginPageTsx(saasEn)).not.toContain("Mot de passe");
  });

  it("gardent le consentement RGPD sur l'inscription dans tous les gabarits", () => {
    for (const layout of ["split", "card", "minimal"]) {
      const src = signupPageTsx({ ...shop, authLayout: layout });
      expect(src).toContain('to="/privacy"');
      expect(src).toContain('to="/terms"');
      expect(src).toContain("disabled={busy || !accepted}");
    }
  });

  it("gardent la même mise en page entre connexion et inscription", () => {
    const meta = { ...shop, authLayout: "split" };
    expect(loginPageTsx(meta)).toContain("lg:grid-cols-2");
    expect(signupPageTsx(meta)).toContain("lg:grid-cols-2");
  });

  it("affichent le logo de la marque quand il existe", () => {
    const withLogo = { ...shop, logoUrl: "https://cdn.test/logo.png", authLayout: "card" };
    expect(loginPageTsx(withLogo)).toContain("https://cdn.test/logo.png");
    expect(loginPageTsx({ ...shop, authLayout: "card" })).not.toContain("<img");
  });
});

describe("buildScaffold", () => {
  const base = {
    companyName: "Atelier Lumière",
    slug: "atelier-lumiere",
    primaryColor: "#8A5A2B",
    accentColor: "#C9A227",
    font: "Fraunces",
    idea: "Boutique en ligne de produits artisanaux locaux",
    tagline: "L'artisanat local, livré chez toi",
    lang: "fr",
  };

  it("écrit des pages de compte personnalisées (et plus les constantes figées)", () => {
    const files = buildScaffold(base as any);
    const login = files.find((f) => f.path === "src/pages/Login.tsx")!;
    const profile = files.find((f) => f.path === "src/pages/Profile.tsx")!;
    expect(login.content).toContain("Atelier Lumière");
    expect(login.content).not.toContain("Ravi de te revoir");
    expect(profile.content).not.toContain("Gère ton compte et tes préférences");
    expect(compiles(login.content)).toBe(true);
    expect(compiles(profile.content)).toBe(true);
  });

  it("produit des pages de compte différentes pour deux entreprises différentes", () => {
    const a = buildScaffold(base as any);
    const b = buildScaffold({
      ...base,
      companyName: "Clinique Voltaire",
      slug: "clinique-voltaire",
      idea: "Cabinet médical avec prise de rendez-vous en ligne",
      tagline: "Votre santé, sans attente",
    } as any);
    const pick = (fs: typeof a, p: string) => fs.find((f) => f.path === p)!.content;
    for (const page of ["src/pages/Login.tsx", "src/pages/Profile.tsx", "src/pages/Settings.tsx"]) {
      expect(pick(a, page)).not.toBe(pick(b, page));
    }
  });

  it("n'écrit aucune page de compte quand withAuth === false", () => {
    const files = buildScaffold({ ...base, withAuth: false } as any);
    expect(files.some((f) => f.path === "src/pages/Login.tsx")).toBe(false);
    expect(files.some((f) => f.path === "src/pages/Profile.tsx")).toBe(false);
  });
});
