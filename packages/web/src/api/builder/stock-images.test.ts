import { describe, expect, test } from "bun:test";
import {
  isStockImageUrl,
  stockManifestKeys,
  removeManifestKeysFromSource,
  imagesImportPath,
  replaceStockImageUrls,
  replaceStockImagesInFiles,
} from "./stock-images";
import { keyToImagePrompt } from "./engine";
import { collectImageKeys, manifestEntriesInSource } from "./images-manifest";

const UNSPLASH = "https://images.unsplash.com/photo-1460925895917-afdab827c52f?q=80&w=2015&auto=format&fit=crop";

describe("isStockImageUrl", () => {
  test("banques d'images et services de remplissage", () => {
    for (const u of [
      UNSPLASH,
      "https://source.unsplash.com/random/800x600",
      "https://picsum.photos/seed/abc/800/600",
      "https://images.pexels.com/photos/1/pexels-photo-1.jpeg",
      "https://i.pravatar.cc/150?img=3",
      "https://via.placeholder.com/300",
      "https://placehold.co/600x400",
      "https://randomuser.me/api/portraits/women/44.jpg",
    ]) expect(isStockImageUrl(u)).toBe(true);
  });
  test("images légitimes non touchées", () => {
    for (const u of [
      "data:image/webp;base64,AAAA",
      "https://images-api.printify.com/mockup/abc/1.jpg",
      "https://fonts.gstatic.com/s/inter/v1/x.woff2",
      "https://velbaz.com/api/files/x.png",
      "/logo.svg",
      "",
      undefined,
    ]) expect(isStockImageUrl(u as any)).toBe(false);
  });
});

describe("manifeste", () => {
  const src = `const RAW = {\n  "hero": "data:image/webp;base64,AAA",\n  "home_hero": "${UNSPLASH}",\n  "about": "data:image/webp;base64,BBB"\n};\nexport const IMAGES = RAW;\n`;
  test("stockManifestKeys", () => {
    expect(stockManifestKeys({ a: UNSPLASH, b: "data:image/png;base64,x" })).toEqual(["a"]);
  });
  test("removeManifestKeysFromSource retire l'entrée et garde le reste valide", () => {
    const out = removeManifestKeysFromSource(src, ["home_hero"]);
    expect(out).not.toContain("unsplash");
    const entries = Object.fromEntries(manifestEntriesInSource(out));
    expect(Object.keys(entries).sort()).toEqual(["about", "hero"]);
    // reste du JS évaluable
    const obj = new Function(out.replace("export const IMAGES = RAW;", "return RAW;"))();
    expect(Object.keys(obj).sort()).toEqual(["about", "hero"]);
  });
  test("retrait de la dernière entrée", () => {
    const out = removeManifestKeysFromSource(src, ["about"]);
    const obj = new Function(out.replace("export const IMAGES = RAW;", "return RAW;"))();
    expect(Object.keys(obj).sort()).toEqual(["hero", "home_hero"]);
  });
});

describe("imagesImportPath", () => {
  test("chemins relatifs", () => {
    expect(imagesImportPath("src/pages/Home.tsx")).toBe("../lib/images");
    expect(imagesImportPath("src/components/sections/Hero.tsx")).toBe("../../lib/images");
    expect(imagesImportPath("src/App.tsx")).toBe("./lib/images");
    expect(imagesImportPath("app/index.tsx")).toBe("../lib/images");
    expect(imagesImportPath("app/(tabs)/home.tsx")).toBe("../../lib/images");
  });
});

