// ─── Remplacement d'image par la photo de l'utilisateur (voie rapide) ───────
// [2026-10-01] Bug signalé : « mets cette image à la place de la première
// image du site » a pris ~16 minutes et n'a même pas utilisé la photo envoyée.
// Causes :
//   1. la pièce jointe n'arrivait jamais jusqu'à l'édition (seul le texte
//      était transmis) → l'IA a « généré » une image de remplacement ;
//   2. le planificateur a choisi de réécrire `src/lib/images.ts` — un manifeste
//      de plusieurs centaines de Ko de base64 — via le modèle de code : appel
//      gigantesque, très lent, et sortie tronquée.
// Ici, tout est déterministe : on choisit la clé d'image visée, on compresse
// la photo, on patche UNE valeur du manifeste. Quelques secondes, zéro IA
// (sauf un petit arbitrage JSON quand la phrase ne désigne aucune image).

export interface ProjectFileLike { path: string; content: string }
export interface UserImage { name?: string; mimeType?: string; data: string }

const IMG_WORD = /\b(image|images|photo|photos|visuel|visuels|picture|pic|img|illustration|banni[èe]re|banner|fond|background|couverture|cover|logo)\b/i;
const SWAP_VERB = /\b(met|mets|mettre|metre|remplace|remplacer|change|changer|utilise|utiliser|place|placer|ins[èe]re|ins[ée]rer|ajoute|ajouter|swap|replace|use|put|set)\b|[àa] la place/i;
// « fais une image comme celle-ci » = référence de style, pas un remplacement.
const STYLE_REF = /\b(comme|similaire|ressemble|inspir|style de|dans le style|g[ée]n[èe]re|g[ée]n[ée]rer|cr[ée]e une image|like this|similar|inspired)\b/i;

/** La phrase demande-t-elle de poser l'image jointe sur le site ? */
export function isImageSwapRequest(message: string): boolean {
  const m = String(message || "");
  if (m.length > 400) return false;
  if (STYLE_REF.test(m)) return false;
  return IMG_WORD.test(m) && SWAP_VERB.test(m);
}

/** Pièces jointes images exploitables (data URI image/*). */
export function imageAttachments(attachments: any): UserImage[] {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a: any) => a && typeof a.data === "string" && /^data:image\/[\w+.-]+;base64,/.test(a.data))
    .map((a: any) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));
}

const isManifest = (p: string) => /(^|\/)lib\/images\.ts$/.test(p);
const KEY_RE = /\bIMAGES(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])/g;

