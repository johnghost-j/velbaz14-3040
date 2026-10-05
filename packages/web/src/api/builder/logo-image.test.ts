import { describe, expect, it } from "bun:test";
import {
  CUTOUT,
  cutoutLogoBackground,
  extractLogoColors,
  extractLogoColorsFromDataUri,
  makeLogoDataUriTransparent,
  makeLogoTransparent,
  parseDataUri,
  toDataUri,
} from "./logo-image";
import { getSharp } from "../lib/optional-import";

// Le modèle image ne produit jamais d'alpha : on reconstitue donc EXACTEMENT ce
// qu'il renvoie (raster opaque, fond blanc uni) pour vérifier le détourage.
type Paint = (x: number, y: number) => [number, number, number];

async function synth(width: number, height: number, paint: Paint, format: "png" | "jpeg" = "png"): Promise<Buffer> {
  const sharp = await getSharp();
  if (!sharp) throw new Error("sharp indisponible");
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const o = (y * width + x) * 3;
      px[o] = r; px[o + 1] = g; px[o + 2] = b;
    }
  }
  const pipe = sharp(px, { raw: { width, height, channels: 3 } });
  return format === "png" ? pipe.png().toBuffer() : pipe.jpeg({ quality: 100 }).toBuffer();
}

async function pixels(buf: Buffer): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const sharp = await getSharp();
  const raw = await sharp!(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: raw.data as Buffer, width: raw.info.width, height: raw.info.height, channels: raw.info.channels };
}

async function alphaAt(buf: Buffer, xRatio: number, yRatio: number): Promise<number> {
  const { data, width, height } = await pixels(buf);
  const x = Math.min(width - 1, Math.max(0, Math.round((width - 1) * xRatio)));
  const y = Math.min(height - 1, Math.max(0, Math.round((height - 1) * yRatio)));
  return data[(y * width + x) * 4 + 3];
}

const WHITE: [number, number, number] = [255, 255, 255];
const RED: [number, number, number] = [214, 40, 40];
const NAVY: [number, number, number] = [23, 42, 88];

/** Disque rouge centré sur fond blanc : le cas nominal du générateur de logo. */
const redDiscOnWhite = (size: number, radius = size * 0.3): Paint => {
  const c = (size - 1) / 2;
  return (x, y) => (Math.hypot(x - c, y - c) <= radius ? RED : WHITE);
};

