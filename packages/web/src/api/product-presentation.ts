// ─── Présentation professionnelle des produits (vitrine du site) ─────────────
// [2026-10-04] Demande : « quand ça fait le produit dans le site, le produit
// est mieux présenté — l'IA prend toutes les images de visualisation du
// produit et génère 1 ou plusieurs images du produit présentées
// professionnellement ».
//
// Avant : le site recevait UNE image par produit, le mockup Printify par
// défaut (produit sur fond blanc, cadrage technique) — et seulement celle-là.
//
// Maintenant, pour chaque produit vendable du catalogue :
//   1. on rassemble TOUTES ses vues réelles : les mockups Printify du produit
//      (une vue par angle pour le coloris par défaut) + les photos déjà
//      stockées (mockup, fournisseur, visuels du visualiseur produit) ;
//   2. les vues Printify manquantes sont enregistrées (type `printify`) : elles
//      alimentent la galerie de la fiche produit ;
//   3. ces vues servent de RÉFÉRENCES au modèle image, qui rend des photos de
//      présentation pro (packshot studio, mise en situation) du MÊME produit ;
//   4. ces photos (type `presentation`) passent en tête de vitrine
//      (product-photo.ts), les vues réelles suivent dans la galerie.
//
// Idempotent : chaque photo porte la source dont elle est issue (produit
// Printify) ; tant que le produit ne change pas, rien n'est régénéré. Un
// produit reconstruit (nouveau produit Printify) voit ses anciennes photos
// remplacées.

import { and, eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "./database/index";
import * as schema from "./database/schema";
import { NON_PHOTO_IMAGE_TYPES, PRESENTATION_IMAGE_TYPES } from "./product-photo";

export const PRESENTATION_TYPE = "presentation";

export interface PresentationShot {
  key: "hero" | "lifestyle";
  sortOrder: number;
  aspectRatio: string;
}

/** Photos rendues par produit, dans l'ordre de vitrine. */
export const PRESENTATION_SHOTS: PresentationShot[] = [
  { key: "hero", sortOrder: -20, aspectRatio: "1:1" },
  { key: "lifestyle", sortOrder: -10, aspectRatio: "4:5" },
];

/** Nombre max d'images de référence envoyées au modèle. */
export const MAX_REFERENCE_VIEWS = 5;

export interface ImageData { data: string; mimeType: string }

export interface PresentationDeps {
  /** Images Printify du produit (toutes vues). Ne lève pas : journalise et renvoie []. */
  printifyImages(printifyProductId: string): Promise<any[]>;
  /** Télécharge une image (URL http ou data-URI) → base64. Ne lève pas : journalise et renvoie null. */
  download(src: string): Promise<ImageData | null>;
  /** Génération image avec références. */
  generate(prompt: string, refs: ImageData[], opts: { aspectRatio: string }): Promise<ImageData | null>;
  /** Garde de solde avant chaque image (le coût réel est post-payé). */
  charge(): Promise<{ ok: boolean }>;
}

export interface PresentationProduct {
  id: string;
  name: string;
  description: string | null;
  printifyProductId: string | null;
}

export interface PresentationResult {
  productId: string;
  generated: number;
  views: number;
  skipped?: "up_to_date" | "no_views" | "no_tokens";
  failed?: number;
}

/**
 * Vues Printify à retenir : le coloris de l'image par défaut, une image par
 * angle (camera_label / position), image par défaut en tête. Pur → testable.
 */
export function pickPrintifyViews(images: any[], max = 8): string[] {
  const list = (Array.isArray(images) ? images : []).filter((i) => typeof i?.src === "string" && /^https?:\/\//.test(i.src));
  if (!list.length) return [];
  const def = list.find((i) => i.is_default) || list.find((i) => i.is_selected_for_publishing) || list[0];
  const vid = Array.isArray(def.variant_ids) && def.variant_ids.length ? def.variant_ids[0] : null;
  const sameColor = vid == null ? list : list.filter((i) => Array.isArray(i.variant_ids) && i.variant_ids.includes(vid));
  const angleOf = (i: any): string => {
    const m = String(i.src).match(/[?&]camera_label=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : String(i.position || i.src);
  };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of [def, ...sameColor.filter((x) => x !== def)]) {
    const a = angleOf(i);
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(String(i.src));
    if (out.length >= max) break;
  }
  return out;
}

/** Clé de source : une photo de présentation n'est valable que pour CE produit. */
export function presentationSourceKey(p: Pick<PresentationProduct, "id" | "printifyProductId">): string {
  return p.printifyProductId ? `printify:${p.printifyProductId}` : `local:${p.id}`;
}

const tagFor = (source: string, shot: string) => `[presentation ${source} ${shot}]`;

/** La photo stockée correspond-elle à cette source et à ce plan ? */
export function isCurrentPresentation(prompt: string | null | undefined, source: string, shot: string): boolean {
  return String(prompt || "").startsWith(tagFor(source, shot));
}

const VIEW_PREFIX = "Vue Printify réelle (";
/** Légende d'une vue Printify enregistrée par ce module. */
export function printifyViewPrompt(source: string): string {
  return `${VIEW_PREFIX}${source})`;
}
/** Ligne de vue Printify créée par ce module (pour `source` si précisée). */
export function isPrintifyViewRow(prompt: string | null | undefined, source?: string): boolean {
  const s = String(prompt || "");
  return source ? s === printifyViewPrompt(source) : s.startsWith(VIEW_PREFIX);
}

/** Prompt d'une photo de présentation, construite à partir des vues réelles. */
export function presentationPrompt(shot: PresentationShot["key"], p: { name: string; description?: string | null }): string {
  const desc = String(p.description || "").replace(/\s+/g, " ").trim().slice(0, 220);
  const fidelity =
    `The reference images show ONE real manufactured product ("${p.name}"${desc ? ` — ${desc}` : ""}) from several angles. ` +
    `Reproduce EXACTLY this product: identical shape, proportions, printed design, artwork placement, colors, materials and details. ` +
    `Do NOT redesign it, do NOT add or remove any logo, text or graphic, do NOT change its color.`;
  const forbid = `No text overlay, no watermark, no price tag, no collage, no split screen, no multiple variants — one single photograph.`;
  if (shot === "lifestyle") {
    return [
      `Professional lifestyle campaign photograph of this product for a premium online store.`,
      fidelity,
      `Show it in an authentic, aspirational real-world setting that suits it: clothing is worn by a model with the camera framed so the product dominates; footwear is shown worn or placed at ground level, close-up; objects are styled in a fitting interior or outdoor scene.`,
      `Natural directional light, shallow depth of field, the product razor-sharp and the clear hero of the image, editorial magazine quality.`,
      forbid,
    ].join(" ");
  }
  return [
    `Professional e-commerce hero packshot of this product for a premium online store.`,
    fidelity,
    `Three-quarter angle that shows the design best, product centered and filling about 70% of the frame, on a seamless studio backdrop in a soft tone that complements the product colors.`,
    `Soft key light with a gentle rim light, realistic contact shadow, true-to-life materials, razor-sharp detail, high-end catalog look. No person.`,
    forbid,
  ].join(" ");
}

/** Produits vendus sur le site (même règle que le catalogue : actifs, prix > 0, Printify ou dropshipping). */
async function sellableProducts(companyId: string, only?: string[]): Promise<PresentationProduct[]> {
  const rows = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), eq(schema.products.status, "active")))
    .limit(30);
  return rows
    .filter((p) => !only || only.includes(p.id))
    .filter((p) => {
      if (p.retailPrice == null || p.retailPrice <= 0) return false;
      let tags: string[] = [];
      try { tags = JSON.parse(p.tags || "[]"); } catch { /* tags libres */ }
      return !!p.printifyProductId || tags.includes("dropshipping");
    })
    .map((p) => ({ id: p.id, name: p.name, description: p.description, printifyProductId: p.printifyProductId }));
}

