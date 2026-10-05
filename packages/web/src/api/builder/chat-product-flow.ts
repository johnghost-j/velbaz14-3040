// ─── Flux « ajoute un produit » du chat : un VRAI produit Printify ───────────
// [2026-10-03] Le chat ne crée plus jamais un produit inventé :
//   1. demande détectée (product-intent.ts) ;
//   2. Printify connecté ? sinon on le dit et on demande la clé (pop-up secret) ;
//   3. type de produit RÉEL chez Printify (blueprint résolu dans le catalogue
//      live), jamais de substitut ;
//   4. design d'impression généré, produit créé sur Printify, MOCKUP RÉEL
//      Printify montré dans un pop-up d'aperçu ;
//   5. « Valider » → produit enregistré au catalogue (coût réel Printify,
//      prix cible) puis BRANCHÉ dans le site ; « Modifier » → l'ancien produit
//      Printify est supprimé et un nouveau est créé avec le retour.
//
// Les dépendances (Printify, base, génération d'image, SSE) sont injectées par
// index.ts : ce module reste testable sans réseau (chat-product-flow.test.ts).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { POD_TYPE_LABELS_FR, normalizePodProductType } from "../pod-guard";
import { printDesignPrompt, requestedDesignText, type PrintDesignPromptOptions } from "../print-design-prompt";
import { isGarmentType, soldObjectType } from "../product-prompt";
import type { PlacementStyle } from "../printify-artwork";
import { footwearDesignPlan, isFootwearPodType, type PrintDesignPlan } from "../shoe-design-prompt";
import { previewFeedback, previewReplyKind, splitPreviewFeedback, type ProductAddIntent } from "./product-intent";

export const CANDIDATE_TTL_MS = 30 * 60 * 1000;

/** Produit Printify créé, montré en aperçu, pas encore validé. */
export interface ProductCandidate {
  printifyProductId: string;
  title: string;
  description: string;
  /** Mockup RÉEL Printify (jamais une image IA). */
  imageUrl: string;
  blueprintId?: number;
  providerId?: number;
  priceCents?: number;
  costPrice?: number | null;
  margin?: number | null;
  variants?: Array<{ vid: number; label: string; price: number }>;
  podType: string;
  /** Demande d'origine (+ retours), pour régénérer sur « Modifier ». */
  request: string;
  concept: string;
  ts: number;
}

export interface CandidateStore {
  load(companyId: string): ProductCandidate | null;
  save(companyId: string, c: ProductCandidate): void;
  clear(companyId: string): void;
}

/** Un fichier JSON par entreprise (survit au rechargement à chaud du serveur). */
export function fileCandidateStore(dir: string): CandidateStore {
  const file = (id: string) => join(dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
  return {
    load(id) {
      try {
        const p = file(id);
        if (!existsSync(p)) return null;
        const data = JSON.parse(readFileSync(p, "utf-8"));
        return data?.printifyProductId && data?.imageUrl ? data : null;
      } catch { return null; }
    },
    save(id, c) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(file(id), JSON.stringify(c), "utf-8");
    },
    clear(id) {
      try { const p = file(id); if (existsSync(p)) unlinkSync(p); } catch { /* déjà absent */ }
    },
  };
}

type Mockup = Omit<ProductCandidate, "podType" | "request" | "concept" | "ts">;

export interface ProductFlowDeps<Cfg = unknown> {
  /** Config Printify qui RÉPOND (ping), sinon null. */
  workingPrintifyConfig(companyId: string): Promise<Cfg | null>;
  resolveBlueprint(cfg: Cfg, text: string, podType: string): Promise<number | null>;
  /** Image du design à imprimer (data URL), null si la génération échoue. */
  generateDesign(prompt: string, opts?: { aspectRatio?: string }): Promise<string | null>;
  /** Crée le produit sur Printify et renvoie son mockup réel, ou null (orphelin supprimé). */
  createMockup(cfg: Cfg, input: {
    title: string; description: string; designDataUrl: string; priceCents: number; blueprintId: number;
    /** Chaussure : motif all-over imprimé bord à bord, fond conservé. */
    placementStyle?: PlacementStyle; keepBackground?: boolean;
  }): Promise<Mockup | null>;
  deletePrintifyProducts(companyId: string, ids: string[]): Promise<void>;
  /** Insère le produit validé au catalogue (prix réel) ; renvoie son id et son prix final. */
  saveApprovedProduct(companyId: string, c: ProductCandidate): Promise<{ productId: string; retailPrice: number | null }>;
  /** Branche le catalogue dans le site (après les builds en cours). */
  syncSite(companyId: string): void;
  /** Débit des tokens d'une génération d'image. */
  chargeImage(): Promise<{ ok: boolean }>;
  palette(companyId: string): Promise<string>;
  store: CandidateStore;
  now?: () => number;
}

export interface ProductFlowIO {
  /** Étape visible (fil de progression). */
  step(msg: string): void;
  /** Réponse de l'assistant (affichée ET persistée). */
  reply(text: string): Promise<void>;
}