describe("cutoutLogoBackground — cas nominal (fond blanc uni)", () => {
  it("rend le fond transparent et garde la marque opaque", async () => {
    const res = await cutoutLogoBackground(await synth(120, 120, redDiscOnWhite(120)));

    expect(res.reverted).toBe(false);
    expect(res.keyedRatio).toBeGreaterThan(0.3);
    expect(res.opaqueRatio).toBeGreaterThan(CUTOUT.minOpaqueRatio);

    const sharp = await getSharp();
    const meta = await sharp!(res.buf).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);

    // Coins = fond → totalement transparents. Centre = marque → totalement opaque.
    expect(await alphaAt(res.buf, 0, 0)).toBe(0);
    expect(await alphaAt(res.buf, 1, 0)).toBe(0);
    expect(await alphaAt(res.buf, 0, 1)).toBe(0);
    expect(await alphaAt(res.buf, 1, 1)).toBe(0);
    expect(await alphaAt(res.buf, 0.5, 0.5)).toBe(255);
  });

  it("recadre sur la marque plutôt que de garder le cadre d'origine", async () => {
    // Marque minuscule dans un grand cadre : sans recadrage elle serait
    // invisible dans le header.
    const res = await cutoutLogoBackground(await synth(200, 200, redDiscOnWhite(200, 20)));
    expect(res.reverted).toBe(false);
    expect(res.width).toBeLessThan(200);
    expect(res.height).toBeLessThan(200);
    expect(res.width).toBeGreaterThan(40); // la marque + sa marge, pas rognée
  });

  it("perce les contre-formes blanches intérieures (logo en anneau)", async () => {
    const size = 120;
    const c = (size - 1) / 2;
    const ring: Paint = (x, y) => {
      const d = Math.hypot(x - c, y - c);
      return d <= 48 && d >= 26 ? NAVY : WHITE;
    };
    const res = await cutoutLogoBackground(await synth(size, size, ring));
    expect(res.reverted).toBe(false);
    // Le trou de l'anneau doit laisser voir le site à travers.
    expect(await alphaAt(res.buf, 0.5, 0.5)).toBe(0);
    // L'anneau lui-même reste opaque.
    expect(await alphaAt(res.buf, 0.5, 0.06)).toBeGreaterThan(200);
  });

  it("adoucit les bords anti-aliasés au lieu de laisser un halo blanc", async () => {
    const size = 120;
    const c = (size - 1) / 2;
    // Dégradé net→blanc sur quelques pixels, comme un rendu anti-aliasé.
    const soft: Paint = (x, y) => {
      const d = Math.hypot(x - c, y - c);
      if (d <= 34) return RED;
      if (d >= 40) return WHITE;
      const t = (d - 34) / 6;
      return [
        Math.round(RED[0] + (255 - RED[0]) * t),
        Math.round(RED[1] + (255 - RED[1]) * t),
        Math.round(RED[2] + (255 - RED[2]) * t),
      ];
    };
    const res = await cutoutLogoBackground(await synth(size, size, soft));
    expect(res.reverted).toBe(false);
    const { data } = await pixels(res.buf);
    const alphas = new Set<number>();
    for (let i = 3; i < data.length; i += 4) alphas.add(data[i]);
    // Une alpha intermédiaire existe : le bord est dégradé, pas binaire.
    expect([...alphas].some((a) => a > 0 && a < 255)).toBe(true);
  });

  it("démate les bords : aucun pixel visible ne reste blanchâtre (pas de liseré)", async () => {
    const size = 120;
    const c = (size - 1) / 2;
    const soft: Paint = (x, y) => {
      const d = Math.hypot(x - c, y - c);
      if (d <= 34) return RED;
      if (d >= 40) return WHITE;
      const t = (d - 34) / 6;
      return [
        Math.round(RED[0] + (255 - RED[0]) * t),
        Math.round(RED[1] + (255 - RED[1]) * t),
        Math.round(RED[2] + (255 - RED[2]) * t),
      ];
    };
    const res = await cutoutLogoBackground(await synth(size, size, soft));
    const { data } = await pixels(res.buf);
    // Tout pixel qui se VOIT (alpha non nul) doit porter la couleur de la
    // marque, jamais un blanc résiduel : sinon le logo posé sur un header
    // sombre est cerné d'un halo clair.
    let visible = 0;
    let whitish = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 24) continue;
      visible++;
      const lo = Math.min(data[i], data[i + 1], data[i + 2]);
      if (lo > 180) whitish++;
    }
    expect(visible).toBeGreaterThan(0);
    expect(whitish).toBe(0);
  });

  it("accepte un JPEG en entrée et renvoie quand même un PNG avec alpha", async () => {
    const res = await cutoutLogoBackground(await synth(120, 120, redDiscOnWhite(120), "jpeg"));
    expect(res.reverted).toBe(false);
    const sharp = await getSharp();
    const meta = await sharp!(res.buf).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(await alphaAt(res.buf, 0, 0)).toBe(0);
  });
});

describe("cutoutLogoBackground — garde-fous", () => {
  it("abandonne si le fond n'est pas blanc (aucun détourage hasardeux)", async () => {
    const size = 100;
    const c = (size - 1) / 2;
    const onNavy: Paint = (x, y) => (Math.hypot(x - c, y - c) <= 30 ? RED : NAVY);
    const res = await cutoutLogoBackground(await synth(size, size, onNavy));

    expect(res.reverted).toBe(true);
    expect(res.keyedRatio).toBe(0);
    // Toujours un PNG exploitable : un logo à fond coloré vaut mieux que rien.
    const sharp = await getSharp();
    const meta = await sharp!(res.buf).metadata();
    expect(meta.format).toBe("png");
    expect(await alphaAt(res.buf, 0, 0)).toBe(255);
  });

  it("abandonne plutôt que d'effacer un logo blanc sur fond blanc", async () => {
    const res = await cutoutLogoBackground(await synth(80, 80, () => WHITE));
    expect(res.reverted).toBe(true);
    expect(res.reason).toContain("détourage abandonné");
  });

  it("ne jette pas sur une image d'un seul pixel", async () => {
    const res = await cutoutLogoBackground(await synth(1, 1, () => RED));
    expect(res.buf.length).toBeGreaterThan(0);
  });

  it("ne jette pas sur des octets qui ne sont pas une image", async () => {
    const res = await cutoutLogoBackground(Buffer.from("pas une image du tout"));
    expect(res.reverted).toBe(true);
    expect(res.buf.length).toBeGreaterThan(0);
  });
});

