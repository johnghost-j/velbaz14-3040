import { describe, it, expect } from "bun:test";
import {
  imagesModuleSource,
  IMAGE_PLACEHOLDER_DATA_URI,
  isPlaceholderImage,
  placeholderGradientDataUri,
  manifestKeysInSource,
  patchImagesManifestSource,
  retryPlaceholderImages,
  manifestImageBytes,
  unpublishableManifestKeys,
  repairUnpublishableImages,
} from "./images-manifest";

/**
 * Bug couvert — compte de test, 2026-09-25 : « ça a généré des images très
 * buguées ». Cause : le modèle invente une clé (`IMAGES.hero_2`), le manifeste
 * renvoie `undefined`, le navigateur affiche une image cassée.
 *
 * Le module généré est du code source sous forme de chaîne : on l'ÉVALUE ici
 * (après avoir retiré les annotations de type) pour tester le comportement
 * réel du Proxy, pas juste la présence de mots dans la source.
 */
function evalSource(src: string): Record<string, string> {
  const js = src
    .replace(/export const IMAGES: Record<string, string> =/, "const IMAGES =")
    .replace(/const RAW: Record<string, string> =/, "const RAW =")
    .replace(/\(target as any\)/g, "(target)");
  // eslint-disable-next-line no-new-func
  return new Function(`${js}\nreturn IMAGES;`)() as Record<string, string>;
}

function evalModule(urls: Record<string, string>): Record<string, string> {
  return evalSource(imagesModuleSource(urls));
}