export interface ProductFlowContext {
  companyId: string;
  companyName: string;
  idea?: string;
  industry?: string;
  message: string;
  /** Intention détectée (null quand le message est une réponse à l'aperçu). */
  intent: ProductAddIntent | null;
}

export type ProductFlowOutcome =
  | "added" | "previewed" | "no_candidate" | "printify_missing" | "type_needed"
  | "not_printable" | "design_failed" | "printify_failed" | "no_tokens";

const label = (t: string) => POD_TYPE_LABELS_FR[t] || t;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const euros = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;

/** Composition du design selon l'objet (poitrine d'un vêtement, mug, affiche…). */
export function designKind(podType: string): PrintDesignPromptOptions["kind"] {
  if (isGarmentType(podType) || podType === "t-shirt" || podType === "hoodie") return "apparel";
  if (podType === "mug" || podType === "tumbler" || podType === "water bottle") return "mug";
  if (podType === "poster" || podType === "sticker" || podType === "puzzle") return "flat";
  return "accessory";
}

// [2026-10-04] Plus de pop-up « Connecter Printify » dans le chat : le client
// ne doit jamais voir le nom du fabricant ni être invité à brancher un token.
// La fabrication se configure côté admin (Admin Panel → clés de l'instance).

export function productPreviewPopup(c: Pick<ProductCandidate, "title" | "imageUrl">, message: string): string {
  return `[POPUP]${JSON.stringify({ type: "preview", title: c.title, message, imageUrl: c.imageUrl, confirmLabel: "Ajouter au site", cancelLabel: "Modifier" })}[/POPUP]`;
}