/** Présentation d'UN produit : vues réelles → galerie + photos pro. */
export async function presentProduct(deps: PresentationDeps, companyId: string, p: PresentationProduct): Promise<PresentationResult> {
  const source = presentationSourceKey(p);
  const imgs = await db.select().from(schema.productImages)
    .where(and(eq(schema.productImages.productId, p.id), eq(schema.productImages.companyId, companyId)));

  // 1) Photos de présentation périmées (produit reconstruit) → supprimées.
  const presentation = imgs.filter((i) => PRESENTATION_IMAGE_TYPES.has(i.type));
  const stale = presentation.filter((i) => !PRESENTATION_SHOTS.some((s) => isCurrentPresentation(i.prompt, source, s.key)));
  if (stale.length) {
    await db.delete(schema.productImages).where(inArray(schema.productImages.id, stale.map((i) => i.id)));
  }
  const todo = PRESENTATION_SHOTS.filter((s) => !presentation.some((i) => isCurrentPresentation(i.prompt, source, s.key)));
  // Vues Printify enregistrées ici pour un ANCIEN produit Printify → supprimées
  // (sinon la galerie mélangerait l'ancien et le nouveau design).
  const staleViews = imgs.filter((i) => i.type === "printify" && isPrintifyViewRow(i.prompt) && !isPrintifyViewRow(i.prompt, source));
  if (staleViews.length) {
    await db.delete(schema.productImages).where(inArray(schema.productImages.id, staleViews.map((i) => i.id)));
  }
  const live = imgs.filter((i) => !staleViews.includes(i));

  // 2) Toutes les vues réelles : Printify (enregistrées pour la galerie) + stockées.
  const stored = live
    .filter((i) => !!i.imageData && !NON_PHOTO_IMAGE_TYPES.has(i.type) && !PRESENTATION_IMAGE_TYPES.has(i.type))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const known = new Set(stored.map((i) => i.imageData!));
  let printifyViews: string[] = [];
  if (p.printifyProductId) {
    printifyViews = pickPrintifyViews(await deps.printifyImages(p.printifyProductId));
    let order = 1;
    for (const src of printifyViews) {
      if (known.has(src)) continue;
      known.add(src);
      await db.insert(schema.productImages).values({
        id: uuidv4(), productId: p.id, companyId, type: "printify", imageData: src, status: "active",
        sortOrder: order++, prompt: printifyViewPrompt(source),
      });
    }
  }
  const views = [...printifyViews, ...stored.map((i) => i.imageData!).filter((v) => !printifyViews.includes(v))];
  if (!todo.length) return { productId: p.id, generated: 0, views: views.length, skipped: "up_to_date" };
  if (!views.length) return { productId: p.id, generated: 0, views: 0, skipped: "no_views" };

  const refs: ImageData[] = [];
  for (const v of views.slice(0, MAX_REFERENCE_VIEWS)) {
    const d = await deps.download(v);
    if (d) refs.push(d);
  }
  if (!refs.length) return { productId: p.id, generated: 0, views: views.length, skipped: "no_views" };

  // 3) Photos pro, une par plan manquant.
  // Garde de solde AVANT chaque plan (séquentielle), puis rendus en parallèle.
  const allowed: PresentationShot[] = [];
  for (const shot of todo) {
    if (!(await deps.charge()).ok) break;
    allowed.push(shot);
  }
  if (!allowed.length) return { productId: p.id, generated: 0, views: views.length, skipped: "no_tokens" };
  const rendered = await Promise.all(allowed.map(async (shot) => {
    const prompt = presentationPrompt(shot.key, p);
    const img = await deps.generate(prompt, refs, { aspectRatio: shot.aspectRatio });
    return { shot, prompt, img };
  }));
  let generated = 0, failed = 0;
  for (const { shot, prompt, img } of rendered) {
    if (!img) { failed++; continue; }
    await db.insert(schema.productImages).values({
      id: uuidv4(), productId: p.id, companyId, type: PRESENTATION_TYPE,
      imageData: `data:${img.mimeType};base64,${img.data}`, status: "active",
      sortOrder: shot.sortOrder, prompt: `${tagFor(source, shot.key)} ${prompt}`,
    });
    generated++;
  }
  return {
    productId: p.id, generated, views: views.length,
    ...(failed ? { failed } : {}),
    ...(allowed.length < todo.length ? { skipped: "no_tokens" as const } : {}),
  };
}

