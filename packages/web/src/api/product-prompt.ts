/**
 * Quel objet la photo produit doit-elle montrer ?
 * ---------------------------------------------------------------------------
 * [2026-09-25] Bug signalé : « j'avais demandé une marque de chaussure et les
 * images sorties, c'était pas l'image du produit lui-même, c'était des images
 * de autre chose. »
 *
 * Cause : les prompts de photo produit se branchaient sur `isFashionBusiness()`,
 * c'est-à-dire sur le SECTEUR. Une marque de baskets est dans le secteur
 * « Fashion », donc elle recevait le prompt textile — « the garment … WORN BY A
 * MODEL … printed design on the garment ». Le modèle d'image obéissait : il
 * photographiait un mannequin en t-shirt imprimé. La photo ne montrait jamais
 * la chaussure vendue.
 *
 * La bonne question n'est pas « est-ce de la mode ? » mais « quel objet est
 * réellement vendu, et cet objet se PORTE-t-il comme un vêtement ? ». Les deux
 * réponses vivent ici, dans un seul module, parce que cinq endroits du code les
 * posaient séparément (les deux chemins du mega-init, l'endpoint mockup
 * manuel, le visualiseur produit et son approbation) et que seuls les deux
 * premiers avaient été corrigés.
 */
import { isGarmentPodType, podMerchDecision, requiredPodType } from "./pod-guard";

/**
 * Types Printify qui se portent VRAIMENT comme un vêtement : ce sont les seuls
 * pour lesquels « porté par un mannequin » décrit la bonne photo. Une
 * chaussure se porte aussi, mais photographier « un mannequin » donne une
 * personne en pied dont les chaussures font 5 % de l'image — donc elle n'est
 * pas ici : elle est traitée comme un objet, en packshot.
 */
// [2026-10-03] Les vêtements du catalogue (pantalon, robe, veste…) viennent de
// pod-guard (source unique) ; le tablier s'ajoute ici, il se porte aussi.
const GARMENT_POD_TYPES = new Set<string>(["apron"]);

/** Libellés photographiques explicites pour les types ambigus. */
const OBJECT_LABELS: Record<string, string> = {
  shoe: "pair of sneakers (footwear)",
  cap: "cap (headwear)",
  poster: "framed art print",
  tumbler: "insulated tumbler",
};

/** Le type d'objet réellement vendu ('shoe', 'mug'…), ou null si indéterminé. */
export function soldObjectType(input: { idea?: string; industry?: string; description?: string }): string | null {
  return requiredPodType(podMerchDecision({ idea: input.idea, industry: input.industry, description: input.description }));
}

/**
 * Libellé anglais de l'objet vendu, utilisable tel quel dans un prompt image.
 * Chaîne vide quand l'activité ne désigne aucun objet précis — dans ce cas les
 * appelants gardent leur formulation générique, ils ne devinent pas.
 */
export function soldObjectLabel(input: { idea?: string; industry?: string; description?: string }): string {
  const type = soldObjectType(input);
  if (!type) return "";
  return OBJECT_LABELS[type] || type;
}

/** L'objet vendu se porte-t-il comme un vêtement (photo « portée » légitime) ? */
export function isGarmentType(type: string | null | undefined): boolean {
  return !!type && (isGarmentPodType(type) || GARMENT_POD_TYPES.has(String(type)));
}

/**
 * Photo produit principale : l'objet vendu, seul, en packshot.
 * Les interdits explicites sont là parce que le modèle d'image les produisait
 * réellement : un mannequin, un t-shirt de substitution, un à-plat de motif ou
 * une planche technique en trois vues à la place d'une photo.
 */
export function packshotPrompt(input: {
  label: string;
  name: string;
  description?: string;
  concept?: string;
}): string {
  const { label, name } = input;
  const desc = input.description || label;
  const concept = input.concept
    ? ` Its surface carries this design/colorway: ${input.concept}.`
    : "";
  return (
    `Professional e-commerce product photography of a ${label}: "${name}" — ${desc}. ` +
    `The subject of the photo IS the ${label} itself, the real product, shown alone as a hero packshot: ` +
    `three-quarter angle, centered on a clean seamless white/neutral studio background, soft studio lighting, ` +
    `true materials, colours and stitching, razor-sharp detail, 8K commercial quality.${concept} ` +
    `ABSOLUTELY NO model or person, NO garment (no t-shirt, hoodie, sweatshirt), NO mannequin, ` +
    `NO poster/logo sheet/pattern swatch, NO multi-view technical drawing or collage, NO text overlay — ` +
    `one single ${label}, one single photo.`
  );
}

/**
 * Prompt d'un angle de catalogue ('model' | 'studio' | 'lifestyle' | 'flat')
 * pour un objet vendu connu et NON vêtement.
 *
 * L'angle 'model' devient « l'objet en cours d'utilisation », cadré sur
 * l'objet : c'est ce que l'utilisateur attend d'une photo de chaussure portée,
 * et non une personne en pied habillée d'autre chose.
 */
export function objectAnglePrompt(angle: string, label: string, desc: string): string {
  const common = `True materials and colours, razor-sharp detail, 8K commercial quality. The ${label} is the subject and fills the frame. NO garment substitution (no t-shirt/hoodie), NO technical drawing, NO text overlay.`;
  switch (angle) {
    case "model":
      return `Professional e-commerce photography of a ${label} in use: ${desc}. The ${label} is worn/used by a person but the camera is close on the ${label} itself — it dominates the frame; no full-body fashion portrait, no other product. Natural light, editorial quality. ${common}`;
    case "lifestyle":
      return `Lifestyle product photography of a ${label}: ${desc}. Placed in a stylish real-world context, natural lighting, storytelling composition, aspirational but authentic. ${common}`;
    case "flat":
      return `Flat lay product photography of a ${label}: ${desc}. Top-down shot on a minimal background, clean styling, premium e-commerce aesthetic. ${common}`;
    case "studio":
    default:
      return `Studio product photography of a ${label}: ${desc}. Clean white seamless background, dramatic softbox lighting, the ${label} centered and alone, premium e-commerce style. ${common}`;
  }
}
