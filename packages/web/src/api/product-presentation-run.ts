// ─── Branchement réel de product-presentation.ts ─────────────────────────────
// Fournit les dépendances concrètes (Printify, téléchargement, génération,
// garde de solde) et publie le résultat dans l'activité du projet.
// La génération et la facturation vivent dans index.ts (non exportées) : elles
// sont passées en paramètre pour éviter une dépendance circulaire.

import { v4 as uuidv4 } from "uuid";
import { db } from "./database/index";
import * as schema from "./database/schema";
import * as printify from "./printify";
import { resolvePrintifyConfig } from "./printify-config";
import {
  presentCompanyProducts, presentationSummary,
  type ImageData, type PresentationDeps, type PresentationResult,
} from "./product-presentation";

/** Les CDN d'images Printify renvoient 403 sans User-Agent de navigateur. */
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REF_BYTES = 12 * 1024 * 1024;

/** data:<mime>;base64,<data> → ImageData (null si ce n'est pas une image base64). Pur. */
export function parseImageDataUri(src: string): ImageData | null {
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(src);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/** Téléchargement d'une image de référence (URL http(s) ou data-URI). */
export async function downloadImage(src: string, fetchImpl: typeof fetch = fetch): Promise<ImageData | null> {
  if (src.startsWith("data:")) return parseImageDataUri(src);
  if (!/^https?:\/\//.test(src)) {
    console.error("[product-presentation] source d'image non téléchargeable:", src.slice(0, 80));
    return null;
  }
  try {
    const res = await fetchImpl(src, {
      headers: { "User-Agent": BROWSER_UA, Accept: "image/avif,image/webp,image/png,image/jpeg,image/*" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[product-presentation] téléchargement", res.status, src.slice(0, 120));
      return null;
    }
    const mimeType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!mimeType.startsWith("image/")) {
      console.error("[product-presentation] pas une image:", mimeType, src.slice(0, 120));
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_REF_BYTES) {
      console.error("[product-presentation] taille d'image refusée:", buf.length, src.slice(0, 120));
      return null;
    }
    return { mimeType, data: buf.toString("base64") };
  } catch (e) {
    console.error("[product-presentation] téléchargement échoué", src.slice(0, 120), e);
    return null;
  }
}

export interface PresentationRunOptions {
  generate: (prompt: string, refs: ImageData[], opts: { aspectRatio: string }) => Promise<ImageData | null>;
  /** Garde de solde du propriétaire du projet. */
  charge: () => Promise<{ ok: boolean }>;
  only?: string[];
}

/** Dépendances réelles pour un projet. */
export async function presentationDepsFor(companyId: string, o: PresentationRunOptions): Promise<PresentationDeps> {
  const resolved = await resolvePrintifyConfig(companyId);
  let shopId: string | null = null;
  return {
    async printifyImages(printifyProductId) {
      if (!resolved) return [];
      try {
        shopId = shopId || (await printify.resolveShopId(resolved));
        if (!shopId) return [];
        const res = await printify.getProduct({ ...resolved, shopId }, printifyProductId);
        if (!res.ok) {
          console.error("[product-presentation] Printify getProduct", printifyProductId, res.status, res.message || res.error);
          return [];
        }
        return ((res.data as any)?.images || []) as any[];
      } catch (e) {
        console.error("[product-presentation] Printify getProduct", printifyProductId, e);
        return [];
      }
    },
    download: (src) => downloadImage(src),
    generate: o.generate,
    charge: o.charge,
  };
}

/**
 * Génère les photos de présentation manquantes d'un projet et annonce le
 * résultat dans l'activité. Ne lève jamais.
 */
export async function presentProductsAndReport(companyId: string, o: PresentationRunOptions): Promise<PresentationResult[]> {
  const { runWithAiContext } = await import("./ai-usage/context");
  return runWithAiContext({ feature: "design", label: "product-presentation", companyId }, async () => {
    try {
      const deps = await presentationDepsFor(companyId, o);
      const results = await presentCompanyProducts(deps, companyId, { only: o.only });
      const msg = presentationSummary(results);
      if (msg) {
        const failed = results.some((r) => r.failed || r.skipped === "no_tokens");
        await db.insert(schema.agentActivity).values({
          id: uuidv4(), companyId, agentRole: "design", action: failed && !results.some((r) => r.generated) ? "error" : "completed", message: msg,
        });
      }
      return results;
    } catch (e) {
      console.error("[product-presentation] projet", companyId, e);
      return [];
    }
  });
}