/** Pages routées depuis App.tsx (même logique que l'éditeur, version courte). */
function homeFileOf(files: ProjectFileLike[]): string {
  const app = files.find(f => f.path === "src/App.tsx")?.content || "";
  const imports = new Map<string, string>();
  let m: RegExpExecArray | null;
  const importRe = /import\s+(\w+)\s+from\s+["'](?:\.\/|\.\.\/)*pages\/(\w+)["']/g;
  while ((m = importRe.exec(app))) imports.set(m[1], m[2]);
  const homeRoute = /<Route\s+(?:index\b[^>]*|path=["']\/["'][^>]*)element=\{<(\w+)/.exec(app);
  if (homeRoute && imports.has(homeRoute[1])) return `src/pages/${imports.get(homeRoute[1])}.tsx`;
  return files.some(f => f.path === "src/pages/Home.tsx") ? "src/pages/Home.tsx" : "";
}

/** Clés d'image dans l'ordre d'affichage approximatif d'un fichier : les
 *  usages situés dans le JSX (après le premier `return (`) passent avant les
 *  données déclarées en haut du fichier. Les composants importés et rendus
 *  (ex. <Hero />) sont dépliés à leur position. */
export function orderedKeysForPage(path: string, files: ProjectFileLike[], depth = 0, seen = new Set<string>()): string[] {
  const file = files.find(f => f.path === path);
  if (!file || seen.has(path) || depth > 3) return [];
  seen.add(path);
  const src = file.content;
  const jsxStart = Math.max(0, src.search(/return\s*\(\s*</));
  const events: Array<{ at: number; keys: string[] }> = [];
  let m: RegExpExecArray | null;
  KEY_RE.lastIndex = 0;
  while ((m = KEY_RE.exec(src))) {
    const key = m[1] || m[2];
    events.push({ at: m.index < jsxStart ? m.index + src.length : m.index, keys: [key] });
  }
  // Composants locaux importés puis rendus dans le JSX.
  const importRe = /import\s+(\w+)\s+from\s+["']((?:\.\.?\/)+[\w/.-]+)["']/g;
  const dir = path.split("/").slice(0, -1);
  while ((m = importRe.exec(src))) {
    const comp = m[1];
    const parts = [...dir];
    for (const seg of m[2].split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop(); else parts.push(seg);
    }
    const base = parts.join("/");
    const target = [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`].find(p => files.some(f => f.path === p));
    if (!target) continue;
    const use = src.indexOf(`<${comp}`, jsxStart);
    if (use < 0) continue;
    events.push({ at: use, keys: orderedKeysForPage(target, files, depth + 1, seen) });
  }
  events.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const e of events) for (const k of e.keys) if (!out.includes(k)) out.push(k);
  return out;
}

const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
const norm = (s: string) => s.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
const HEROISH = /^(hero|banner|banniere|cover|header|main|landing|home_hero|hero_\w+|\w*_hero)$/i;

export interface KeyPick { key: string; reason: string }

/** Choix déterministe de la clé visée. `null` = la phrase ne permet pas de
 *  trancher sans risque (l'appelant peut demander à un petit modèle). */
export function pickImageKey(message: string, files: ProjectFileLike[], manifestKeys: Set<string>): KeyPick | null {
  const msg = norm(message);
  const home = homeFileOf(files);
  const homeKeys = (home ? orderedKeysForPage(home, files) : []).filter(k => manifestKeys.has(k));
  const allUsed = new Set<string>();
  for (const f of files) {
    if (isManifest(f.path) || !/\.(tsx?|jsx?)$/.test(f.path)) continue;
    let m: RegExpExecArray | null;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(f.content))) allUsed.add(m[1] || m[2]);
  }
  const candidates = [...new Set([...homeKeys, ...[...allUsed].filter(k => manifestKeys.has(k))])];
  if (!candidates.length) return null;

  // 1. Le nom de la clé (ou ses mots) apparaît dans la phrase.
  const words = (k: string) => norm(k).split(/[_\W]+/).filter(w => w.length >= 3 && !["home", "image", "images", "img", "photo", "photos", "picture", "pic", "visuel", "visual", "collection", "section"].includes(w));
  const scored = candidates
    .map(k => ({ k, hit: words(k).filter(w => new RegExp(`\\b${w}\\b`).test(msg)).length, total: words(k).length }))
    .filter(s => s.hit > 0)
    .sort((a, b) => b.hit / b.total - a.hit / a.total || b.hit - a.hit);
  if (scored.length && (scored.length === 1 || scored[0].hit / scored[0].total > scored[1].hit / scored[1].total)) {
    return { key: scored[0].k, reason: "nommée dans la demande" };
  }

  // 2. Logo.
  if (/\blogo\b/.test(msg)) {
    const logo = candidates.find(k => /logo/i.test(k));
    return logo ? { key: logo, reason: "logo" } : null;
  }

  // 3. Position.
  const ordered = homeKeys.length ? homeKeys : candidates;
  if (/\b(premiere?|1(?:re|er|ere)?|prmiere|preliere|prelier|principale?|hero|en haut|haut de (?:la )?page|banniere|banner|couverture|cover|fond|first|main|top|accueil|grande)\b/.test(msg)) {
    const hero = ordered.find(k => HEROISH.test(k)) || candidates.find(k => HEROISH.test(k));
    return { key: hero || ordered[0], reason: hero ? "image principale (hero)" : "première image de l'accueil" };
  }
  if (/\b(deuxieme|2e|2eme|seconde?|second)\b/.test(msg) && ordered[1]) return { key: ordered[1], reason: "deuxième image" };
  if (/\b(troisieme|3e|3eme|third)\b/.test(msg) && ordered[2]) return { key: ordered[2], reason: "troisième image" };
  if (/\b(derniere|dernier|last)\b/.test(msg)) return { key: ordered[ordered.length - 1], reason: "dernière image" };

  // 4. Une seule image sur tout le site : pas d'ambiguïté possible.
  if (candidates.length === 1) return { key: candidates[0], reason: "seule image du site" };
  return null;
}

/** Contexte court de chaque clé (alt / texte voisin) pour l'arbitrage IA. */
export function keyContexts(files: ProjectFileLike[], keys: string[]): Array<{ key: string; file: string; context: string }> {
  const out: Array<{ key: string; file: string; context: string }> = [];
  for (const key of keys) {
    for (const f of files) {
      if (isManifest(f.path) || !/\.(tsx?|jsx?)$/.test(f.path)) continue;
      const i = f.content.search(new RegExp(`IMAGES(?:\\.${key}\\b|\\[\\s*["'\`]${key}["'\`])`));
      if (i < 0) continue;
      const ctx = f.content.slice(Math.max(0, i - 220), i + 220).replace(/\s+/g, " ");
      out.push({ key, file: f.path, context: ctx });
      break;
    }
  }
  return out;
}

/** Compresse la photo (WebP, ≤ 2000 px) pour garder le manifeste léger.
 *  Si sharp échoue, renvoie l'original. */
export async function prepareUserImage(img: UserImage, maxWidth = 2000): Promise<string> {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(img.data);
  if (!m) return img.data;
  if (/svg|gif/i.test(m[1])) return img.data; // vectoriel / animé : on n'y touche pas
  try {
    const sharp = (await import("sharp")).default;
    const buf = await sharp(Buffer.from(m[2], "base64"))
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return `data:image/webp;base64,${buf.toString("base64")}`;
  } catch {
    return img.data;
  }
}
