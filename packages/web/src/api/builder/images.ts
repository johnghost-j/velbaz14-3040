// ─── Content image generation for generated sites & apps ─────────────────────
// The build already produces a brand logo. This module produces the CONTENT
// imagery a page actually needs (hero, section illustrations, gallery, about,
// backgrounds…). An LLM "art director" decides how many visuals each page needs
// (NO fixed cap), we generate them via Gemini image, compress to WebP with sharp
// to keep the data URIs light, and expose them as a data-URI manifest that is
// written into the generated app as `src/lib/images.ts` (web) or an equivalent
// mobile constants file. Because that manifest is a plain project file, it is
// already covered by the checkpoint snapshot / rollback / fork machinery.
import { generateText } from "ai";
import { getSharp } from '../lib/optional-import';
import { gateway, IMAGE_MODEL } from "../agent/gateway";
import { inspectImageBuffer } from "./image-quality";
import { CHIMERA_ASSETS_ORIGIN } from "../chimera-assets";
import { productRefPrompt, productsArtDirectorBlock } from "./brand-products";

export type ImageAspect = "wide" | "square" | "portrait" | "tall";

export interface ImageSlot {
  key: string;        // stable identifier used in code, ex: "home_hero"
  page: string;       // page file this visual belongs to, ex: "Home.tsx"
  prompt: string;     // description of the image to generate
  aspect: ImageAspect;
  role: string;       // hero | feature | gallery | about | background | avatar | banner
  alt: string;        // accessible description (in the app language)
  /** Index du produit RÉEL de la marque montré par ce visuel (cf. brand-products). */
  product?: number;
}

export interface ImageManifest {
  // key -> data URI (data:image/webp;base64,…)
  urls: Record<string, string>;
  // key -> metadata so PAGE_PROMPT can tell the model what each visual is for
  meta: Record<string, { alt: string; role: string; page: string; product?: string }>;
}

/**
 * Produit réel à reproduire pour un visuel : sa photo sert de référence au
 * modèle d'image, et de visuel de repli si la génération échoue.
 */
export interface ProductImageRef {
  name: string;
  description?: string | null;
  /** Image de référence passée au modèle (data URI ou URL). */
  refImage: string;
  /** Photo réelle publiable telle quelle (repli). */
  photoUrl: string | null;
}

const ASPECT_HINT: Record<ImageAspect, string> = {
  wide: "wide 16:9 landscape composition",
  square: "square 1:1 composition",
  portrait: "portrait 4:5 composition",
  tall: "tall 9:16 vertical composition",
};

// Target width (px) per role — keeps the base64 payload reasonable even with
// many images. Heroes/banners stay crisp; avatars/thumbs are small.
function widthForRole(role: string): number {
  const r = role.toLowerCase();
  if (r.includes("avatar") || r.includes("thumb") || r.includes("icon")) return 400;
  if (r.includes("feature") || r.includes("gallery") || r.includes("about") || r.includes("card")) return 1000;
  return 1600; // hero, banner, background, default
}