/**
 * Présente tous les produits vendables d'un projet (ou seulement `only`).
 * Ne lève jamais ; renvoie le détail par produit.
 */
export async function presentCompanyProducts(
  deps: PresentationDeps,
  companyId: string,
  opts: { only?: string[]; parallel?: number } = {},
): Promise<PresentationResult[]> {
  let products: PresentationProduct[];
  try { products = await sellableProducts(companyId, opts.only); } catch (e) {
    console.error("[product-presentation] lecture produits", companyId, e);
    return [];
  }
  const out: PresentationResult[] = [];
  const parallel = Math.max(1, opts.parallel ?? 2);
  for (let i = 0; i < products.length; i += parallel) {
    const batch = products.slice(i, i + parallel);
    const res = await Promise.all(batch.map((p) => presentProduct(deps, companyId, p).catch((e) => {
      console.error("[product-presentation]", p.id, e);
      return { productId: p.id, generated: 0, views: 0, failed: PRESENTATION_SHOTS.length } as PresentationResult;
    })));
    out.push(...res);
  }
  return out;
}

/** Message d'activité (null quand rien n'a été fait). */
export function presentationSummary(results: PresentationResult[]): string | null {
  const gen = results.reduce((n, r) => n + r.generated, 0);
  const failed = results.reduce((n, r) => n + (r.failed || 0), 0);
  const noTokens = results.some((r) => r.skipped === "no_tokens");
  if (!gen && !failed && !noTokens) return null;
  const parts: string[] = [];
  if (gen) parts.push(`📸 ${gen} photo(s) de présentation pro générée(s) à partir des vues réelles des produits`);
  if (failed) parts.push(`⚠️ ${failed} photo(s) de présentation n'ont pas pu être générées (le mockup réel reste affiché)`);
  if (noTokens) parts.push(`⚠️ Solde insuffisant : photos de présentation non générées pour certains produits`);
  return parts.join(" — ");
}
