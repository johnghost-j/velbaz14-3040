// [2026-09-25] Garde-fou du correctif « images générées buguées ».
// Le seuil ARTIFACT_MAX a été calibré sur des mesures réelles :
//   manifeste cassé stocké en base : 1,55 → 2,15 (23 visuels sur 23)
//   manifeste sain + 6 générations neuves : 1,03 → 1,45
//
// [2026-09-25 — 2e passe] Le seuil de bloc ci-dessus ne suffisait pas : mesuré
// sur 74 images propres il va de 1,10 à 1,82, et l'image buguée signalée par
// l'utilisateur sort à 1,80 — indistinguable. Le défaut réel (rangées
// dupliquées / « traînées ») se mesure par `dragArtifactScore` :
//   74 images propres → 0,000 … 1,177 %
//   image buguée      → 2,172 %
//   captures d'UI     → jusqu'à 26 % SANS défaut ⇒ écartées par flatPaletteShare
import { describe, expect, it } from "bun:test";
import {
  ARTIFACT_MAX,
  DRAG_MAX,
  GRAPHIC_PALETTE_MAX,
  blockArtifactScore,
  dragArtifactScore,
  flatPaletteShare,
  inspectImageBuffer,
} from "./image-quality";

/** Dégradé lisse : aucune grille de blocs, le profil doit être plat. */
function smoothGradient(w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) g[y * w + x] = (x * 255) / w;
  }
  return g;
}

/** Image « en escalier » : valeur constante par bloc de 16 px → marches nettes. */
function blocky(w: number, h: number, block = 16): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = Math.floor(x / block);
      const by = Math.floor(y / block);
      g[y * w + x] = ((bx * 37 + by * 91) % 5) * 50;
    }
  }
  return g;
}

describe("blockArtifactScore", () => {
  it("reste proche de 1 sur un dégradé lisse", () => {
    const s = blockArtifactScore(smoothGradient(256, 128), 256, 128);
    expect(s).toBeLessThan(1.2);
  });

  it("explose sur une grille de blocs de 16 px", () => {
    const s = blockArtifactScore(blocky(256, 128), 256, 128);
    expect(s).toBeGreaterThan(ARTIFACT_MAX);
  });

  it("est indépendant de la phase (un recadrage ne fausse pas la mesure)", () => {
    const w = 256, h = 128, block = 16;
    const full = blocky(w, h, block);
    // même image décalée de 5 px à gauche
    const shifted = new Uint8Array((w - 5) * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 5; x++) shifted[y * (w - 5) + x] = full[y * w + x + 5];
    }
    const a = blockArtifactScore(full, w, h);
    const b = blockArtifactScore(shifted, w - 5, h);
    expect(Math.abs(a - b)).toBeLessThan(0.35);
    expect(b).toBeGreaterThan(ARTIFACT_MAX);
  });

  it("renvoie 1 sur une image uniforme (rien à mesurer)", () => {
    expect(blockArtifactScore(new Uint8Array(64 * 64), 64, 64)).toBe(1);
  });

  it("renvoie 1 sur une image trop petite pour être jugée", () => {
    expect(blockArtifactScore(new Uint8Array(8 * 4), 8, 4)).toBe(1);
  });
});

// ── Jeux d'essai pour le détecteur de traînées ──────────────────────────────

/** Générateur déterministe (pas de Math.random dans un test). */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** Texture « photo » : dégradé + bruit fin ⇒ aucune série identique longue. */
function photoish(w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  const rnd = lcg(7);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      g[y * w + x] = Math.min(255, Math.max(0, ((x / w) * 120 + (y / h) * 60 + rnd() * 70) | 0));
    }
  }
  return g;
}

/**
 * Corruption « traînée » : des bandes de lignes rejouent le dernier pixel connu
 * par paliers — exactement ce qu'on voit sur les images buguées signalées.
 */
function smear(src: Uint8Array, w: number, h: number, intensity = 1): Uint8Array {
  const out = Uint8Array.from(src);
  const rnd = lcg(999);
  const bands = Math.max(1, Math.round((h / 40) * intensity));
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor(rnd() * h);
    const bh = 3 + Math.floor(rnd() * 30 * intensity);
    const hold = 4 + Math.floor(rnd() * 20);
    for (let y = y0; y < Math.min(h, y0 + bh); y++) {
      const x0 = Math.floor(rnd() * w * 0.5);
      for (let x = x0; x < w; x++) out[y * w + x] = out[y * w + x0 + Math.floor((x - x0) / hold) * hold];
    }
  }
  return out;
}