describe("imagesModuleSource", () => {
  const IMAGES = evalModule({
    home_hero: "data:image/webp;base64,AAA",
    about_photo: "https://cdn.example.com/about.webp",
    vide: "",
  });

  it("renvoie l'image générée pour une clé connue", () => {
    expect(IMAGES.home_hero).toBe("data:image/webp;base64,AAA");
    expect(IMAGES.about_photo).toBe("https://cdn.example.com/about.webp");
  });

  it("renvoie le dégradé de repli pour une clé inventée par le modèle", () => {
    // C'était `undefined` → <img src={undefined}> → image cassée.
    expect(IMAGES.hero_2).toBe(IMAGE_PLACEHOLDER_DATA_URI);
    expect(IMAGES["team_photo_3"]).toBe(IMAGE_PLACEHOLDER_DATA_URI);
  });

  it("traite une valeur vide comme absente", () => {
    expect(IMAGES.vide).toBe(IMAGE_PLACEHOLDER_DATA_URI);
  });

  it("le repli est un PNG (React Native n'affiche pas un SVG en data URI)", () => {
    expect(IMAGE_PLACEHOLDER_DATA_URI.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("n'intercepte pas les propriétés d'objet standard", () => {
    // Sans cette garde, `${IMAGES}` lèverait « toString is not a function ».
    expect(typeof (IMAGES as any).toString).toBe("function");
    expect(() => `${IMAGES}`).not.toThrow();
    expect(() => JSON.stringify(IMAGES)).not.toThrow();
    // Un await accidentel sur IMAGES ne doit pas bloquer sur un faux thenable.
    expect((IMAGES as any).then).toBeUndefined();
  });

  it("garde l'énumération intacte : une galerie peut mapper sur les clés", () => {
    expect(Object.keys(IMAGES).sort()).toEqual(["about_photo", "home_hero", "vide"]);
    expect(Object.entries(IMAGES).length).toBe(3);
  });

  it("fonctionne sur un manifeste vide (état du scaffold)", () => {
    const empty = evalModule({});
    expect(Object.keys(empty)).toEqual([]);
    expect(empty.anything).toBe(IMAGE_PLACEHOLDER_DATA_URI);
  });
});

/**
 * Bug couvert — compte de test, 2026-09-25 (3e passe) : « les images générées
 * sont encore buguées ». Les deux passes précédentes portaient sur les octets
 * (contrôle qualité) et sur les clés inventées (Proxy de repli) ; les deux sont
 * vérifiées propres. Le défaut restant était en AVAL, dans la comptabilité du
 * manifeste :
 *
 *  1. l'aperçu en direct pose un dégradé « en chargement » sur CHAQUE clé, puis
 *     les vraies images le remplacent — mais un visuel raté gardait le dégradé
 *     à vie, invisible pour le filet de sécurité (qui ne cherchait que les clés
 *     ABSENTES) ;
 *  2. le patch textuel insérait toujours en tête, sans regarder si la clé
 *     existait déjà : une clé régénérée se retrouvait DEUX FOIS dans l'objet
 *     littéral, et en JS la dernière gagne → le placeholder écrasait la vraie
 *     image qu'on venait de générer.
 */
describe("repérage des placeholders (3e passe)", () => {
  const REAL_WEBP = "data:image/webp;base64,AAAA";
  const REAL_CDN = "https://cdn.example.com/hero.webp";

  it("reconnaît un dégradé de repli/chargement comme « pas une vraie image »", () => {
    expect(isPlaceholderImage(placeholderGradientDataUri("#6366f1", "#8b5cf6"))).toBe(true);
    // Voile « en cours de chargement » de l'aperçu en direct.
    expect(isPlaceholderImage(placeholderGradientDataUri("#6366f1", "#8b5cf6", [0.3, 0.12]))).toBe(true);
    expect(isPlaceholderImage(IMAGE_PLACEHOLDER_DATA_URI)).toBe(true);
    expect(isPlaceholderImage("")).toBe(true);
    expect(isPlaceholderImage(undefined)).toBe(true);
  });

  it("ne prend pas une vraie image pour un placeholder", () => {
    expect(isPlaceholderImage(REAL_WEBP)).toBe(false);
    expect(isPlaceholderImage(REAL_CDN)).toBe(false);
    // Un SVG en data URI qui n'est PAS un de nos placeholders (illustration
    // vectorielle générée) doit être livré tel quel.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>').toString("base64");
    expect(isPlaceholderImage(`data:image/svg+xml;base64,${svg}`)).toBe(false);
  });

  it("le placeholder est un vrai dégradé affichable, pas un marqueur nu", () => {
    const uri = placeholderGradientDataUri("#0ea5e9", "#22d3ee");
    const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    expect(svg).toContain("#0ea5e9");
    expect(svg).toContain("#22d3ee");
    expect(svg).toContain("linearGradient");
    // Couleur invalide → repli sûr, jamais d'injection dans le SVG.
    const hostile = placeholderGradientDataUri('"/><script>x</script>', "#fff");
    expect(Buffer.from(hostile.split(",")[1], "base64").toString("utf8")).not.toContain("<script>");
  });

  it("une clé qui ne porte QU'UN placeholder compte comme manquante", () => {
    const source = imagesModuleSource({
      home_hero: REAL_WEBP,
      about_photo: REAL_CDN,
      team_photo: placeholderGradientDataUri("#6366f1", "#8b5cf6"),
    });
    const keys = manifestKeysInSource(source);
    expect(keys.has("home_hero")).toBe(true);
    expect(keys.has("about_photo")).toBe(true);
    // C'est le cœur du bug : la clé EXISTE, mais il n'y a pas d'image dedans.
    expect(keys.has("team_photo")).toBe(false);
  });

  it("patch : une nouvelle clé est insérée et lisible", () => {
    const source = imagesModuleSource({ home_hero: REAL_WEBP });
    const patched = patchImagesManifestSource(source, { contact_map: "data:image/webp;base64,BBBB" });
    expect(patched).not.toBeNull();
    const IMAGES = evalSource(patched!);
    expect(IMAGES.home_hero).toBe(REAL_WEBP);
    expect(IMAGES.contact_map).toBe("data:image/webp;base64,BBBB");
  });

  it("patch : une clé régénérée est remplacée sur place, pas dupliquée", () => {
    const source = imagesModuleSource({
      home_hero: REAL_WEBP,
      team_photo: placeholderGradientDataUri("#6366f1", "#8b5cf6"),
    });
    const patched = patchImagesManifestSource(source, { team_photo: "data:image/webp;base64,CCCC" })!;
    // Une seule entrée pour la clé : l'insertion en tête en créait une 2e, et
    // l'ancienne (le placeholder), plus bas, l'emportait.
    expect(patched.match(/"team_photo":/g)?.length).toBe(1);
    const IMAGES = evalSource(patched);
    expect(IMAGES.team_photo).toBe("data:image/webp;base64,CCCC");
    expect(IMAGES.home_hero).toBe(REAL_WEBP);
    // Et la clé compte désormais comme présente.
    expect(manifestKeysInSource(patched).has("team_photo")).toBe(true);
  });

  it("patch : gère d'un coup une clé à remplacer et une clé à créer", () => {
    const source = imagesModuleSource({
      home_hero: placeholderGradientDataUri("#6366f1", "#8b5cf6"),
      about_photo: REAL_CDN,
    });
    const patched = patchImagesManifestSource(source, {
      home_hero: "data:image/webp;base64,DDDD",
      services_bg: "data:image/webp;base64,EEEE",
    })!;
    const IMAGES = evalSource(patched);
    expect(IMAGES.home_hero).toBe("data:image/webp;base64,DDDD");
    expect(IMAGES.about_photo).toBe(REAL_CDN);
    expect(IMAGES.services_bg).toBe("data:image/webp;base64,EEEE");
    expect(manifestKeysInSource(patched).size).toBe(3);
  });

  it("patch : ancre introuvable → l'appelant doit réécrire le module", () => {
    expect(patchImagesManifestSource("// un fichier sans manifeste\n", { hero: REAL_WEBP })).toBeNull();
    // Mais si tout est déjà remplaçable sur place, pas besoin d'ancre.
    expect(patchImagesManifestSource('  "hero": "x",', { hero: REAL_WEBP })).toContain(REAL_WEBP);
  });

  it("patch : supporte l'ancien format `export const IMAGES = {`", () => {
    const legacy =
      "export const IMAGES: Record<string, string> = {\n" +
      `  "home_hero": "${REAL_WEBP}",\n};\n`;
    const patched = patchImagesManifestSource(legacy, { contact_map: "data:image/webp;base64,FFFF" })!;
    expect(patched).toContain("home_hero");
    expect(patched).toContain("contact_map");
  });
});

/**
 * Le rattrapage du build, éprouvé avec un fournisseur qui rate — le cas qu'on
 * ne peut PAS provoquer sur le vrai modèle (il génère proprement en ce moment),
 * et qui est justement celui qui livrait des rectangles dégradés à l'utilisateur.
 */
describe("retryPlaceholderImages (rattrapage du build)", () => {
  const REAL = "data:image/webp;base64,AAAA";
  const PH = () => placeholderGradientDataUri("#6366f1", "#8b5cf6", [0.3, 0.12]);

  it("régénère les visuels ratés et laisse les réussis intacts", async () => {
    const urls = { home_hero: REAL, team_photo: PH(), about_1: PH() };
    const asked: string[][] = [];
    const res = await retryPlaceholderImages(urls, async (keys) => {
      asked.push([...keys].sort());
      return Object.fromEntries(keys.map(k => [k, `data:image/webp;base64,${k}`]));
    });
    // Seuls les placeholders sont relancés — on ne repaie pas les images OK.
    expect(asked).toEqual([["about_1", "team_photo"]]);
    expect(urls.home_hero).toBe(REAL);
    expect(urls.team_photo).toBe("data:image/webp;base64,team_photo");
    expect(res.unresolved).toEqual([]);
  });

  it("ne fait rien quand tout est déjà une vraie image", async () => {
    const urls = { a: REAL, b: "https://cdn.example.com/b.webp" };
    let called = false;
    const res = await retryPlaceholderImages(urls, async () => { called = true; return {}; });
    expect(called).toBe(false);
    expect(res.attempted).toEqual([]);
  });

  it("signale les visuels que même la relance ne sauve pas", async () => {
    const urls = { ok_1: PH(), perdu: PH() };
    const msgs: string[] = [];
    const res = await retryPlaceholderImages(
      urls,
      async () => ({ ok_1: REAL, perdu: placeholderGradientDataUri("#f97316", "#f43f5e") }),
      (m) => msgs.push(m),
    );
    expect(urls.ok_1).toBe(REAL);
    // Le dégradé de dernier recours reste reconnaissable → régénérable plus tard.
    expect(res.unresolved).toEqual(["perdu"]);
    expect(msgs.some(m => m.includes("restent un dégradé de repli"))).toBe(true);
  });

  it("un fournisseur qui lève ne fait pas tomber le build", async () => {
    const urls = { hero: PH() };
    const msgs: string[] = [];
    const res = await retryPlaceholderImages(
      urls,
      async () => { throw new Error("gateway 503"); },
      (m) => msgs.push(m),
    );
    expect(res.unresolved).toEqual(["hero"]);
    expect(msgs.some(m => m.includes("gateway 503"))).toBe(true);
    // Le dégradé de chargement est toujours là : rien de cassé à l'écran.
    expect(isPlaceholderImage(urls.hero)).toBe(true);
  });

  it("n'écrase jamais une vraie image par un placeholder de repli", async () => {
    const urls = { hero: PH(), garde: REAL };
    // Un générateur zélé qui renvoie aussi des clés déjà bonnes, en dégradé.
    await retryPlaceholderImages(urls, async () => ({
      hero: "data:image/webp;base64,BBBB",
      garde: placeholderGradientDataUri("#000", "#fff"),
    }));
    expect(urls.hero).toBe("data:image/webp;base64,BBBB");
    expect(urls.garde).toBe(REAL);
  });

  it("le manifeste écrit après rattrapage ne contient plus de placeholder", async () => {
    const urls = { home_hero: PH(), about_1: PH() };
    await retryPlaceholderImages(urls, async (keys) =>
      Object.fromEntries(keys.map(k => [k, `data:image/webp;base64,${k}`])));
    const source = imagesModuleSource(urls);
    expect(manifestKeysInSource(source).size).toBe(2);
    const IMAGES = evalSource(source);
    expect(Object.keys(IMAGES).filter(k => isPlaceholderImage(IMAGES[k])).length).toBe(0);
  });
});

// ── 4e passe : audit des octets RÉELLEMENT livrés ───────────────────────────
// Bug couvert — « les images générées sont toujours buguées ». Les 3 passes
// précédentes jugeaient l'image AVANT l'encodage WebP publié, et rien ne
// relisait jamais un manifeste déjà écrit : un projet entier a été livré avec
// 16 visuels abîmés annoncés « générés ». Ces tests verrouillent la relecture.
describe("repairUnpublishableImages (relecture des octets livrés)", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const img = (s: string) => `data:image/webp;base64,${b64(s)}`;
  const PH2 = () => placeholderGradientDataUri("#111", "#222", [0.3, 0.12]);
  /** Contrôle qualité factice : le contenu décodé porte le verdict attendu. */
  const inspect = async (buf: Buffer) => {
    const t = buf.toString();
    if (t.includes("BOUILLIE")) return { ok: false, severity: "fatal", reason: "traînées horizontales" };
    if (t.includes("DOUTEUX")) return { ok: false, severity: "suspect", reason: "score de bloc élevé" };
    return { ok: true, severity: "ok", reason: "" };
  };

  it("décode un data URI image et ignore le reste", () => {
    expect(manifestImageBytes(img("ok"))?.toString()).toBe("ok");
    expect(manifestImageBytes("https://cdn.example.com/a.webp")).toBeNull();
    expect(manifestImageBytes(PH2())).toBeNull(); // SVG de repli
    expect(manifestImageBytes("")).toBeNull();
    expect(manifestImageBytes(undefined)).toBeNull();
  });

  it("repère les images livrées illisibles, pas les saines", async () => {
    const bad = await unpublishableManifestKeys(
      { a: img("photo propre"), b: img("BOUILLIE"), c: img("BOUILLIE aussi") },
      inspect,
    );
    expect(bad.map(x => x.key).sort()).toEqual(["b", "c"]);
    expect(bad[0].severity).toBe("fatal");
  });

  it("laisse passer les `suspect` par défaut (14 % de faux positifs mesurés)", async () => {
    const urls = { a: img("DOUTEUX") };
    expect((await unpublishableManifestKeys(urls, inspect)).length).toBe(0);
    // …mais sait les viser quand on le demande explicitement.
    const both = await unpublishableManifestKeys(urls, inspect, ["fatal", "suspect"]);
    expect(both.map(x => x.key)).toEqual(["a"]);
  });

  it("ne relit ni les placeholders ni les URLs distantes (aucune génération)", async () => {
    let called = false;
    const res = await repairUnpublishableImages(
      { a: PH2(), b: "https://cdn.example.com/x.webp" },
      inspect,
      async () => { called = true; return {}; },
    );
    expect(res.rejected).toEqual([]);
    expect(called).toBe(false);
  });

  it("remplace l'image abîmée et garde les bonnes intactes", async () => {
    const urls = { hero: img("BOUILLIE"), garde: img("photo propre") };
    const msgs: string[] = [];
    const res = await repairUnpublishableImages(
      urls,
      inspect,
      async (keys) => Object.fromEntries(keys.map(k => [k, img(`refait ${k}`)])),
      (m) => msgs.push(m),
    );
    expect(res.rejected).toEqual(["hero"]);
    expect(res.repaired).toEqual(["hero"]);
    expect(urls.hero).toBe(img("refait hero"));
    expect(urls.garde).toBe(img("photo propre"));
    expect(msgs.some(m => m.includes("1/1"))).toBe(true);
  });

  it("garde l'image abîmée si la régénération échoue ou rend un placeholder", async () => {
    const urls = { hero: img("BOUILLIE") };
    const msgs: string[] = [];
    await repairUnpublishableImages(urls, inspect, async () => { throw new Error("gateway 503"); }, (m) => msgs.push(m));
    expect(urls.hero).toBe(img("BOUILLIE")); // une image moche vaut mieux qu'un trou
    expect(msgs.some(m => m.includes("gateway 503"))).toBe(true);

    const res = await repairUnpublishableImages(urls, inspect, async () => ({ hero: PH2() }));
    expect(urls.hero).toBe(img("BOUILLIE"));
    expect(res.repaired).toEqual([]);
  });

  it("un manifeste relu deux fois ne déclenche plus rien (pas de boucle)", async () => {
    const urls = { hero: img("BOUILLIE") };
    let runs = 0;
    const regen = async (keys: string[]) => { runs++; return Object.fromEntries(keys.map(k => [k, img(`net ${k}`)])); };
    await repairUnpublishableImages(urls, inspect, regen);
    await repairUnpublishableImages(urls, inspect, regen);
    expect(runs).toBe(1);
  });
});