describe("replaceStockImageUrls", () => {
  test("src JSX + import ajouté + clé tirée de l'alt", () => {
    const code = `import React from "react";\nimport { Star } from "lucide-react";\n\nexport default function Home() {\n  return <img src="${UNSPLASH}" alt="Coureuse au lever du soleil" className="w-full" />;\n}\n`;
    const r = replaceStockImageUrls(code, "src/pages/Home.tsx");
    expect(r.code).not.toContain("unsplash");
    expect(r.keys.length).toBe(1);
    expect(r.keys[0]).toMatch(/^home_coureuse_au_lever_du_soleil/);
    expect(r.code).toContain(`src={IMAGES.${r.keys[0]}}`);
    expect(r.code).toContain(`import { IMAGES } from "../lib/images";`);
    expect(collectImageKeys([{ path: "x.tsx", content: r.code }]).has(r.keys[0])).toBe(true);
    // l'import arrive après les imports existants
    expect(r.code.indexOf("lucide-react")).toBeLessThan(r.code.indexOf("lib/images"));
  });
  test("src={'…'}, littéral de données, url() CSS, bg-[url()]", () => {
    const code = `import { IMAGES } from "../lib/images";
const items = [{ name: "Trail", image: "https://picsum.photos/seed/a/600/400" }, { name: "Route", image: 'https://picsum.photos/seed/b/600/400' }];
export default function P() {
  return (<div>
    <img src={"https://i.pravatar.cc/100?img=1"} alt="Avatar client" />
    <section style={{ backgroundImage: "url(https://images.pexels.com/photos/2/a.jpeg)" }} />
    <div className="h-64 bg-[url('https://images.unsplash.com/photo-1')] bg-cover" />
    <img src={IMAGES.hero} alt="ok" />
  </div>);
}`;
    const r = replaceStockImageUrls(code, "src/pages/Shop.tsx", new Set(["hero"]));
    expect(r.code).not.toMatch(/picsum|pravatar|pexels|unsplash/);
    expect(r.keys.length).toBe(4);
    expect(r.code).toContain("backgroundImage: `url(${IMAGES.");
    expect(r.code).toContain(`className="h-64 bg-cover"`);
    expect(r.code).toContain("IMAGES.hero");
    // pas de second import
    expect(r.code.match(/from "\.\.\/lib\/images"/g)!.length).toBe(1);
    // clés distinctes, aucune ne vaut une clé déjà prise
    expect(new Set(r.keys).size).toBe(4);
    expect(r.keys).not.toContain("hero");
    // code toujours transpilable
    expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(r.code)).not.toThrow();
  });
  test("même URL deux fois → même clé", () => {
    const code = `const a = "${UNSPLASH}"; const b = "${UNSPLASH}";`;
    const r = replaceStockImageUrls(code, "src/lib/data.ts");
    expect(r.keys.length).toBe(1);
    expect(r.code).toContain(`import { IMAGES } from "../lib/images";`);
  });
  test("aucune URL de stock → inchangé ; lib/images.ts jamais touché", () => {
    const code = `export default () => <img src="https://images-api.printify.com/mockup/1.jpg" />;`;
    expect(replaceStockImageUrls(code, "src/pages/A.tsx")).toEqual({ code, keys: [], replaced: 0 });
    const img = `const RAW = { "a": "${UNSPLASH}" };`;
    expect(replaceStockImageUrls(img, "src/lib/images.ts").replaced).toBe(0);
  });
  test("React Native : source={{ uri: \"…\" }}", () => {
    const code = `import { Image } from "react-native";\nexport default () => <Image source={{ uri: "https://picsum.photos/400" }} />;`;
    const r = replaceStockImageUrls(code, "app/index.tsx");
    expect(r.code).toContain(`uri: IMAGES.`);
    expect(r.code).toContain(`import { IMAGES } from "../lib/images";`);
  });
  test("replaceStockImagesInFiles en place", () => {
    const files = [
      { path: "src/pages/A.tsx", content: `export default () => <img src="${UNSPLASH}" alt="Atelier" />;` },
      { path: "src/pages/B.tsx", content: `export default () => <p>rien</p>;` },
    ];
    const r = replaceStockImagesInFiles(files);
    expect(r.changedPaths).toEqual(["src/pages/A.tsx"]);
    expect(files[0].content).toContain("IMAGES.a_atelier");
    expect(files[1].content).toBe(`export default () => <p>rien</p>;`);
  });
});

describe("keyToImagePrompt", () => {
  test("héro sans sujet → montre les produits de la marque, pas un bureau", () => {
    const { prompt, aspect } = keyToImagePrompt("hero", { companyName: "SoulStride", idea: "marque de chaussures", products: ["Stride One", "Pulse Runner"] });
    expect(aspect).toBe("wide");
    expect(prompt).toContain("SoulStride");
    expect(prompt).toContain("Stride One");
    expect(prompt).toMatch(/Pas de scène de bureau/);
  });
  test("portrait : pas d'interdiction de personnes", () => {
    const { prompt, aspect } = keyToImagePrompt("team_founder", { companyName: "X", idea: "café" });
    expect(aspect).toBe("portrait");
    expect(prompt).not.toMatch(/Pas de scène de bureau/);
  });
});