function extractJSON(raw: string): any {
  let s = raw.trim();
  if (s.startsWith("```")) s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

// ── Qualité de sortie ───────────────────────────────────────────────────────
// [2026-09-25] La qualité WebP était à 80. Sur une sortie de modèle qui est
// DÉJÀ un JPEG compressé, ce second passage rabote les textures fines (cuir,
// bois, grain) : mesuré 46-55 Ko par image contre 65-75 Ko à 85, pour un
// manifeste de taille comparable à l'existant. `smartSubsample` évite les
// bavures de chrominance sur les aplats colorés, `lanczos3` garde le piqué au
// redimensionnement.
const WEBP_QUALITY = 85;
/** Nombre total de tentatives quand le modèle renvoie une image abîmée. */
const MAX_IMAGE_ATTEMPTS = 3;

// ── Profils d'encodage ──────────────────────────────────────────────────────
// [2026-09-25 — 4e passe] Le contrôle qualité porte désormais sur les octets
// RÉELLEMENT publiés (cf. `generateContentImage`). Quand le profil normal
// abîme une image dont la sortie brute était saine, c'est NOTRE encodeur le
// fautif, pas le modèle : on ré-encode alors en « secours » avant de dépenser
// une nouvelle génération. Mesuré sur 12 sorties réelles du modèle, le secours
// ne paie QUE sur les images déjà limites — exactement les seules où il tourne :
//   pire échantillon (traînées 0,85 % en q85) → 0,44 % en q96 sans sous-échant.
//   échantillons propres (0,07 … 0,50 %)      → légèrement PLUS haut, et 2× plus
//                                               lourds ⇒ jamais utilisé sur eux
// Le quasi-sans-perte a été essayé et écarté par mesure : aucun gain (0,66 …
// 1,24 %) pour 3 à 5× la taille. Le secours ne s'exécute qu'après un rejet,
// donc la taille des manifestes sains ne change pas d'un octet.
export type EncodeProfile = { label: string; options: Record<string, unknown> };
export const ENCODE_PROFILES: EncodeProfile[] = [
  { label: "q85", options: { quality: WEBP_QUALITY, effort: 4, smartSubsample: true } },
  { label: "secours q96", options: { quality: 96, effort: 6, smartSubsample: false } },
];

/**
 * Redimensionne + encode en WebP — l'opération qui produit les octets publiés.
 * Exportée pour que le contrôle qualité puisse être éprouvé sur EXACTEMENT ce
 * que le site reçoit, et non sur la sortie brute du modèle.
 */
export async function encodeWebpForManifest(
  input: Buffer,
  maxWidth: number,
  profile: EncodeProfile = ENCODE_PROFILES[0],
): Promise<Buffer> {
  const sharp = await getSharp();
  // `failOn: "truncated"` et non "none" : vérifié, sharp ré-encode SANS erreur
  // un JPEG coupé en plein milieu et produit un WebP valide plein de traînées.
  return sharp(input, { failOn: "truncated" })
    .resize({ width: maxWidth, withoutEnlargement: true, kernel: "lanczos3" })
    .webp(profile.options as any)
    .toBuffer();
}

// Generate ONE image and return a compressed WebP data URI (or null on failure —
// never throws, so a failed visual just drops out of the manifest).
//
// [2026-09-25] Ajout d'un CONTRÔLE QUALITÉ + relance. Avant, tout ce que le
// modèle renvoyait était ré-encodé tel quel : une réponse abîmée (flux tronqué,
// image massacrée par la compression) produisait un WebP parfaitement valide
// rempli de bouillie, inliné dans le site sans un mot dans les logs. On inspecte
// donc chaque tentative (`inspectImageBuffer`) et on relance jusqu'à
// MAX_IMAGE_ATTEMPTS.
//
// [2026-09-25 — 2e passe] « toujours le même problème : les images générées
// sont buguées ». Le contrôle ci-dessus DÉTECTAIT bien l'image signalée par
// l'utilisateur (vérifié : `ok:false`) mais cette fonction la publiait quand
// même : elle gardait « la moins mauvaise » tentative au score d'artefacts de
// bloc, sans regarder POURQUOI elle avait été rejetée. Deux défauts :
//   1. une image rejetée finissait TOUJOURS dans le site si les 3 tentatives
//      échouaient — un visuel visiblement cassé valait mieux qu'un trou ;
//   2. le classement était INVERSÉ pour ce défaut-là : une image traînée/tronquée
//      a un score de bloc BAS (~1,1, mesuré), plus bas qu'une photo propre mais
//      douce (~1,8). « La moins mauvaise » choisissait donc l'image cassée.
// Désormais : on ne publie JAMAIS une image `fatal` (illisible, flux tronqué,
// traînées) — on préfère laisser tomber le visuel, ce que le manifeste sait
// déjà gérer. Seules les `suspect` (score de bloc élevé, faux positif dans
// ~14 % des cas) servent de repli, la plus basse d'abord.
//
// [2026-09-25 — 4e passe] « les images générées sont toujours buguées ».
// CAUSE RÉELLE, cette fois mesurée de bout en bout : les trois passes
// précédentes contrôlaient la sortie BRUTE du modèle, alors que ce qui part
// dans le site est le WebP REDIMENSIONNÉ ET RÉ-ENCODÉ — jamais inspecté. Le
// verdict ne portait donc pas sur les octets livrés.
//
// Constaté sur un projet construit APRÈS les 3 correctifs (SkyLift, 16 visuels,
// journal de build : 16/16 « généré », 0 rejet, une seule tentative chacun —
// donc les 16 sorties brutes ont été jugées `ok`) :
//
//   les 16 images RÉELLEMENT présentes dans `src/lib/images.ts`
//   repassées au même contrôle  → 16/16 REJETÉES (7 `fatal`, 9 `suspect`)
//   score de bloc 1,58 … 2,00 · traînées 0,67 … 4,16 %
//
// Ce n'est pas une divergence de mesure mais une AMPLIFICATION : sur 12
// générations neuves tracées brut → encodé, le score de traînées est multiplié
// par 1,5 à 3,5 par le redimensionnement + l'encodage avec perte
// (0,15 → 0,52 · 0,34 → 0,86 · 0,69 → 1,21). Une sortie brute à 1,2 (donc
// `ok`, sous le seuil de 1,6) ressort ainsi à 2 … 4 dans le site : exactement
// les valeurs relevées ci-dessus. Le double/triple ré-encodage, lui, a été
// écarté par mesure (3 passes successives : score stable à ±0,1).
//
// Le contrôle est donc déplacé APRÈS l'encodage, sur le buffer publié. Et comme
// l'encodage est parfois le seul fautif, un profil de secours (q96 sans
// sous-échantillonnage) est réessayé sur la même image avant de payer une
// nouvelle génération.
export async function generateContentImage(
  prompt: string,
  aspect: ImageAspect = "wide",
  maxWidth = 1600,
  opts: {
    /** Images de référence (data URI ou base64) données au modèle comme ancre visuelle. */
    refImages?: string[];
    /** Laisse passer le texte : indispensable pour une maquette d'écran. */
    allowText?: boolean;
  } = {},
): Promise<string | null> {
  const fullPrompt =
    `${prompt}. ${ASPECT_HINT[aspect]}. High-quality, photorealistic where appropriate or clean modern illustration, ` +
    `professional, cohesive lighting and color grading.` +
    (opts.allowText ? "" : " NO text, NO watermark, NO logo, NO UI chrome, no borders.");
  const refs = (opts.refImages ?? []).filter(Boolean);

  // Repli éventuel : un WebP DÉJÀ ENCODÉ (donc exactement ce qui serait publié)
  // jugé `suspect`. Jamais un `fatal`.
  let best: { webp: Buffer; score: number } | null = null;

  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model: gateway(IMAGE_MODEL),
        ...(refs.length
          ? {
              messages: [{
                role: "user" as const,
                content: [
                  { type: "text" as const, text: `Generate an image: ${fullPrompt}` },
                  ...refs.map(image => ({ type: "image" as const, image })),
                ],
              }],
            }
          : { prompt: `Generate an image: ${fullPrompt}` }),
        providerOptions: { gateway: { response_modalities: ["IMAGE"] } },
      } as any);
      const file = result.files?.[0];
      if (!file?.base64) {
        console.error(`[generateContentImage] no image in response (essai ${attempt}/${MAX_IMAGE_ATTEMPTS})`);
        continue;
      }
      const input = Buffer.from(file.base64, "base64");
      // 1) Garde sur la sortie brute : un flux tronqué / illisible ne mérite
      //    même pas d'être encodé, on relance tout de suite.
      const raw = await inspectImageBuffer(input);
      if (raw.severity === "fatal") {
        console.error(
          `[generateContentImage] sortie brute rejetée (essai ${attempt}/${MAX_IMAGE_ATTEMPTS}, fatal) : ` +
          `${raw.reason} [${raw.format} ${raw.width}x${raw.height}]`,
        );
        continue;
      }
      // 2) Garde sur les octets RÉELLEMENT PUBLIÉS : c'est le redimensionnement
      //    + l'encodage avec perte qui font basculer une image saine (mesuré
      //    ×1,5 à ×3,5 sur le score de traînées). On encode, on inspecte le
      //    résultat, et on tente le profil de secours si besoin.
      let published: { webp: Buffer; score: number } | null = null;
      for (const profile of ENCODE_PROFILES) {
        let webp: Buffer;
        try {
          webp = await encodeWebpForManifest(input, maxWidth, profile);
        } catch (e) {
          console.error(`[generateContentImage] encodage WebP (${profile.label}) échoué:`, e);
          continue;
        }
        const check = await inspectImageBuffer(webp);
        if (check.ok) {
          published = { webp, score: check.score };
          break;
        }
        console.error(
          `[generateContentImage] image publiable rejetée (essai ${attempt}/${MAX_IMAGE_ATTEMPTS}, ` +
          `encodage ${profile.label}, ${check.severity}) : ${check.reason} ` +
          `[${check.format} ${check.width}x${check.height}, brut ${raw.score.toFixed(2)}/${raw.dragH.toFixed(2)}%]`,
        );
        // Une image `fatal` (traînées / flux tronqué / illisible) n'est JAMAIS
        // gardée : on laisse tomber le visuel plutôt que de publier de la bouillie.
        if (check.severity === "fatal") continue;
        // Repli uniquement sur les `suspect`, la moins mauvaise d'abord.
        if (!best || check.score < best.score) best = { webp, score: check.score };
      }
      if (published) {
        best = published;
        break;
      }
    } catch (e) {
      console.error(`[generateContentImage] essai ${attempt}/${MAX_IMAGE_ATTEMPTS} échoué:`, e);
    }
  }

  if (!best) {
    console.error(`[generateContentImage] visuel abandonné après ${MAX_IMAGE_ATTEMPTS} essai(s) — aucune image publiable`);
    return null;
  }
  return `data:image/webp;base64,${best.webp.toString("base64")}`;
}

