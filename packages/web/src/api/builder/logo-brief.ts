// ─── LOGO : UNE SEULE DIRECTION, LOGIQUE POUR CE QUE LA MARQUE VEND ─────────
//
// Demande utilisateur (2026-10-04) :
//
//   « je veux que le logo généré, par exemple pour une marque de chaussures,
//     soit logique avec la marque, et pas que pour les chaussures : le logo
//     doit être pro et logique »
//
// Ce qui se passait réellement (constaté sur les logos en base) :
//   - PasStride (marque de chaussures) : un « R » bleu/violet. La marque
//     commence par P et rien n'évoque la chaussure.
//   - Paséo (chaussures) : un talon fondu dans un « R ».
//   - MailFlow (e-mail) : une flèche en boucle avec un graphique, générique.
//
// Causes, dans le code :
//   1. TROIS chemins construisaient chacun leur propre prompt de logo
//      (génération initiale, « change le logo » dans le chat, aperçu de
//      marque). Seul le premier demandait un concept, sans la description du
//      projet ni l'objet vendu ; l'aperçu de marque — celui que l'utilisateur
//      voit en premier — prenait le « concept » d'un appel qui décidait aussi
//      tagline, palette et polices, sans aucune règle de logique métier.
//   2. Le style « lettermark » était tiré au hasard (hash du nom) et le prompt
//      disait « the initials » sans jamais dire QUELLE lettre : le modèle image
//      inventait un R pour une marque en P.
//   3. Les codes secteur se trouvaient par `includes()` sur des fragments
//      (« car » dans « carte », « mode » dans « modèle ») et n'avaient AUCUNE
//      entrée chaussure / pantalon / cosmétique / boulangerie : une marque de
//      chaussures classée « Technology » recevait les codes de la tech.
//   4. `designLogoBrief` avalait toute erreur (`catch {}`) et le logo partait
//      alors sans concept du tout.
//   5. Personne ne REGARDAIT le logo produit : aucun contrôle ne vérifiait
//      qu'il montrait le bon sujet, ni qu'il ne contenait pas une lettre fausse.
//
// Ce module est la source unique pour les trois chemins : signaux métier →
// brief (sujet + concept + lien logique + palette) → prompt → génération →
// relecture par un modèle de vision → nouvel essai motivé si rejet.
// Les appels réseau sont injectés (`LogoDeps`) pour que tout soit testable.

import { resolveSubject, stripSubjectLock } from "../idea-subject";
import { soldObjectLabel } from "../product-prompt";
import type { RawImage } from "./logo-image";

// ─── Styles et règles techniques (déplacés depuis api/index.ts) ─────────────
// Historique : l'ancienne version demandait « app icon », « 3D glossy »,
// « gradient flowing »… et produisait des monogrammes dorés biseautés. Chaque
// style décrit UN objet identifiable ; formulations vagues bannies.
export const LOGO_STYLES = [
  "ONE bold geometric symbol that clearly depicts a single recognizable thing tied to the business (an object, a tool, a natural form), reduced to its purest flat silhouette",
  "the silhouette of ONE animal or object central to the business, reduced to its essential outline, single flat solid fill, no facial detail",
  "refined lettermark: the initials merged into ONE clean custom glyph, flat solid fill, precise geometry",
  "ONE single continuous shape suggesting movement (swoosh, arc, wing, ribbon of speed), flat solid fill, confident thick strokes",
  "clean contained emblem: ONE simple recognizable silhouette inside a plain circle or shield, two flat colors maximum",
  "negative-space mark: ONE simple shape whose empty area forms a second recognizable form, two flat colors maximum",
  "ONE compact geometric symbol built by cutting and joining a few shapes into a SINGLE connected form (never separate shapes floating side by side)",
  "monoline symbol drawn with ONE uniform stroke weight, geometric, closed and deliberate, depicting one clear object (never a loose sketch)",
];

// Contrainte technique commune à TOUS les prompts de logo. C'est ce bloc qui
// empêche les rendus « faux 3D doré » : à ne pas alléger.
export const LOGO_HARD_RULES = "MEANING REQUIREMENT — the mark must be ONE single, deliberate, instantly nameable form: a stranger seeing it must be able to say what it is in three words. It must be one connected, well-constructed symbol, optically balanced and centered, built on a clear geometric grid like Nike, Adidas, Puma, Lacoste or Chanel. STRICTLY FORBIDDEN as a composition: a pile or cluster of plain circles, dots, blobs, squares or primitive shapes sitting next to each other or stacked with no meaning; shapes floating apart from each other; a stray line, bar, baseline or underline under or beside the symbol; anything that looks like an unfinished sketch or a random abstract blob. STRICT TECHNICAL REQUIREMENTS — this must look like a real logo made by a professional branding agency, the kind a Fortune 500 company would use: FLAT 2D VECTOR ONLY, solid uniform color fills, hard clean edges, geometric precision. Maximum 2 colors plus white. The complete symbol must be fully visible, centered, with generous even margins on all four sides — never cropped, never touching the edges, never zoomed in. It must stay perfectly readable when shrunk to 16x16 pixels. STRICTLY FORBIDDEN: 3D, extrusion, bevel, embossing, gloss, glare, highlights, reflections, metallic or gold or chrome effects, drop shadows, inner shadows, gradients, glow, blur, noise, grain, texture, paper or fabric background, mockup, photography, photorealism, hand-drawn or sketchy strokes, thin decorative flourishes, ribbons, swirls, laurels, random loops or threads, overlapping translucent layers, app-icon rounded square container, busy or cluttered composition. BACKGROUND — plain PURE UNIFORM WHITE (#FFFFFF), perfectly even, nothing else in the frame: no panel, no frame, no border, no vignette, no shadow, no off-white or grey tint anywhere. This background is REMOVED automatically afterwards to produce a transparent PNG, so it must be perfectly clean. Consequence, and it is strict: the symbol itself must NEVER use white, off-white or very light grey as one of its fills or strokes — every part of the mark must be a solid saturated or dark color, so that the mark stays fully visible on a white page AND on a dark website header. ABSOLUTELY NO TEXT, NO WORDS, NO BRAND NAME, NO SLOGAN, NO LETTERS anywhere";

