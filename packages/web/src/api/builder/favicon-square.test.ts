import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { FAVICON, buildFaviconSet, buildFaviconSetFromBytes } from "./favicon-square";
import { buildScaffold, type AppMeta } from "./scaffold";

// Logo détouré typique d'un wordmark : 900×300 (3:1), fond transparent, avec
// une marque pleine de 600×200 au centre. C'est la forme mesurée en base
// (Paséo 925×456, Paselle 608×265) qui était étirée dans l'onglet.
async function wideLogo(color = { r: 20, g: 40, b: 200 }): Promise<Buffer> {
  const mark = await sharp({ create: { width: 600, height: 200, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: 900, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, left: 150, top: 50 }])
    .png()
    .toBuffer();
}

const fromUri = (uri: string) => Buffer.from(uri.replace(/^data:image\/png;base64,/, ""), "base64");

/** Boîte des pixels opaques d'un PNG. */
async function opaqueBox(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 128) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { w: maxX - minX + 1, h: maxY - minY + 1, minX, minY, maxX, maxY, width: info.width, height: info.height };
}

describe("favicon carré à partir du logo", () => {
  it("un logo large donne une icône CARRÉE, marque non déformée (rapport 3:1 conservé)", async () => {
    const set = await buildFaviconSetFromBytes(await wideLogo());
    const icon = fromUri(set.icon);
    const meta = await sharp(icon).metadata();
    expect(meta.width).toBe(FAVICON.iconSize);
    expect(meta.height).toBe(FAVICON.iconSize);
    const box = await opaqueBox(icon);
    // La marque 600×200 garde son rapport 3:1 (à 1 px d'arrondi près).
    expect(Math.abs(box.w / box.h - 3)).toBeLessThan(0.05);
    // Elle remplit la largeur utile (marge FAVICON.iconPad), centrée.
    const inner = Math.round(FAVICON.iconSize * (1 - 2 * FAVICON.iconPad));
    expect(Math.abs(box.w - inner)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.minY - (FAVICON.iconSize - 1 - box.maxY))).toBeLessThanOrEqual(1);
    // Le reste reste transparent (pas de bandes de couleur ajoutées).
    const corner = await sharp(icon).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0);
  });

  it("l'icône iOS est carrée et opaque (fond blanc pour un logo foncé)", async () => {
    const set = await buildFaviconSetFromBytes(await wideLogo());
    const apple = fromUri(set.appleTouch);
    const meta = await sharp(apple).metadata();
    expect(meta.width).toBe(FAVICON.appleSize);
    expect(meta.height).toBe(FAVICON.appleSize);
    const corner = await sharp(apple).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect([corner[0], corner[1], corner[2], corner[3]]).toEqual([255, 255, 255, 255]);
  });

  it("un logo clair (blanc) reçoit un fond sombre sur iOS, sinon il disparaîtrait", async () => {
    const set = await buildFaviconSetFromBytes(await wideLogo({ r: 250, g: 250, b: 250 }));
    const corner = await sharp(fromUri(set.appleTouch)).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[0]).toBeLessThan(40);
    expect(corner[3]).toBe(255);
  });

  it("un logo entièrement transparent est REFUSÉ (pas de favicon vide)", async () => {
    const empty = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await expect(buildFaviconSetFromBytes(empty)).rejects.toThrow(/transparent/);
  });

  it("accepte une data URI et rejette un format inconnu", async () => {
    const uri = `data:image/png;base64,${(await wideLogo()).toString("base64")}`;
    const set = await buildFaviconSet(uri);
    expect(set.icon.startsWith("data:image/png;base64,")).toBe(true);
    await expect(buildFaviconSet("ftp://exemple/logo.png")).rejects.toThrow(/non pris en charge/);
  });
});

describe("index.html du scaffold", () => {
  const base: AppMeta = {
    companyName: "Paséo", slug: "paseo", primaryColor: "#123456", accentColor: "#654321",
    font: "Inter", idea: "", tagline: "", lang: "fr",
  } as AppMeta;
  const indexOf = (m: AppMeta) => buildScaffold(m).find((f) => f.path === "index.html")!.content;

  it("utilise le favicon carré, jamais le logo brut", () => {
    const logoUrl = "data:image/png;base64,TE9HT0JSVVQ=";
    const html = indexOf({ ...base, logoUrl, favicon: { icon: "data:image/png;base64,SUNPTg==", appleTouch: "data:image/png;base64,QVBQTEU=" } });
    expect(html).toContain(`<link rel="icon" href="data:image/png;base64,SUNPTg==" />`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="data:image/png;base64,QVBQTEU=" />`);
    expect(html).not.toContain(logoUrl);
  });

  it("sans favicon carré, icône à l'initiale (carrée) — pas le logo brut", () => {
    const logoUrl = "data:image/png;base64,TE9HT0JSVVQ=";
    const html = indexOf({ ...base, logoUrl });
    expect(html).not.toContain(logoUrl);
    expect(html).toContain(`<link rel="icon" href="data:image/svg+xml,`);
  });
});