// ── Art director: decide which visuals each page needs (NO fixed cap) ──
export interface PlanImagesInput {
  companyName: string;
  idea: string;
  industry?: string;
  lang: string;
  design: any;
  pages: Array<{ name: string; file: string; purpose?: string; sections?: string; route?: string }>;
  /** Produits RÉELS de la marque (avec photo) : les visuels produit les montrent. */
  products?: Array<{ name: string; description?: string | null; imageUrl: string | null }>;
}

const ART_DIRECTOR_SYSTEM =
  "Tu es directeur artistique. Tu décides des VISUELS (photos/illustrations) dont chaque page d'un site ou d'une app a besoin " +
  "pour être belle et crédible. Tu réponds UNIQUEMENT en JSON valide.";

export async function planImageSlots(input: PlanImagesInput): Promise<ImageSlot[]> {
  const palette = input.design?.colors
    ? Object.entries(input.design.colors).map(([k, v]) => `${k}:${v}`).join(", ")
    : "";
  const pagesBlock = input.pages
    .map((p) => `- ${p.file} — "${p.name}" (${p.route || ""}) · but: ${p.purpose || ""} · sections: ${p.sections || ""}`)
    .join("\n");
  const prompt =
`Entreprise: "${input.companyName}"
Idée: ${input.idea}
Secteur: ${input.industry || "non précisé"}
Palette du design: ${palette}
Langue de l'app (pour les textes ALT): ${input.lang}

Pages du projet:
${pagesBlock}
${input.products?.length ? productsArtDirectorBlock(input.products.map((p, i) => ({ id: String(i), ...p }))) : ""}
Décide des VISUELS générés à afficher sur ces pages. Règles:
- Propose autant de visuels que le design en a réellement besoin — AUCUNE limite fixe. Les pages "à propos", galerie, produits, services méritent plusieurs photos de CONTENU. Une page purement CRUD/dashboard n'en a souvent pas besoin.
- INTERDICTION ABSOLUE de fonds en image : ne propose JAMAIS de fond plein écran, de texture, de motif répété, d'image d'ambiance derrière du texte, de fond de héro, de fond de bannière ou de fond de section. Ces fonds seront faits en CSS (dégradés / couleurs de la palette), PAS en image. Les rôles "background", "texture", "overlay" sont INTERDITS.
- Un visuel est donc TOUJOURS une image de CONTENU encadrée : une photo de section, une vignette de galerie, un portrait d'équipe, une photo produit, une illustration dans une carte. Jamais une image posée derrière du texte.
- Un héro peut avoir une photo, mais uniquement comme élément encadré À CÔTÉ du texte (moitié d'écran, carte, mockup), jamais en fond derrière le texte.
- N'invente pas de visuels gratuits: chaque visuel doit correspondre à une section réelle de la page.
- Chaque "prompt" décrit une image concrète, cohérente avec la marque et le secteur, dans l'esprit de la palette. PAS de texte incrusté, pas de logo, pas de capture d'UI.
- "key" = identifiant court, stable, en snake_case, unique (ex: "home_hero", "about_team", "services_grid_1", "product_1").
- "aspect": "wide" (large/paysage), "square" (carte/galerie), "portrait" (photo verticale), "tall" (verticale mobile).
- "role": hero | feature | gallery | about | banner | avatar | card. (Les rôles de fond sont interdits.)
- "alt": description accessible courte dans la langue de l'app.
${input.products?.length ? `- "product": numéro du produit réel montré (voir PRODUITS RÉELS), à omettre si aucun produit n'apparaît.\n` : ""}
Réponds en JSON strict:
{"slots":[{"key":"home_hero","page":"Home.tsx","prompt":"...","aspect":"wide","role":"hero","alt":"..."${input.products?.length ? `,"product":0` : ""}}]}`;

  try {
    const { text } = await generateText({
      model: gateway("openai/gpt-5.4-mini"),
      system: ART_DIRECTOR_SYSTEM,
      prompt,
      maxOutputTokens: 4000,
    });
    const obj = extractJSON(text);
    const raw: any[] = Array.isArray(obj?.slots) ? obj.slots : [];
    const validPages = new Set(input.pages.map((p) => p.file));
    const seen = new Set<string>();
    const slots: ImageSlot[] = [];
    // Les fonds en image sont interdits : ils ne s'adaptent pas au mode sombre
    // et rendent moche. Les fonds doivent être en CSS (dégradés/couleurs).
    const FORBIDDEN_ROLES = new Set(["background", "texture", "overlay", "backdrop", "pattern"]);
    for (const s of raw) {
      const key = String(s?.key || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "");
      const prompt = String(s?.prompt || "").trim();
      if (!key || !prompt || seen.has(key)) continue;
      const roleLc = String(s?.role || "feature").trim().toLowerCase();
      // Drop tout visuel destiné à être posé en fond derrière du contenu.
      if (FORBIDDEN_ROLES.has(roleLc) || /_bg$|_background$|backdrop|texture|overlay/.test(key)) continue;
      const page = validPages.has(String(s?.page)) ? String(s.page) : input.pages[0]?.file || "Home.tsx";
      const aspect = (["wide", "square", "portrait", "tall"].includes(s?.aspect) ? s.aspect : "wide") as ImageAspect;
      seen.add(key);
      const nProducts = input.products?.length || 0;
      const prodRaw = s?.product;
      const prodIdx = prodRaw === null || prodRaw === undefined || prodRaw === "" ? NaN : Number(prodRaw);
      slots.push({
        key, page, prompt, aspect,
        role: String(s?.role || "feature"),
        alt: String(s?.alt || prompt).slice(0, 160),
        ...(Number.isInteger(prodIdx) && prodIdx >= 0 && prodIdx < nProducts ? { product: prodIdx } : {}),
      });
    }
    return slots;
  } catch (e) {
    console.error("[planImageSlots] failed:", e);
    return [];
  }
}

// ── Generate all planned slots (bounded parallelism) into a manifest ──
export async function generateImageManifest(
  slots: ImageSlot[],
  onProgress?: (msg: string) => void,
  concurrency = 4,
  opts: {
    /** Produit réel à reproduire pour ce visuel (null = visuel libre). */
    productRefFor?: (slot: ImageSlot) => Promise<ProductImageRef | null>;
    /** Générateur injectable (tests). */
    generate?: typeof generateContentImage;
  } = {},
): Promise<ImageManifest> {
  const gen = opts.generate ?? generateContentImage;
  const manifest: ImageManifest = { urls: {}, meta: {} };
  if (!slots.length) return manifest;
  onProgress?.(`🎨 Direction artistique : ${slots.length} visuel(s) à générer…`);

  let done = 0;
  const queue = [...slots];
  async function worker() {
    for (;;) {
      const slot = queue.shift();
      if (!slot) return;
      let ref: ProductImageRef | null = null;
      try { ref = (await opts.productRefFor?.(slot)) ?? null; } catch { ref = null; }
      // [2026-10-01] « l'IA doit GÉNÉRER, pas choisir des images enregistrées » :
      // la vraie photo du produit sert de RÉFÉRENCE à la génération, mais n'est
      // plus jamais publiée telle quelle. Échec avec la référence → nouvel
      // essai sans référence ; échec total → visuel ignoré (le filet « clés
      // manquantes » de l'engine le régénère ensuite).
      let url: string | null = null;
      let usedRef = false;
      if (ref) {
        try {
          url = await gen(productRefPrompt(slot.prompt, { id: "", name: ref.name, description: ref.description, imageUrl: ref.photoUrl }), slot.aspect, widthForRole(slot.role), { refImages: [ref.refImage] });
          usedRef = !!url;
        } catch { url = null; }
      }
      if (!url) {
        try { url = await gen(slot.prompt, slot.aspect, widthForRole(slot.role)); } catch { url = null; }
      }
      done++;
      const meta = { alt: slot.alt, role: slot.role, page: slot.page, ...(usedRef ? { product: ref!.name } : {}) };
      if (url) {
        manifest.urls[slot.key] = url;
        manifest.meta[slot.key] = meta;
        onProgress?.(usedRef
          ? `🖼️ Visuel « ${slot.key} » généré avec le vrai produit « ${ref!.name} » (${done}/${slots.length})`
          : `🖼️ Visuel « ${slot.key} » généré (${done}/${slots.length})`);
      } else {
        onProgress?.(`⚠️ Visuel « ${slot.key} » non généré — ignoré (${done}/${slots.length})`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, slots.length) }, worker));
  const n = Object.keys(manifest.urls).length;
  onProgress?.(n ? `✅ ${n} visuel(s) généré(s)` : "ℹ️ Aucun visuel généré");
  return manifest;
}

// ── Manifest → per-page prompt block (tells the model what visuals exist) ──
export function imagesPromptBlock(manifest: ImageManifest, pageFile: string, platform: "web" | "mobile" = "web"): string {
  const entries = Object.entries(manifest.meta).filter(([, m]) => m.page === pageFile);
  if (!entries.length) return "";
  const list = entries.map(([key, m]) => `- IMAGES.${key} — ${m.role} · ${m.alt}${m.product ? ` · montre le VRAI produit « ${m.product} »` : ""}`).join("\n");
  const usage = platform === "mobile"
    ? `Importe \`{ IMAGES }\` depuis "../lib/images". Ce sont des images de CONTENU encadrées : \`<Image source={{ uri: IMAGES.clé }} style={…} resizeMode="cover" />\`. PAR DÉFAUT ne les pose pas en fond derrière du texte (pas de \`ImageBackground\` plein écran) — sauf si le business/style s'y prête vraiment (hôtel, voyage, restaurant, immobilier, mode…) ou si l'utilisateur le demande explicitement, alors \`ImageBackground\` est autorisé avec un overlay dégradé semi-transparent par-dessus pour garder le texte lisible.`
    : `Importe \`{ IMAGES }\` depuis "../lib/images". Ce sont des images de CONTENU encadrées : \`<img src={IMAGES.clé} alt="…" className="…object-cover rounded-…" />\`. PAR DÉFAUT ne les pose pas en fond de section derrière du texte (\`backgroundImage: url(...)\`) — sauf si le business/style s'y prête vraiment (hôtel, voyage, restaurant, immobilier, mode…) ou si l'utilisateur le demande explicitement, alors c'est autorisé avec un overlay dégradé semi-transparent (\`bg-gradient-to-t from-black/70 …\`) par-dessus pour garder le texte lisible en clair et en sombre.`;
  return `
## VISUELS DISPONIBLES POUR CETTE ${platform === "mobile" ? "ÉCRAN" : "PAGE"} (générés par l'IA)
Ces visuels ont été générés spécifiquement. ${usage}
Utilise-les PAR DÉFAUT comme CONTENU encadré : photo à côté du texte du héro, cartes, galerie, à-propos, produits. Les FONDS de section/héro/bannière restent par défaut des DÉGRADÉS ou COULEURS CSS de la palette, sauf exception ci-dessus. N'utilise QUE ces clés, n'invente aucune URL, ne laisse aucune image cassée.
${list}
`;
}