// Index du style « lettermark » dans LOGO_STYLES : il n'est JAMAIS tiré au
// hasard. Un monogramme n'existe que si le brief l'a décidé, avec la VRAIE
// initiale de la marque.
const LETTERMARK_STYLE = 2;

// ─── Normalisation texte (sans RegExp construite à la volée) ────────────────
/** Minuscules, sans accents, tout ce qui n'est pas [a-z0-9] → espace, bordé d'espaces. */
export function foldText(raw: string): string {
  const lower = String(raw || "").toLowerCase().normalize("NFD");
  let out = "";
  for (const ch of lower) {
    const code = ch.charCodeAt(0);
    if (code >= 0x300 && code <= 0x36f) continue; // diacritique combinant
    out += (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ? ch : " ";
  }
  return ` ${out.split(" ").filter(Boolean).join(" ")} `;
}

/**
 * Une clé est un mot ou une expression entière (« sac a main ») ; un `*` final
 * en fait un préfixe de mot (« chaussure* » couvre « chaussures »). Jamais un
 * fragment au milieu d'un mot : « car » ne matche plus « carte ».
 */
export function hasKey(folded: string, key: string): boolean {
  const stem = key.endsWith("*");
  const k = foldText(stem ? key.slice(0, -1) : key).trim();
  if (!k) return false;
  return folded.includes(stem ? ` ${k}` : ` ${k} `);
}

// ─── Codes visuels par métier ───────────────────────────────────────────────
export interface SectorCodes {
  id: string;
  keys: string[];
  /** Palette et esprit visuel du métier. */
  guide: string;
  /** Vocabulaire de symboles LOGIQUES pour ce métier (anglais : part au modèle image). */
  symbols: string;
}

// ORDRE = priorité dans un même texte : le plus précis d'abord (« marque de
// chaussures de sport » est de la chaussure avant d'être du sport).
export const SECTORS: SectorCodes[] = [
  {
    id: "footwear",
    keys: ["chaussur*", "chausur*", "basket", "baskets", "sneaker*", "shoe*", "footwear", "botte*", "boots", "bottine*", "sandale*", "escarpin*", "mocassin*", "loafer*", "espadrille*", "chausson*", "talons", "derbies", "running shoe*"],
    guide: "Chaussure — codes des vraies marques de chaussures : formes nettes et dynamiques, noir/blanc cassé ou une couleur forte unique (rouge, bleu, vert) en APLAT. Le symbole doit faire penser à la chaussure ou à la marche au premier regard.",
    symbols: "a stylised shoe or sneaker silhouette seen in profile, the outline of a sole or its tread pattern, a lace or an eyelet, a heel, a footprint, a stride or forward-motion mark derived from the curve of a shoe",
  },
  {
    id: "trousers",
    keys: ["pantalon*", "pentalon*", "jeans", "denim", "chino*", "trouser*", "pants", "salopette*", "shorts"],
    guide: "Pantalon / Denim — codes atelier et workwear : indigo, noir, brun cuir, écru en APLAT. Le symbole doit évoquer le pantalon ou sa fabrication.",
    symbols: "a simple trouser or jeans silhouette, a back pocket with its stitching, a rivet, a belt loop, a folded hem, a stitched seam line",
  },
  {
    id: "jewellery",
    keys: ["bijou*", "bijoux", "jewel*", "joaill*", "bague*", "collier*", "bracelet*", "boucles d oreilles", "horlog*", "montres", "watches", "wristwatch*"],
    guide: "Bijoux / Horlogerie — raffiné et précieux, EN APLAT : noir, ivoire, bordeaux ou vert profond (pas d'or métallisé). Symbole fin mais lisible.",
    symbols: "a faceted gem outline, a ring seen from the front, a clasp, a pearl, a watch face or crown",
  },
  {
    id: "leather",
    keys: ["maroquin*", "sac a main", "sacs a main", "handbag*", "leather", "cuir", "portefeuille*", "ceinture*"],
    guide: "Maroquinerie — artisanal et premium, EN APLAT : brun cuir, cognac, noir, crème.",
    symbols: "a handbag silhouette, a buckle, a saddle stitch, a leather tag, a clasp",
  },
  {
    id: "apparel",
    keys: ["vetement*", "apparel", "fashion", "mode", "couture", "pret a porter", "streetwear", "t shirt*", "tshirt*", "hoodie*", "sweat*", "robe", "robes", "textile*", "habits", "lingerie", "maillot*", "veste", "vestes"],
    guide: "Mode / Vêtement — élégant et épuré, à la manière des grandes maisons : noir ou blanc cassé en APLAT, éventuellement UNE couleur d'accent sobre. Soit un monogramme net de la vraie initiale, soit UNE forme emblématique simple. INTERDIT : or métallisé, biseaux, ombres, entrelacs, fils/boucles décoratifs.",
    symbols: "a hanger, a garment silhouette (shirt, jacket, dress), a collar, a button, a needle with thread forming one shape, a folded fabric, or a stylised animal that carries the brand's attitude",
  },
  {
    // Avant « beauty » : « bougies parfumées » est une bougie, pas un parfum.
    id: "candles",
    keys: ["bougie*", "candle*", "parfum d interieur", "diffuseur*"],
    guide: "Bougies / Parfum d'intérieur — chaleureux et apaisant : ambre, terracotta, vert sauge, noir en APLAT.",
    symbols: "a candle with a single flame, a flame alone, a wax drop, a candle jar silhouette",
  },
  {
    id: "beauty",
    keys: ["cosmeti*", "beaute", "beauty", "skincare", "soin de la peau", "soins de la peau", "maquillage", "makeup", "parfum*", "fragrance*", "serum*", "savon*", "creme*", "spa", "onglerie", "manucure"],
    guide: "Beauté / Cosmétique — doux et raffiné : nude, rose poudré, vert sauge, terracotta ou noir en APLAT; symbole délicat mais net. Pas de néon.",
    symbols: "a drop, a botanical leaf or flower, a cosmetic bottle or jar silhouette, a soft face profile, a lipstick, a petal",
  },
  {
    id: "hair",
    keys: ["coiffure", "coiffeur*", "barbier*", "barber*", "salon de coiffure", "hair*"],
    guide: "Coiffure / Barbier — net et stylé : noir, bordeaux, crème, une couleur d'accent en APLAT.",
    symbols: "scissors, a comb, a razor, a barber pole, a stylised hair wave or beard profile",
  },
  {
    id: "bakery",
    keys: ["boulanger*", "patisser*", "bakery", "viennoiser*", "croissant*", "baguette*", "chocolat*", "confiser*", "gateau*", "cake*"],
    guide: "Boulangerie / Pâtisserie / Chocolat — chaleureux et artisanal : brun doré, crème, rouge brique, chocolat en APLAT.",
    symbols: "a wheat ear, a loaf or baguette, a croissant, a whisk, a cake slice, a cocoa bean or chocolate square",
  },
  {
    id: "coffee",
    keys: ["cafe", "cafes", "coffee", "torrefact*", "barista", "coffee shop", "salon de the", "the vert", "the noir", "tea", "teas"],
    guide: "Café / Thé — chaleureux : brun torréfié, crème, vert profond ou noir en APLAT.",
    symbols: "a coffee bean, a cup seen from the side with one steam curl, a tea leaf, a coffee pot",
  },
  {
    id: "drinks",
    keys: ["vin", "vins", "wine*", "biere*", "beer*", "brasserie artisanale", "brewery", "spiritueux", "gin", "whisky", "rhum", "cocktail*", "vigne*", "vignoble*"],
    guide: "Boissons — caractère et terroir : bordeaux, vert bouteille, ambre, noir, crème en APLAT.",
    symbols: "a grape bunch, a bottle silhouette, a glass, a hop cone, a barrel, a vine leaf",
  },
  {
    id: "food",
    keys: ["restaurant*", "restau*", "food", "cuisine", "traiteur*", "pizza*", "burger*", "sushi*", "brasserie", "bistro*", "snack*", "foodtruck", "food truck", "kebab*", "friterie", "frites", "epicerie", "grocery", "repas", "plats", "meal*"],
    guide: "Restauration / Alimentation — chaleureux et appétissant : rouges, oranges, verts naturels, tons terreux/crème en APLAT; symbole gourmand concret.",
    symbols: "the signature dish reduced to a silhouette, a utensil (fork, chef's knife, spoon), a chef's hat, a plate, a cooking pot, a flame, the main ingredient",
  },
  {
    id: "automotive",
    keys: ["automobile*", "voiture*", "autos", "car", "cars", "moto", "motos", "motorcycle*", "vehicule*", "vehicle*", "concession*", "garage*", "dealer*", "pneu*", "carrosserie"],
    guide: "Automobile — codes PREMIUM et mécaniques, EN APLAT : noir profond, anthracite ou argent MAT, avec UNE couleur d'accent forte (rouge course ou bleu profond). Emblème type badge de constructeur. INTERDIT : chrome brillant, métal 3D, néon.",
    symbols: "a car silhouette in profile, a wheel or rim, a steering wheel, a road converging to the horizon, a shield-shaped badge containing a speed line",
  },
  {
    id: "health",
    keys: ["sante", "health*", "medical", "medic*", "clinic*", "clinique*", "pharma*", "dentaire", "dentist*", "hopital", "kine*", "osteo*", "infirmi*", "wellness"],
    guide: "Santé — rassurant et clinique : bleus, verts d'eau en APLAT; symbole propre. Pas de couleurs agressives.",
    symbols: "a medical cross, a heart with a pulse line, a tooth, a caring hand, a leaf, a stethoscope",
  },
  {
    id: "finance",
    keys: ["finance*", "bank*", "banque*", "investissement*", "investment*", "insurance", "assurance*", "fintech", "comptab*", "patrimoine"],
    guide: "Finance — sérieux et solide : bleu marine, vert profond, gris en APLAT; symbole géométrique stable.",
    symbols: "a rising bar or column, a shield, a coin, a key, a solid geometric pillar",
  },
  {
    id: "realestate",
    keys: ["immobil*", "real estate", "construction", "batiment*", "architect*", "btp", "renovation*", "appartement*", "agence immobiliere", "menuiser*", "plombier*", "electricien*"],
    guide: "Immobilier / Construction — solide et premium, EN APLAT : bleu marine, noir, terracotta ou gris pierre; symbole d'habitat ou de structure.",
    symbols: "a house roof outline, a door, a key, a building skyline, a trowel or hammer, a window frame",
  },
  {
    id: "furniture",
    keys: ["meuble*", "furniture", "mobilier", "canape*", "chaise*", "deco", "decoration", "decoration interieure", "design d interieur", "luminaire*", "ebenist*"],
    guide: "Mobilier / Déco — calme et architectural : bois, terracotta, vert olive, noir en APLAT.",
    symbols: "a chair silhouette, a lamp, a sofa outline, a wood grain arc, a window",
  },
  {
    id: "plants",
    keys: ["fleur*", "fleuriste*", "flower*", "florist*", "plante*", "jardin*", "garden*", "paysag*", "botani*"],
    guide: "Fleurs / Jardin — naturel et frais : verts, rose, terracotta en APLAT.",
    symbols: "a flower, a leaf, a sprout, a pot with a plant, a tree",
  },
  {
    id: "pets",
    keys: ["animal", "animaux", "animalerie", "chien*", "dog*", "chiot*", "pet", "pets", "toilettage", "veterinaire*", "croquette*"],
    guide: "Animaux — chaleureux et rassurant : couleurs franches en APLAT.",
    symbols: "a dog or cat silhouette, a paw print, a bone, a pet collar",
  },
  {
    id: "kids",
    keys: ["enfant*", "bebe*", "baby", "kids", "jouet*", "toy*", "puericulture", "creche*"],
    guide: "Enfants — joyeux et rassurant : couleurs vives mais douces en APLAT.",
    symbols: "a teddy bear, a building block, a balloon, a star, a small animal",
  },
  {
    id: "photo",
    keys: ["photograph*", "studio photo", "videaste*", "videograph*"],
    guide: "Photo / Vidéo — net et créatif : noir, blanc cassé, une couleur d'accent en APLAT.",
    symbols: "a camera silhouette, a lens aperture, a viewfinder frame, a film strip, a play triangle",
  },
  {
    id: "music",
    keys: ["musique*", "music*", "musicien*", "dj", "studio d enregistrement", "concert*"],
    guide: "Musique — expressif : noir, une couleur vive en APLAT.",
    symbols: "a sound wave, a vinyl record, a headphone, a guitar or instrument silhouette, a musical note",
  },
  {
    id: "logistics",
    keys: ["livraison*", "delivery", "logistique", "logistics", "demenag*", "transporteur*", "coursier*"],
    guide: "Livraison / Transport — fiable et rapide : bleu, orange, noir en APLAT.",
    symbols: "a parcel box, a delivery van in profile, a forward arrow formed by a road, a map pin",
  },
  {
    id: "cleaning",
    keys: ["nettoyage", "menage", "cleaning", "pressing", "laverie", "blanchisserie"],
    guide: "Nettoyage — propre et rassurant : bleus, verts frais en APLAT.",
    symbols: "a water drop, a sparkle, a bubble, a spray bottle, a broom",
  },
  {
    id: "sport",
    keys: ["sport*", "fitness", "gym", "crossfit", "musculation", "coach*", "yoga", "pilates", "running", "velo", "velos", "cycling"],
    guide: "Sport / Fitness — énergie et puissance : noir, rouge/orange vif, jaune électrique en APLAT; symbole dynamique.",
    symbols: "a dumbbell, a runner in motion, a flame, a bicycle, a ball, a forward-motion mark",
  },
  {
    id: "travel",
    keys: ["voyage*", "travel*", "tourism*", "tourisme", "hotel*", "airline*", "aerien", "camping", "gite*", "location de vacances"],
    guide: "Voyage — évasion et confiance : bleus, turquoise, sable en APLAT.",
    symbols: "a paper plane, a suitcase, a compass, a mountain, a sun over the sea, a map pin",
  },
  {
    id: "education",
    keys: ["education", "ecole*", "school*", "formation*", "learn*", "cours particuliers", "academy", "academie", "universite*", "tutorat", "soutien scolaire"],
    guide: "Éducation — sérieux mais accessible : bleus, verts, touches vives en APLAT.",
    symbols: "an open book, a graduation cap, a pencil, a light bulb, a growing sprout",
  },
  {
    id: "legal",
    keys: ["avocat*", "law", "lawyer*", "legal", "juridique", "notaire*", "huissier*"],
    guide: "Juridique — sobre et crédible : bleu marine, gris, bordeaux en APLAT.",
    symbols: "scales of justice, a classical column, a fountain pen nib, a shield",
  },
  {
    id: "tech",
    keys: ["logiciel*", "software", "saas", "app", "apps", "application*", "appli", "ia", "ai", "intelligence artificielle", "crypto*", "blockchain", "cloud", "data", "digital", "numerique", "tech", "technolog*", "plateforme*", "platform*", "email*", "mail", "newsletter*", "crm", "api"],
    guide: "Tech / Logiciel — moderne et net : bleu électrique, violet ou vert vif en APLAT (jamais en dégradé ni en néon flou).",
    symbols: "a simple geometric mark derived from WHAT THE SOFTWARE DOES (an envelope for e-mail, a calendar page for scheduling, a chat bubble for messaging, a shield for security, a lightning bolt for speed), never a random abstract shape",
  },
];

/** Premier secteur trouvé, en lisant les textes DANS L'ORDRE donné (le plus fiable d'abord). */
export function detectSector(texts: string[]): SectorCodes | null {
  for (const t of texts) {
    const folded = foldText(t);
    if (!folded.trim()) continue;
    for (const s of SECTORS) if (s.keys.some((k) => hasKey(folded, k))) return s;
  }
  return null;
}

const GENERIC_GUIDE =
  "Adapte STRICTEMENT la palette et le style du logo aux codes visuels réels du métier (le logo doit « ressembler » à ce que fait l'entreprise). N'utilise PAS un look néon tech générique par défaut.";

/**
 * Codes visuels du métier, pour les prompts qui en ont besoin (aperçu de
 * marque, design system). L'idée et la description passent AVANT le libellé
 * d'industrie : Paselle (chaussures) est classée « Technology » en base.
 */
export function industryDesignLanguage(industry: string, idea: string, description = ""): string {
  const sector = detectSector([stripSubjectLock(idea), description, industry]);
  return sector ? sector.guide : GENERIC_GUIDE;
}

// ─── Signaux métier ─────────────────────────────────────────────────────────
export interface LogoInput {
  name: string;
  idea: string;
  industry: string;
  description?: string;
  /** Ce que l'utilisateur a demandé pour ce logo (« un renard orange », retour d'aperçu…). */
  direction?: string;
  /** Palette imposée (aperçu de marque) : 1 ou 2 hex. Sinon le brief la choisit. */
  palette?: string[];
}

export interface LogoSignals {
  name: string;
  /** Initiale RÉELLE de la marque (« Paséo » → « P »), seule lettre autorisée. */
  initial: string;
  subject: string;
  soldObject: string;
  description: string;
  userText: string;
  industry: string;
  sector: SectorCodes | null;
  direction: string;
  palette: string[];
}

// Articles sautés pour trouver l'initiale qui porte le nom : « Le Fournil de
// Max » se monogramme en F, pas en L (sinon le relecteur lit « LD »).
const LEADING_ARTICLES = new Set(["le", "la", "les", "l", "the", "el", "il", "lo", "het", "t"]);

export function brandInitial(name: string): string {
  const words = foldText(name).trim().split(" ").filter(Boolean);
  const first = words.find((w, i) => !(LEADING_ARTICLES.has(w) && i < words.length - 1)) || "";
  return first ? first[0].toUpperCase() : "";
}

export function normalizeHex(raw: unknown): string {
  const s = String(raw || "").trim();
  const h = s.startsWith("#") ? s.slice(1) : s;
  if (h.length !== 6) return "";
  for (const ch of h.toLowerCase()) if (!"0123456789abcdef".includes(ch)) return "";
  return `#${h.toUpperCase()}`;
}

/**
 * Luminance relative (0 = noir, 1 = blanc). Le fond blanc du logo est retiré
 * au détourage : une couleur très claire DANS le logo devient un trou, ou
 * disparaît sur un en-tête blanc. Ces couleurs sont donc refusées.
 */
export function hexLuminance(hex: string): number {
  const h = normalizeHex(hex).slice(1);
  if (!h) return 1;
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export const MAX_LOGO_COLOR_LUMINANCE = 0.75;
const usableLogoColor = (hex: string): boolean => !!hex && hexLuminance(hex) <= MAX_LOGO_COLOR_LUMINANCE;

export function logoSignals(input: LogoInput): LogoSignals {
  const userText = stripSubjectLock(input.idea || "").slice(0, 1500);
  const description = String(input.description || "").slice(0, 600);
  const industry = String(input.industry || "");
  const subject = resolveSubject(userText).subject;
  const soldObject = soldObjectLabel({ idea: userText, industry, description });
  const name = String(input.name || "").trim() || "Marque";
  return {
    name,
    initial: brandInitial(name),
    subject,
    soldObject,
    description,
    userText,
    industry,
    sector: detectSector([subject, soldObject, description, userText, industry]),
    direction: String(input.direction || "").trim().slice(0, 400),
    palette: (input.palette || []).map(normalizeHex).filter(usableLogoColor).slice(0, 2),
  };
}

// ─── Brief ──────────────────────────────────────────────────────────────────
export type LogoKind = "symbol" | "monogram";

export interface LogoBrief {
  kind: LogoKind;
  /** Ce que le logo représente, 2 à 6 mots (« sneaker silhouette in profile »). */
  subject: string;
  /** Description dessinable, 1 à 2 phrases. */
  concept: string;
  /** Pourquoi c'est logique pour CETTE marque. */
  link: string;
  palette: string[];
}

/** Concept déjà essayé que le modèle image n'a pas su rendre proprement. */
export interface FailedConcept {
  subject: string;
  reasons: string[];
}

export function logoBriefPrompts(s: LogoSignals, failed: FailedConcept | null = null): { system: string; user: string } {
  const system =
    "Tu es directeur artistique senior dans une agence d'identité de marque (niveau Pentagram, Landor). " +
    "Tu conçois des logos professionnels et LOGIQUES : un client doit comprendre au premier regard le lien entre le symbole et ce que vend la marque. Réponds en JSON strict.";
  const lines: (string | null)[] = [
    `Marque : ${s.name}`,
    `Initiale réelle de la marque : ${s.initial || "(aucune)"}`,
    s.subject ? `Ce qu'est l'entreprise : ${s.subject}` : null,
    s.soldObject ? `Objet vendu : ${s.soldObject}` : null,
    s.description ? `Description : ${s.description}` : null,
    s.industry ? `Secteur (libellé, parfois approximatif) : ${s.industry}` : null,
    `Demande de l'utilisateur : ${s.userText || "(non précisée)"}`,
    s.direction ? `\nDIRECTION DONNÉE PAR L'UTILISATEUR POUR CE LOGO (prioritaire sur tout le reste, sauf les interdits techniques) : ${s.direction}` : null,
    "",
    `CODES DU MÉTIER : ${s.sector ? s.sector.guide : GENERIC_GUIDE}`,
    s.sector ? `SYMBOLES LOGIQUES POUR CE MÉTIER (choisis-en UN ou fais mieux, mais dans ce monde-là) : ${s.sector.symbols}` : null,
    "",
    "COMMENT FONT LES VRAIES MARQUES : le symbole vient toujours d'UNE de ces sources, et tu dois dire laquelle :",
    "  1. le produit lui-même, stylisé (une chaussure, une tasse, une maison) ;",
    "  2. une partie reconnaissable du produit (une semelle, un lacet, une poche cousue, un grain de café) ;",
    "  3. le geste ou l'usage (la foulée, la découpe, l'envoi d'un message) ;",
    "  4. le sens du NOM de la marque quand il veut dire quelque chose (Apple → une pomme, Shell → un coquillage, Puma → un félin) ;",
    `  5. un monogramme de la VRAIE initiale « ${s.initial} », de préférence fusionné avec un élément du produit.`,
    "",
    "OUI :",
    "- UNE seule idée, UNE forme connectée, nommable en 3 mots par un inconnu.",
    "- Dessinable en 2 à 4 formes géométriques simples. Si l'élément du produit est organique ou compliqué (pâtes, fleur, fumée, cheveux), prends sa silhouette la plus simple et la plus reconnaissable (une fourchette avec des pâtes enroulées, une tasse avec une volute de vapeur) au lieu de le fondre dans une lettre : un inconnu doit reconnaître l'objet sans explication.",
    "- Un lien évident avec ce que vend la marque, que tu expliques en une phrase.",
    "- Vectoriel plat, 1 ou 2 couleurs, lisible à 16 px.",
    "NON :",
    `- Une lettre autre que « ${s.initial} » (un R pour une marque en P est une faute grave). Plusieurs lettres. Un mot.`,
    "- Une forme abstraite générique sans lien avec le métier (boucle, flèche en spirale, graphique, vague, cercles empilés, tourbillon).",
    "- Le symbole d'un AUTRE métier (graphique boursier pour des chaussures, aiguille de couture pour un restaurant).",
    "- Symbole + lettre + ornement empilés ; 3D, dégradé, ombre, or ou chrome, effet photo.",
    s.palette.length
      ? `\nPALETTE IMPOSÉE : ${s.palette.join(", ")} (reprends-la telle quelle).`
      : "\nPALETTE : 1 ou 2 couleurs franches ou foncées. JAMAIS de blanc, crème, beige clair ou gris clair : le fond blanc est retiré, une couleur claire dans le logo deviendrait un trou.",
    failed
      ? `\nUN PREMIER CONCEPT A ÉCHOUÉ : « ${failed.subject} ». Le modèle image n'a pas su le dessiner proprement ; un relecteur a rejeté les essais pour : ${failed.reasons.join(" / ")}. Propose un concept DIFFÉRENT, plus simple et plus littéral (l'objet vendu lui-même, en silhouette), toujours logique pour la marque.`
      : null,
    "",
    'JSON strict (valeurs en anglais sauf "link") : {"kind":"symbol" ou "monogram","subject":"ce que montre le logo, 2 à 6 mots","concept":"description précise et dessinable en 1 ou 2 phrases","link":"pourquoi c\'est logique pour cette marque, 1 phrase en français","palette":["#RRGGBB","#RRGGBB"]}',
  ];
  return { system, user: lines.filter((l): l is string => l !== null).join("\n") };
}

/** Extrait le premier objet JSON d'une réponse (avec ou sans bloc ```). */
export function extractJsonObject(raw: string): any {
  const s = String(raw || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("aucun objet JSON dans la réponse");
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * Le brief prévoit-il de dessiner l'initiale ? « envelope with M fold » est
 * annoncé « symbol » mais décrit un M : sans correction, le relecteur rejette
 * le logo parce qu'il voit… le M demandé (MailFlow, 2026-10-04).
 * A et I sont ignorés seuls (« A flat envelope », « I »), sauf avec « letter ».
 */
export function briefDrawsInitial(text: string, initial: string): boolean {
  if (!initial) return false;
  const words = String(text || "").split(/[^A-Za-z]+/).filter(Boolean);
  const lower = words.map((w) => w.toLowerCase());
  if (lower.some((w) => w === "monogram" || w === "lettermark" || w === "initial")) return true;
  const letterWord = lower.findIndex((w, i) => w === "letter" && words[i + 1] === initial);
  if (letterWord >= 0) return true;
  if (initial === "A" || initial === "I") return false;
  return words.includes(initial);
}

/** Valide le brief. Renvoie une erreur lisible plutôt qu'un brief à moitié vide. */
export function parseLogoBrief(raw: string, s: LogoSignals): { brief: LogoBrief | null; error: string } {
  let obj: any;
  try {
    obj = extractJsonObject(raw);
  } catch (e) {
    return { brief: null, error: `brief illisible : ${(e as Error).message}` };
  }
  const subject = String(obj?.subject || "").trim();
  const concept = String(obj?.concept || "").trim();
  const declared: LogoKind | null = obj?.kind === "monogram" ? "monogram" : obj?.kind === "symbol" ? "symbol" : null;
  const kind: LogoKind | null = declared === "symbol" && briefDrawsInitial(`${subject} ${concept}`, s.initial) ? "monogram" : declared;
  const link = String(obj?.link || "").trim();
  if (!kind) return { brief: null, error: `brief : "kind" invalide (${JSON.stringify(obj?.kind)})` };
  if (!subject || !concept || !link) return { brief: null, error: "brief : subject, concept ou link manquant" };
  if (kind === "monogram" && !s.initial) return { brief: null, error: "brief : monogramme demandé mais la marque n'a pas d'initiale" };
  const proposed = (Array.isArray(obj?.palette) ? obj.palette : String(obj?.palette || "").split(","))
    .map(normalizeHex)
    .filter(usableLogoColor)
    .slice(0, 2);
  const palette = s.palette.length ? s.palette : proposed;
  if (!palette.length) return { brief: null, error: "brief : aucune couleur hex valide et assez foncée" };
  return { brief: { kind, subject, concept, link, palette }, error: "" };
}

// ─── Style + prompt image ───────────────────────────────────────────────────
const PREMIUM_SECTORS = new Set(["automotive", "finance", "realestate", "jewellery", "legal", "leather"]);
const PLAYFUL_SECTORS = new Set(["food", "bakery", "coffee", "kids", "pets"]);

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

export function pickLogoStyle(brief: LogoBrief, s: LogoSignals): string {
  if (brief.kind === "monogram") {
    return `custom monogram of the single letter "${s.initial}" — the real initial of ${s.name} — fused with ${brief.subject} into ONE clean glyph, flat solid fill, precise geometry`;
  }
  const id = s.sector?.id || "";
  const pool = PREMIUM_SECTORS.has(id) ? [0, 4, 7] : PLAYFUL_SECTORS.has(id) ? [1, 5, 6, 7] : LOGO_STYLES.map((_, i) => i).filter((i) => i !== LETTERMARK_STYLE);
  const idx = pool[hash(`${s.name}|${id}|${s.direction}`) % pool.length];
  return LOGO_STYLES[idx];
}

export function buildLogoPrompt(brief: LogoBrief, s: LogoSignals, previousRejection = ""): string {
  const business = [s.subject || s.industry || "a business", s.soldObject ? `selling ${s.soldObject}` : ""].filter(Boolean).join(", ");
  const letterRule =
    brief.kind === "monogram"
      ? ` — the ONLY exception is the single letter "${s.initial}" (the initial of ${s.name}) drawn as part of the mark; no other letter may appear anywhere`
      : "";
  return [
    `Professional flat vector logo mark for the brand "${s.name}" (${business}), designed to the standard of a world-class branding agency.`,
    `THE MARK DEPICTS: ${brief.subject}. Concept: ${brief.concept}.`,
    `It must be immediately logical for this business: a customer seeing it must think of what the brand sells.`,
    `Style: ${pickLogoStyle(brief, s)}.`,
    s.sector ? `Visual codes of the trade: ${s.sector.guide}` : "",
    `Color palette: ${brief.palette.join(", ")} on pure white. Flat solid fills only, 2 colors maximum.`,
    s.direction ? `USER DIRECTION (respect it above all): ${s.direction}.` : "",
    previousRejection ? `A PREVIOUS ATTEMPT WAS REJECTED because: ${previousRejection}. Do not repeat that mistake.` : "",
    `${LOGO_HARD_RULES} in the image${letterRule}.`,
    "Timeless, confident, instantly recognizable.",
  ]
    .filter(Boolean)
    .join(" ");
}

// ─── Relecture du logo ──────────────────────────────────────────────────────
// En DEUX temps, pour que le relecteur ne voie pas ce qu'on « espère » :
//   1. PERCEPTION à l'aveugle (vision) : le relecteur ne connaît ni la marque
//      ni le sujet voulu. Il décrit ce qu'il voit, les lettres qu'il lit, les
//      défauts techniques, et devine pour quels métiers ce logo irait.
//      Premier essai (sujet donné dans le prompt) : il acceptait une pelote
//      de laine verte comme « des pâtes », parce qu'on lui avait dit « pâtes ».
//   2. PERTINENCE (texte) : un second appel compare cette description aveugle
//      à ce que vend la marque.
// Le verdict final est décidé par le code, sur des critères fixes.

export interface LogoPerception {
  seen: string;
  letters: string[];
  words: boolean;
  flat: boolean;
  cluttered: boolean;
  trades: string[];
}

export interface LogoReview {
  ok: boolean;
  /** Ce que le relecteur voit, décrit à l'aveugle. */
  seen: string;
  reason: string;
}

export function logoPerceptionPrompt(): string {
  return [
    "You are a strict senior brand designer. You are shown ONE logo image and you know NOTHING about the brand.",
    "Describe literally what you see, then audit it. Answer in strict JSON:",
    '{"seen":"what the image literally shows, 5 to 15 words, name the object(s) you recognise",',
    '"letters":["each letter or digit a normal viewer would READ as a letter, uppercase; a shape that merely resembles a letter (an envelope flap, a roof) is NOT a letter; [] if none"],',
    '"words":true if any word, name or slogan is written,',
    '"flat":true if it is a clean flat 2D vector logo — one or two solid flat colours are fine; false only for real 3D, gradient, drop shadow, glow, bevel, photo, texture or sketchy lines,',
    '"cluttered":true if it is several disconnected shapes, a random abstract blob, or busy,',
    '"trades":["3 kinds of business this logo would naturally suit, most likely first"]}',
  ].join("\n");
}

export function parseLogoPerception(raw: string): LogoPerception {
  const obj = extractJsonObject(raw);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean);
  return {
    seen: String(obj?.seen || "").trim(),
    letters: list(obj?.letters).map((l) => l.toUpperCase()).filter((l) => l.length === 1),
    words: obj?.words === true,
    flat: obj?.flat === true,
    cluttered: obj?.cluttered === true,
    trades: list(obj?.trades).slice(0, 3),
  };
}

/**
 * Défauts lisibles directement sur la perception (lettres, texte, rendu).
 * Le fond n'est PAS jugé ici : le modèle de vision rejetait des fonds blancs
 * parfaits (Denimora, 2026-10-04). C'est le détourage qui tranche, dans
 * `generateBrandLogo`.
 */
export function perceptionProblems(p: LogoPerception, brief: LogoBrief, s: LogoSignals): string[] {
  const problems: string[] = [];
  const foreign = p.letters.filter((l) => l !== s.initial);
  if (brief.kind === "symbol" && p.letters.length) problems.push(`it contains the letter(s) ${p.letters.join(", ")} although it must be a symbol without letters`);
  else if (brief.kind === "monogram" && foreign.length) problems.push(`it shows the letter(s) ${foreign.join(", ")} instead of only "${s.initial}"`);
  if (brief.kind === "monogram" && !p.letters.includes(s.initial)) problems.push(`the initial "${s.initial}" is not readable`);
  if (p.words) problems.push("it contains written text");
  if (!p.flat) problems.push("it is not a clean flat 2D vector logo");
  if (p.cluttered) problems.push("it is cluttered or made of disconnected shapes");
  return problems;
}

// Le sujet VOULU n'est volontairement pas donné : avec lui, le juge rejetait
// un épi de blé pour une boulangerie parce qu'on « attendait un croissant »
// (La Mie Dorée, 2026-10-04) — et acceptait ce qu'on lui disait d'espérer.
export function logoRelevancePrompts(p: LogoPerception, s: LogoSignals): { system: string; user: string } {
  const business = [s.subject || s.industry, s.soldObject ? `selling ${s.soldObject}` : "", s.description].filter(Boolean).join(" — ");
  return {
    system: "You are a strict brand strategist. You judge whether a logo is LOGICAL for a business. Answer in strict JSON.",
    user: [
      `Brand: ${s.name}. Business: ${business || "unknown"}.`,
      `A reviewer who did NOT know the brand saw: "${p.seen}"${p.letters.length ? ` (letters read: ${p.letters.join(", ")})` : ""}.`,
      `He guessed it would suit: ${p.trades.join(", ") || "nothing in particular"}.`,
      "Question: judging ONLY what the reviewer actually saw, would a customer naturally connect this logo with what the brand sells (its product, a part or ingredient of it, its use, or the meaning of the brand name)?",
      "It does NOT have to match any intended design: a wheat ear for a bakery or a fork for a restaurant is fine.",
      "Answer false if it is generic or abstract, ambiguous, or the symbol of another trade (a ball of yarn for a restaurant, a coffee bean for a bakery, a stock chart for a shoe brand).",
      '{"related":true or false,"reason":"one short sentence"}',
    ].join("\n"),
  };
}

export function parseLogoRelevance(raw: string): { related: boolean; reason: string } {
  const obj = extractJsonObject(raw);
  return { related: obj?.related === true, reason: String(obj?.reason || "").trim() };
}

// ─── Orchestration ──────────────────────────────────────────────────────────
export interface LogoDeps {
  /** Appel texte (brief, jugement de pertinence). Jette en cas d'échec réseau. */
  callText(system: string, user: string, maxTokens: number): Promise<string>;
  /** Génère l'image brute, fond blanc (le détourage vient après la relecture). */
  generateRaw(prompt: string): Promise<RawImage | null>;
  /** Perception vision à l'aveugle : renvoie le texte brut du relecteur. Jette en cas d'échec. */
  review(img: RawImage, prompt: string): Promise<string>;
  /** Retire le fond blanc. ok=false si c'est impossible (fond coloré, panneau…). */
  cutout(img: RawImage): Promise<{ image: RawImage; ok: boolean; reason: string }>;
}

export const MAX_BRIEF_ATTEMPTS = 2;
export const MAX_LOGO_ATTEMPTS = 3;
/** Après ce nombre de rejets sur le MÊME concept, le brief est repensé (même budget d'images). */
export const REDESIGN_AFTER = 2;

export interface LogoAttempt {
  prompt: string;
  review?: LogoReview;
  error?: string;
}

export interface LogoResult {
  image: RawImage | null;
  brief: LogoBrief | null;
  attempts: LogoAttempt[];
  /** Vide en cas de succès ; sinon la raison exacte de l'échec. */
  error: string;
}

export async function designLogoBrief(s: LogoSignals, deps: Pick<LogoDeps, "callText">, failed: FailedConcept | null = null): Promise<{ brief: LogoBrief | null; error: string }> {
  const { system, user } = logoBriefPrompts(s, failed);
  let error = "";
  for (let i = 1; i <= MAX_BRIEF_ATTEMPTS; i++) {
    let raw: string;
    try {
      raw = await deps.callText(system, user, 600);
    } catch (e) {
      error = `appel du brief échoué : ${(e as Error)?.message || e}`;
      console.error(`[logo] ${s.name} — ${error} (essai ${i}/${MAX_BRIEF_ATTEMPTS})`);
      continue;
    }
    const parsed = parseLogoBrief(raw, s);
    if (parsed.brief) return parsed;
    error = parsed.error;
    console.error(`[logo] ${s.name} — ${error} (essai ${i}/${MAX_BRIEF_ATTEMPTS})`);
  }
  return { brief: null, error };
}

/** Perception aveugle (vision) puis pertinence (texte). Jette si un appel échoue. */
export async function reviewLogo(img: RawImage, brief: LogoBrief, s: LogoSignals, deps: Pick<LogoDeps, "review" | "callText">): Promise<LogoReview> {
  const perception = parseLogoPerception(await deps.review(img, logoPerceptionPrompt()));
  const problems = perceptionProblems(perception, brief, s);
  if (problems.length) return { ok: false, seen: perception.seen, reason: problems.join("; ") };
  const { system, user } = logoRelevancePrompts(perception, s);
  const rel = parseLogoRelevance(await deps.callText(system, user, 300));
  if (!rel.related) return { ok: false, seen: perception.seen, reason: `no logical link with what ${s.name} sells: ${rel.reason}` };
  return { ok: true, seen: perception.seen, reason: "" };
}

/**
 * Point d'entrée UNIQUE des trois chemins de génération de logo.
 * Ne renvoie une image que si elle a passé la relecture : un logo illogique
 * (mauvaise lettre, sujet hors métier) n'est jamais livré « faute de mieux ».
 */
export async function generateBrandLogo(input: LogoInput, deps: LogoDeps): Promise<LogoResult> {
  const s = logoSignals(input);
  const first = await designLogoBrief(s, deps);
  if (!first.brief) return { image: null, brief: null, attempts: [], error: first.error };
  let brief: LogoBrief = first.brief;
  console.log(`[logo] ${s.name} — brief ${brief.kind} « ${brief.subject} » (${s.sector?.id || "secteur inconnu"}) : ${brief.link}`);

  const attempts: LogoAttempt[] = [];
  let rejection = "";
  let conceptRejections: string[] = [];
  for (let i = 1; i <= MAX_LOGO_ATTEMPTS; i++) {
    if (conceptRejections.length >= REDESIGN_AFTER) {
      // Le concept lui-même ne passe pas (trop dur à dessiner, illisible) :
      // on en demande un autre plutôt que de brûler le dernier essai dessus.
      const next = await designLogoBrief(s, deps, { subject: brief.subject, reasons: conceptRejections });
      if (next.brief) {
        brief = next.brief;
        rejection = "";
        console.log(`[logo] ${s.name} — brief repensé : ${brief.kind} « ${brief.subject} » : ${brief.link}`);
      } else {
        console.error(`[logo] ${s.name} — brief non repensé (${next.error}), on garde « ${brief.subject} »`);
      }
      conceptRejections = [];
    }
    const prompt = buildLogoPrompt(brief, s, rejection);
    const attempt: LogoAttempt = { prompt };
    attempts.push(attempt);
    const raw = await deps.generateRaw(prompt);
    if (!raw) {
      attempt.error = "aucune image renvoyée par le modèle";
      console.error(`[logo] ${s.name} — essai ${i}/${MAX_LOGO_ATTEMPTS} : ${attempt.error}`);
      continue;
    }
    const cut = await deps.cutout(raw);
    if (!cut.ok) {
      rejection = `the background is not plain pure white, it could not be removed (${cut.reason})`;
      attempt.review = { ok: false, seen: "", reason: rejection };
      conceptRejections.push(rejection);
      console.warn(`[logo] ${s.name} — essai ${i}/${MAX_LOGO_ATTEMPTS} rejeté : ${rejection}`);
      continue;
    }
    let review: LogoReview;
    try {
      review = await reviewLogo(raw, brief, s, deps);
    } catch (e) {
      attempt.error = `relecture impossible : ${(e as Error)?.message || e}`;
      console.error(`[logo] ${s.name} — essai ${i}/${MAX_LOGO_ATTEMPTS} : ${attempt.error}`);
      continue;
    }
    attempt.review = review;
    if (review.ok) {
      console.log(`[logo] ${s.name} — essai ${i} accepté (vu : ${review.seen})`);
      return { image: cut.image, brief, attempts, error: "" };
    }
    rejection = review.reason;
    conceptRejections.push(review.reason);
    console.warn(`[logo] ${s.name} — essai ${i}/${MAX_LOGO_ATTEMPTS} rejeté : ${review.reason} (vu : ${review.seen})`);
  }
  const last = attempts[attempts.length - 1];
  return {
    image: null,
    brief,
    attempts,
    error: `aucun logo valide après ${MAX_LOGO_ATTEMPTS} essais (dernier : ${last?.review?.reason || last?.error || "?"})`,
  };
}