export async function runChatProductFlow<Cfg>(deps: ProductFlowDeps<Cfg>, io: ProductFlowIO, ctx: ProductFlowContext): Promise<ProductFlowOutcome> {
  const now = deps.now ?? Date.now;
  const kind = previewReplyKind(ctx.message);
  const pending = deps.store.load(ctx.companyId);

  // ── Validation : le produit montré part au catalogue PUIS dans le site ──
  if (kind === "approve") {
    if (!pending || now() - pending.ts > CANDIDATE_TTL_MS) {
      if (pending) { await deps.deletePrintifyProducts(ctx.companyId, [pending.printifyProductId]); deps.store.clear(ctx.companyId); }
      await io.reply(`Je n'ai plus de produit en attente (l'aperçu a expiré après 30 min, le brouillon a été supprimé). Redis-moi « ajoute un produit » et je t'en recrée un.`);
      return "no_candidate";
    }
    io.step(`💾 Ajout de « ${pending.title} » au catalogue…`);
    const saved = await deps.saveApprovedProduct(ctx.companyId, pending);
    deps.store.clear(ctx.companyId);
    deps.syncSite(ctx.companyId);
    io.step("🛒 Branchement du produit dans le site…");
    const price = saved.retailPrice != null && saved.retailPrice > 0 ? ` à ${euros(saved.retailPrice)}` : "";
    await io.reply(`✅ **${pending.title}** ajouté au catalogue${price} — vrai produit, fabriqué à la demande. Je le branche maintenant dans la boutique du site ; tu verras « Produits réels branchés au site » dans l'activité quand c'est en ligne.`);
    return "added";
  }

  // ── Requête (nouvelle, ou retour « Modifier » sur l'aperçu) ──
  let request = ctx.message.trim();
  let concept = ctx.intent?.concept || "";
  let podType = ctx.intent?.podType || null;
  if (kind === "modify") {
    const feedback = previewFeedback(ctx.message);
    request = pending ? `${pending.request}. Modifications demandées : ${feedback}` : feedback;
    // Le dessinateur ne reçoit que ce qui parle du DESSIN ; « mug classique
    // 11oz » sert au choix du modèle Printify (sinon il dessinait un mug).
    const { art, spec } = splitPreviewFeedback(feedback);
    concept = [pending?.concept, art].filter(Boolean).join(" — ");
    podType = normalizePodProductType(spec || feedback) || pending?.podType || null;
  }
  // L'ancien brouillon (remplacé, modifié ou abandonné) ne doit pas rester sur Printify.
  if (pending) {
    await deps.deletePrintifyProducts(ctx.companyId, [pending.printifyProductId]);
    deps.store.clear(ctx.companyId);
  }
  podType = podType || soldObjectType({ idea: ctx.idea, industry: ctx.industry });
  if (!podType) {
    const examples = ["t-shirt", "hoodie", "mug", "cap", "tote bag", "poster", "phone case", "shoe"].map(label).join(", ");
    await io.reply(`Quel produit veux-tu ajouter ? Dis-moi le type (par ex. ${examples}) et, si tu veux, ce qu'il faut imprimer dessus — « ajoute un sweat à capuche avec notre logo ». Je ne crée que de vrais produits que l'on peut fabriquer.`);
    return "type_needed";
  }

  const cfg = await deps.workingPrintifyConfig(ctx.companyId);
  if (!cfg) {
    await io.reply(`Je ne peux pas ajouter de vrai produit : la fabrication n'est pas disponible pour ce projet en ce moment. Je n'invente pas de produit à la place — redemande « ajoute un ${label(podType)} » dans quelques minutes.`);
    return "printify_missing";
  }

  // Le motif dans le titre : deux t-shirts différents ne portent pas le même nom.
  // Motif = le concept d'origine (pas les retours « — plus simple »).
  const motif = (concept.split(" — ")[0] || "").split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  const title = `${cap(label(podType))} ${ctx.companyName}${motif ? ` — ${cap(motif)}` : ""}`.trim().slice(0, 100);
  io.step(`🔎 Recherche d'un ${label(podType)} à fabriquer…`);
  const blueprintId = await deps.resolveBlueprint(cfg, `${request} ${podType}`, podType);
  if (!blueprintId) {
    await io.reply(`Aucun ${label(podType)} ne peut être fabriqué en ce moment — je n'ai rien créé (pas de produit de remplacement). Choisis un autre type de produit.`);
    return "not_printable";
  }

  const charge = await deps.chargeImage();
  if (!charge.ok) {
    await io.reply(`⚠️ Solde de tokens insuffisant pour générer le design du produit.`);
    return "no_tokens";
  }
  io.step("🎨 Création du design d'impression…");
  // [2026-10-04] Chaussure : vrai design all-over de l'empeigne (format large,
  // sans logo ni texte sauf demande explicite) — plus le prompt t-shirt qui
  // dessinait le nom de la marque, réduit ensuite à un petit logo.
  const shoe = isFootwearPodType(podType);
  const designConcept = concept || (shoe
    ? `${ctx.companyName} signature sneaker colorway${ctx.idea ? ` inspired by: ${ctx.idea.slice(0, 160)}` : ""}`
    : `${ctx.companyName} brand graphic${ctx.idea ? ` for: ${ctx.idea.slice(0, 160)}` : ""}`);
  // Pas de texte inventé : seulement celui demandé (guillemets, « écrit … »,
  // logo/nom), ou le nom de la marque quand aucun motif n'est donné (sauf
  // chaussure : jamais de nom imposé sur un motif).
  const designText = concept || shoe ? requestedDesignText(request, ctx.companyName) : (ctx.companyName || null);
  const palette = await deps.palette(ctx.companyId);
  const plan: PrintDesignPlan = shoe
    ? footwearDesignPlan({ concept: designConcept, productName: title, palette, text: designText })
    : { prompt: printDesignPrompt({ concept: designConcept, palette, kind: designKind(podType), text: designText }) };
  const designDataUrl = await deps.generateDesign(plan.prompt, plan.aspectRatio ? { aspectRatio: plan.aspectRatio } : undefined);
  if (!designDataUrl) {
    await io.reply(`⚠️ Le design n'a pas pu être généré — aucun produit créé. Réessaie (tu peux préciser le motif : « avec un loup minimaliste »).`);
    return "design_failed";
  }

  io.step(`🖨️ Création du ${label(podType)} et de sa vraie photo…`);
  // Description publique (affichée sur le site) : le motif d'origine, jamais
  // les retours internes (« — un mug classique 11oz, le loup plus simple »).
  const baseConcept = (concept.split(" — ")[0] || "").trim();
  const description = `${cap(label(podType))} ${ctx.companyName}${baseConcept ? ` — ${baseConcept}` : ""}`.slice(0, 300);
  const mockup = await deps.createMockup(cfg, {
    title, description, designDataUrl, priceCents: 2500, blueprintId,
    ...(plan.placementStyle ? { placementStyle: plan.placementStyle } : {}),
    ...(plan.keepBackground !== undefined ? { keepBackground: plan.keepBackground } : {}),
  });
  if (!mockup) {
    await io.reply(`⚠️ La création du ${label(podType)} n'a pas abouti (pas de photo du produit) — rien n'a été ajouté (le brouillon a été supprimé). Réessaie dans un instant.`);
    return "printify_failed";
  }
  const candidate: ProductCandidate = { ...mockup, podType, request, concept, ts: now() };
  deps.store.save(ctx.companyId, candidate);

  const priceTxt = mockup.priceCents ? ` Prix de vente (coût de fabrication réel + livraison + prix du marché), celui qui sera affiché sur le site : ${euros(mockup.priceCents / 100)}${mockup.costPrice ? ` (coût ${euros(mockup.costPrice)})` : ""}.` : "";
  const intro = `Voici le vrai produit créé — c'est sa vraie photo.${priceTxt} Valide et je l'ajoute au site, ou dis-moi quoi changer.`;
  io.step("✅ Photo du produit prête — regarde l'aperçu.");
  await io.reply(`${intro}\n${productPreviewPopup(candidate, intro)}`);
  return "previewed";
}