/** Maquette d'écran : fond clair + « texte » en hampes fines sur des lignes. */
function uiMock(w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h).fill(244);
  const rnd = lcg(3);
  for (let line = 16; line < h - 16; line += 24) {
    let x = 12;
    while (x < w - 16) {
      const glyph = 2 + Math.floor(rnd() * 2);
      for (let dx = 0; dx < glyph; dx++) {
        for (let dy = 0; dy < 12; dy++) g[(line + dy) * w + x + dx] = 28;
      }
      x += glyph + 2 + Math.floor(rnd() * 4);
    }
  }
  return g;
}

async function toPng(gray: Uint8Array, w: number, h: number): Promise<Buffer> {
  const { getSharp } = await import("../lib/optional-import");
  const sharp = await getSharp();
  return sharp(Buffer.from(gray), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

describe("dragArtifactScore", () => {
  it("reste au plancher sur une texture photo (aucune série dupliquée)", () => {
    const d = dragArtifactScore(photoish(320, 200), 320, 200);
    expect(Math.max(d.horizontal, d.vertical)).toBeLessThan(DRAG_MAX);
  });

  it("dépasse le seuil dès qu'on duplique des rangées", () => {
    const w = 320, h = 200;
    const d = dragArtifactScore(smear(photoish(w, h), w, h), w, h);
    expect(d.horizontal).toBeGreaterThan(DRAG_MAX);
  });

  it("voit aussi les traînées verticales (image pivotée)", () => {
    const w = 320, h = 200;
    const smeared = smear(photoish(w, h), w, h);
    // transposition : les traînées horizontales deviennent verticales
    const t = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[x * h + y] = smeared[y * w + x];
    const d = dragArtifactScore(t, h, w);
    expect(d.vertical).toBeGreaterThan(DRAG_MAX);
  });

  it("renvoie 0 sur une image trop petite pour être jugée", () => {
    const d = dragArtifactScore(new Uint8Array(8 * 8), 8, 8);
    expect(d).toEqual({ horizontal: 0, vertical: 0 });
  });

  it("ne se déclenche pas sur un aplat uni (série longue mais sans marche)", () => {
    const flat = new Uint8Array(200 * 200).fill(180);
    const d = dragArtifactScore(flat, 200, 200);
    expect(Math.max(d.horizontal, d.vertical)).toBe(0);
  });
});

describe("flatPaletteShare", () => {
  it("sépare une photo (histogramme étalé) d'un graphique (aplats)", () => {
    const photo = flatPaletteShare(photoish(320, 200));
    const graphic = flatPaletteShare(uiMock(320, 200));
    expect(photo).toBeLessThan(GRAPHIC_PALETTE_MAX);
    expect(graphic).toBeGreaterThan(GRAPHIC_PALETTE_MAX);
  });

  it("vaut 1 sur une image d'un seul niveau", () => {
    expect(flatPaletteShare(new Uint8Array(100).fill(12))).toBe(1);
  });
});

describe("inspectImageBuffer", () => {
  it("refuse un buffer vide", async () => {
    const r = await inspectImageBuffer(Buffer.alloc(0));
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("fatal");
    expect(r.reason).toContain("vide");
  });

  it("refuse des octets qui ne sont pas une image", async () => {
    const r = await inspectImageBuffer(Buffer.from("pas une image du tout"));
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("fatal");
  });

  it("accepte une image photographique propre", async () => {
    const w = 320, h = 200;
    const r = await inspectImageBuffer(await toPng(photoish(w, h), w, h));
    expect(r.severity).not.toBe("fatal");
    expect(r.paletteShare).toBeLessThan(GRAPHIC_PALETTE_MAX);
  });

  it("classe FATAL une photo aux rangées dupliquées", async () => {
    const w = 320, h = 200;
    const r = await inspectImageBuffer(await toPng(smear(photoish(w, h), w, h), w, h));
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("fatal");
    expect(r.reason).toContain("traînées");
    expect(r.dragH).toBeGreaterThan(DRAG_MAX);
  });

  it("classe FATAL un flux tronqué", async () => {
    const w = 320, h = 200;
    const png = await toPng(photoish(w, h), w, h);
    const r = await inspectImageBuffer(png.subarray(0, Math.floor(png.length * 0.9)));
    expect(r.severity).toBe("fatal");
    expect(r.truncated || r.reason?.includes("illisible")).toBeTruthy();
  });

  it("ne classe PAS fatal une maquette d'écran, même avec un score de traînées élevé", async () => {
    // Un graphique enchaîne par construction les séries identiques bordées de
    // marches : sans le garde-fou `flatPaletteShare`, toute maquette générée
    // serait jetée à tort.
    const w = 320, h = 200;
    const mock = uiMock(w, h);
    expect(dragArtifactScore(mock, w, h).vertical).toBeGreaterThan(DRAG_MAX);
    const r = await inspectImageBuffer(await toPng(mock, w, h));
    expect(r.severity).not.toBe("fatal");
  });
});