// ── Assets /genesis (chimera) présents dans le brief ────────────────────────
// Le moteur /genesis écrit ses cadres sur disque et injecte leurs URLs dans la
// spec de construction (bloc « ASSETS RÉELS DU RUN »). Sans le code ci-dessous,
// le builder ignorait ces URLs et générait ses propres visuels concurrents :
// les images de /genesis n'arrivaient jamais dans le site. Rien n'est supprimé —
// le chemin habituel (planImageSlots/generateImageManifest) reste actif quand le
// brief ne contient aucun asset chimera.

export interface ChimeraBriefAsset {
  /** URL absolue à recopier telle quelle dans le code du site. */
  url: string;
  /** nom de fichier, ex: "background-01-hero.webp" */
  name: string;
  /** clé stable utilisée dans IMAGES.*, ex: "chimera_background_01_hero" */
  key: string;
  /** background (plaque de fond bord à bord) | product (découpe) | ui (référence, jamais affichée) */
  kind: "background" | "product" | "ui";
  /** numéro du cadre d'origine (1-based) quand il est lisible dans le nom. */
  frame: number | null;
  /** libellé du cadre, ex: "hero" */
  label: string;
}

// [2026-09-05] CAUSE RÉELLE de « /genesis crée toujours un site PAS à partir
// des images » : cette expression n'acceptait QUE des URLs ABSOLUES
// (http://…/api/chimera/assets/…). Or depuis la correction 15.A deux formes
// circulent dans le produit — l'ABSOLUE (pour le site construit) et la
// RELATIVE (/api/chimera/assets/…, pour l'affichage dans le chat). Dès que la
// spec du run contenait la forme relative, AUCUN asset n'était reconnu, le
// chemin « images du run » était sauté sans un mot, et le site repartait sur
// des images de stock. On reconnaît donc les DEUX formes, et une URL relative
// est ramenée à l'origine réelle du serveur (le site construit tourne sur un
// autre port : une URL relative y renverrait 404).
const CHIMERA_URL_RE = /(?:https?:\/\/[^\s"'`)<>\]]+)?\/api\/chimera\/assets\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.(?:webp|png|jpe?g|avif)/gi;

/** Repère les URLs d'assets /genesis dans un brief de construction. */
export function chimeraAssetsFromBrief(brief: string): ChimeraBriefAsset[] {
  const out: ChimeraBriefAsset[] = [];
  const seen = new Set<string>();
  for (const raw of String(brief || "").match(CHIMERA_URL_RE) || []) {
    const cleaned = raw.replace(/[.,;]+$/, "");
    // Forme relative → on la ramène à l'origine absolue du serveur Velbaz.
    const url = /^https?:\/\//i.test(cleaned) ? cleaned : `${CHIMERA_ASSETS_ORIGIN}${cleaned}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const name = url.split("/").pop()!;
    const stem = name.replace(/\.[a-z0-9]+$/i, "");
    const kind: ChimeraBriefAsset["kind"] = /(^|-)ui$/i.test(stem)
      ? "ui"
      : /^product-/i.test(stem)
        ? "product"
        : "background";
    const m = /(\d{1,3})/.exec(stem);
    const frame = m ? parseInt(m[1], 10) : null;
    const label = stem
      .replace(/^(background|product)-/i, "")
      .replace(/^\d{1,3}-/, "")
      .replace(/-(ui|clean)$/i, "") || stem;
    out.push({
      url,
      name,
      key: `chimera_${stem.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()}`,
      kind,
      frame,
      label,
    });
  }
  return out;
}

/**
 * Manifeste amorcé avec les assets du run /genesis. `pages` est la liste des
 * pages à construire, dans l'ordre : le cadre n°k appartient à la page k.
 * Les références d'écran (…-ui) sont EXCLUES du manifeste (elles ne doivent
 * jamais s'afficher) mais restent lisibles dans le brief.
 */
export function chimeraImageManifest(
  assets: ChimeraBriefAsset[],
  pages: { file: string; name?: string }[],
): ImageManifest {
  const manifest: ImageManifest = { urls: {}, meta: {} };
  for (const a of assets) {
    if (a.kind === "ui") continue;
    const idx = a.frame && a.frame >= 1 ? a.frame - 1 : 0;
    const page = pages[Math.min(idx, Math.max(0, pages.length - 1))]?.file || pages[0]?.file || "";
    manifest.urls[a.key] = a.url;
    manifest.meta[a.key] = {
      alt: a.kind === "product" ? `Produit — ${a.label}` : `Plaque de fond — ${a.label}`,
      role: a.kind === "product" ? "product" : "background",
      page,
    };
  }
  return manifest;
}

/**
 * Bloc de prompt par page pour les assets /genesis. Il REMPLACE
 * `imagesPromptBlock` quand des assets chimera existent : les règles y sont
 * inversées (les plaques de fond DOIVENT être posées bord à bord).
 */
export function chimeraImagesPromptBlock(manifest: ImageManifest, pageFile: string): string {
  const entries = Object.entries(manifest.meta).filter(([, m]) => m.page === pageFile);
  if (!entries.length) return "";
  const backs = entries.filter(([, m]) => m.role === "background");
  const prods = entries.filter(([, m]) => m.role === "product");
  const line = (k: string, m: { alt: string }) => `- IMAGES.${k} — ${m.alt}`;
  return `
## ASSETS RÉELS DU RUN /genesis POUR CETTE PAGE — À UTILISER TELS QUELS
Ces fichiers ont été produits pour CETTE page et existent déjà sur le serveur.
Importe \`{ IMAGES }\` depuis "../lib/images". N'utilise QUE ces clés, n'invente AUCUNE URL, n'ajoute aucune image de stock ni placeholder.
${backs.length ? `\n### Plaques de fond (bord à bord, full-bleed)\n${backs.map(([k, m]) => line(k, m)).join("\n")}\nChaque plaque se pose en FOND bord à bord de sa section (\`absolute inset-0 w-full h-full object-cover\`), avec le vrai texte et les vrais contrôles HTML par-dessus.` : ""}
${prods.length ? `\n### Découpes produit (par-dessus le fond)\n${prods.map(([k, m]) => line(k, m)).join("\n")}\nChaque découpe se pose PAR-DESSUS le fond de la même section, même échelle et même cadrage que dans le cadre d'origine (\`relative z-10\`).` : ""}
Jamais une image livrée comme une capture d'écran affichée : tout élément dessiné (lien, chip, prix, bouton, compteur) existe comme vrai élément HTML vivant.
`;
}