describe("makeLogoTransparent / data URIs", () => {
  it("renvoie toujours un PNG, même quand l'entrée est un JPEG", async () => {
    const jpeg = await synth(100, 100, redDiscOnWhite(100), "jpeg");
    const out = await makeLogoTransparent({ data: jpeg.toString("base64"), mimeType: "image/jpeg" });
    expect(out?.mimeType).toBe("image/png");
    const sharp = await getSharp();
    const meta = await sharp!(Buffer.from(out!.data, "base64")).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it("laisse passer null et une image vide sans jeter", async () => {
    expect(await makeLogoTransparent(null)).toBeNull();
    const empty = { data: "", mimeType: "image/png" };
    expect(await makeLogoTransparent(empty)).toEqual(empty);
  });

  it("détoure une data URI et conserve le format data:image/png;base64", async () => {
    const png = await synth(100, 100, redDiscOnWhite(100));
    const uri = toDataUri({ data: png.toString("base64"), mimeType: "image/png" });
    const out = await makeLogoDataUriTransparent(uri);
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
    expect(out).not.toBe(uri);
    expect(await alphaAt(Buffer.from(parseDataUri(out)!.data, "base64"), 0, 0)).toBe(0);
  });

  it("laisse une URL distante intacte (rien à détourer côté serveur)", async () => {
    const url = "https://cdn.example.com/logo.png";
    expect(await makeLogoDataUriTransparent(url)).toBe(url);
    expect(parseDataUri(url)).toBeNull();
  });

  it("parseDataUri lit le mime et les données", () => {
    expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({ mimeType: "image/png", data: "AAAB" });
    expect(parseDataUri("")).toBeNull();
  });
});

describe("extractLogoColors — la vérité terrain des couleurs de marque", () => {
  it("met la couleur chromatique dominante en tête, pas le blanc", async () => {
    const colors = await extractLogoColors(await synth(120, 120, redDiscOnWhite(120)));
    expect(colors.length).toBeGreaterThan(0);
    const [h] = colors;
    expect(h).toMatch(/^#[0-9A-F]{6}$/);
    // Rouge reconnaissable (teinte proche de 0/360, forte saturation).
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    expect(r).toBeGreaterThan(150);
    expect(r - Math.max(g, b)).toBeGreaterThan(80);
  });

  it("préfère la couleur chromatique au noir majoritaire (logo noir + rouge)", async () => {
    // 3/4 de noir, 1/4 de rouge : un site gris serait un contresens de marque.
    const paint: Paint = (x, y) => (x < 30 && y < 30 ? RED : x < 60 && y < 60 ? [17, 17, 17] : WHITE);
    const colors = await extractLogoColors(await synth(60, 60, paint));
    expect(colors.length).toBeGreaterThanOrEqual(2);
    const r = parseInt(colors[0].slice(1, 3), 16);
    const b = parseInt(colors[0].slice(5, 7), 16);
    expect(r - b).toBeGreaterThan(80); // c'est bien le rouge qui mène
  });

  it("ne renvoie pas deux nuances de la même couleur", async () => {
    const paint: Paint = (x) => (x < 40 ? [214, 40, 40] : x < 80 ? [220, 46, 44] : WHITE);
    const colors = await extractLogoColors(await synth(120, 60, paint));
    expect(colors.length).toBe(1);
  });

  it("renvoie une liste vide sur une image sans couleur exploitable", async () => {
    expect(await extractLogoColors(await synth(40, 40, () => WHITE))).toEqual([]);
    expect(await extractLogoColors(Buffer.from("pas une image"))).toEqual([]);
  });

  it("respecte la limite max demandée", async () => {
    const paint: Paint = (x) =>
      x < 25 ? RED : x < 50 ? NAVY : x < 75 ? [240, 180, 20] : x < 100 ? [20, 140, 90] : [120, 60, 160];
    const colors = await extractLogoColors(await synth(125, 40, paint), 2);
    expect(colors.length).toBe(2);
    expect(colors[0]).not.toBe(colors[1]);
  });

  it("mesure les couleurs sur le logo DÉTOURÉ (le fond retiré ne compte pas)", async () => {
    const cut = await cutoutLogoBackground(await synth(120, 120, redDiscOnWhite(120)));
    const uri = toDataUri({ data: cut.buf.toString("base64"), mimeType: "image/png" });
    const colors = await extractLogoColorsFromDataUri(uri);
    expect(colors.length).toBe(1);
    expect(colors[0]).toMatch(/^#[0-9A-F]{6}$/);
    expect(await extractLogoColorsFromDataUri("https://example.com/logo.png")).toEqual([]);
  });
});
