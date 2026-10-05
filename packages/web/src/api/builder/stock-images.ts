/**
 * Images de STOCK dans les sites générés — interdites par défaut.
 * ---------------------------------------------------------------------------
 * [2026-10-01] Signalé : « l'IA contient des images buguées… par défaut elle
 * ne doit pas choisir des images enregistrées en elle, elle doit GÉNÉRER ».
 *
 * Constaté sur le seul projet livré (SoulStride) :
 *   - `lib/images.ts` contenait une entrée `home_hero` pointant vers une photo
 *     Unsplash (un ordinateur portable avec des graphiques). Le modèle de code
 *     l'avait écrite de mémoire : les modèles connaissent par cœur des
 *     centaines d'URLs Unsplash/Pexels/picsum et les recrachent dès qu'ils
 *     veulent « une photo » ;
 *   - les composants 21st.dev servant de base aux pages embarquent souvent
 *     leurs propres `<img src="https://images.unsplash.com/…">`, recopiés
 *     tels quels dans le site.
 *
 * Une règle de prompt ne suffit pas (cf. images-manifest.ts : le modèle invente
 * quand même). Ce module est donc le filet DÉTERMINISTE :
 *   - `replaceStockImageUrls` remplace chaque URL de stock du code généré par
 *     une clé `IMAGES.xxx` ; le filet « clés manquantes » de l'engine GÉNÈRE
 *     ensuite la vraie image pour cette clé ;
 *   - `stockManifestKeys` repère les entrées de manifeste qui sont du stock,
 *     pour les retirer et les régénérer.
 *
 * Exception : le mode CLONE (« refais ce site ») reprend volontairement les
 * images RÉELLES du site source — l'appelant ne lance pas ce filet dans ce cas.
 */

/** Hébergeurs de photos de stock / d'images de remplissage. */
const STOCK_HOSTS = [
  "unsplash.com", "unsplash.it", "pexels.com", "picsum.photos", "lorempixel.com", "loremflickr.com",
  "placehold.co", "placehold.it", "placeholder.com", "placeholder.pics", "placeimg.com", "placekitten.com",
  "placebear.com", "placecage.com", "fillmurray.com", "dummyimage.com", "fakeimg.pl", "pravatar.cc",
  "randomuser.me", "pixabay.com", "shutterstock.com", "istockphoto.com", "gettyimages.com",
  "freepik.com", "stocksnap.io", "burst.shopify.com", "rawpixel.com", "depositphotos.com",
  "123rf.com", "dreamstime.com", "stock.adobe.com", "ftcdn.net", "gstatic.com/images",
  "images.generated.photos", "thispersondoesnotexist.com", "ui-avatars.com", "robohash.org",
  "dicebear.com",
];

const HOST_ALT = STOCK_HOSTS.map((h) => h.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");

/** Une URL d'image de stock complète (jusqu'au premier guillemet / espace / parenthèse). */
const STOCK_URL_SRC = `https?:\\/\\/(?:[\\w-]+\\.)*(?:${HOST_ALT})[^\\s"'\`)<>]*`;

/** `true` si l'URL vient d'une banque d'images / d'un service de remplissage. */
export function isStockImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return new RegExp(`^\\s*${STOCK_URL_SRC}\\s*$`, "i").test(String(url));
}

/** Clés d'un manifeste `{ clé: url }` dont la valeur est une image de stock. */
export function stockManifestKeys(urls: Record<string, string>): string[] {
  return Object.entries(urls).filter(([, v]) => isStockImageUrl(v)).map(([k]) => k);
}

/** Retire des clés d'un `lib/images.ts` existant (patch textuel, sans re-sérialiser le base64). */
export function removeManifestKeysFromSource(source: string, keys: string[]): string {
  let out = source;
  for (const key of keys) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\n?[ \\t]*"${esc}"\\s*:\\s*"[^"]*",?`, "g"), "");
  }
  // Une virgule orpheline avant l'accolade fermante reste du JS valide, mais
  // une virgule doublée (`,,`) non : on nettoie.
  return out.replace(/,(\s*),/g, ",$1").replace(/\{\s*,/g, "{");
}

function slugify(s: string, max = 36): string {
  return s
    .normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/g, "");
}

/** Chemin relatif vers `lib/images` depuis un fichier du projet (`src/pages/X.tsx` → `../lib/images`). */
export function imagesImportPath(filePath: string): string {
  const parts = filePath.replace(/^\.?\//, "").split("/");
  parts.pop(); // le fichier lui-même
  const srcIdx = parts.indexOf("src");
  const below = srcIdx >= 0 ? parts.slice(srcIdx + 1) : parts;
  return below.length ? `${"../".repeat(below.length)}lib/images` : "./lib/images";
}

function ensureImagesImport(code: string, filePath: string): string {
  if (/import\s*\{[^}]*\bIMAGES\b[^}]*\}\s*from\s*["'][^"']*lib\/images["']/.test(code)) return code;
  const line = `import { IMAGES } from "${imagesImportPath(filePath)}";`;
  const importRe = /^import[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$|^import\s*["'][^"']+["'];?[ \t]*$/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code))) last = m;
  if (last) {
    const at = last.index + last[0].length;
    return `${code.slice(0, at)}\n${line}${code.slice(at)}`;
  }
  // Directive "use client" éventuelle en tête : l'import passe après.
  const directive = /^(\s*["']use (client|strict)["'];?\s*\n)/.exec(code);
  if (directive) return `${directive[1]}${line}\n${code.slice(directive[1].length)}`;
  return `${line}\n${code}`;
}

export interface StockReplaceResult {
  code: string;
  /** Nouvelles clés `IMAGES` introduites (à générer par l'appelant). */
  keys: string[];
  replaced: number;
}

/**
 * Remplace chaque URL d'image de stock d'un fichier de code par `IMAGES.<clé>`.
 * La clé est descriptive (tirée de l'`alt` voisin quand il existe) parce que
 * le générateur de visuels de secours construit son prompt à partir d'elle.
 *
 * @param taken clés déjà utilisées dans le projet (pour ne pas en écraser une)
 */
export function replaceStockImageUrls(
  code: string,
  filePath: string,
  taken: Set<string> = new Set(),
): StockReplaceResult {
  if (!/\.(tsx|ts|jsx|js)$/.test(filePath) || /(^|\/)lib\/(images|audio)\.ts$/.test(filePath)) {
    return { code, keys: [], replaced: 0 };
  }
  if (!new RegExp(STOCK_URL_SRC, "i").test(code)) return { code, keys: [], replaced: 0 };

  const base = slugify(filePath.split("/").pop()!.replace(/\.(tsx|ts|jsx|js)$/, ""), 20) || "page";
  const keys: string[] = [];
  const byUrl = new Map<string, string>();
  let n = 0;
  const keyFor = (url: string, around: string): string => {
    const known = byUrl.get(url);
    if (known) return known;
    const alt = /\balt\s*=\s*\{?\s*["'`]([^"'`]{3,80})["'`]/.exec(around)?.[1]
      ?? /\b(?:alt|title|name|label)\s*:\s*["'`]([^"'`]{3,80})["'`]/.exec(around)?.[1];
    const hint = alt ? slugify(alt, 28) : "";
    let key = "";
    do {
      n++;
      key = hint ? `${base}_${hint}${n > 1 ? `_${n}` : ""}` : `${base}_photo_${n}`;
    } while (taken.has(key) || keys.includes(key));
    keys.push(key);
    taken.add(key);
    byUrl.set(url, key);
    return key;
  };
  const ctx = (src: string, idx: number) => src.slice(Math.max(0, idx - 240), idx + 240);
  let out = code;
  let replaced = 0;
  const url = STOCK_URL_SRC;

  // 1) Tailwind `bg-[url('…')]` : impossible à brancher sur IMAGES → retiré
  //    (le fond retombe sur les couleurs du thème).
  out = out.replace(new RegExp(`\\s?bg-\\[url\\(['"]?${url}['"]?\\)\\]`, "gi"), () => { replaced++; return ""; });
  // 2) CSS `"url(…)"` en chaîne → template littéral.
  out = out.replace(new RegExp(`(["'\`])url\\(\\s*['"]?(${url})['"]?\\s*\\)\\1`, "gi"), (m, _q, u, off, src) => {
    replaced++;
    return `\`url(\${IMAGES.${keyFor(u, ctx(src, off))}})\``;
  });
  // 3) Attribut JSX `src="…"` / `src={"…"}`.
  out = out.replace(new RegExp(`(\\b[\\w-]+=)(?:"(${url})"|'(${url})'|\\{\\s*["'\`](${url})["'\`]\\s*\\})`, "gi"), (m, attr, a, b, c, off, src) => {
    replaced++;
    return `${attr}{IMAGES.${keyFor(a || b || c, ctx(src, off))}}`;
  });
  // 4) Littéral de chaîne seul (`image: "…"`, tableau de données…).
  out = out.replace(new RegExp(`(["'\`])(${url})\\1`, "gi"), (m, _q, u, off, src) => {
    replaced++;
    return `IMAGES.${keyFor(u, ctx(src, off))}`;
  });
  // 5) Reste noyé dans un texte plus long (template avec d'autres choses…) :
  //    on n'y touche pas syntaxiquement, on remplace juste l'URL par une
  //    interpolation quand on est dans un template, sinon on la supprime.
  out = out.replace(new RegExp(url, "gi"), () => { replaced++; return ""; });

  if (keys.length) out = ensureImagesImport(out, filePath);
  return { code: out, keys, replaced };
}

/**
 * Applique `replaceStockImageUrls` à un ensemble de fichiers, EN PLACE.
 * @returns les fichiers modifiés et les nouvelles clés à générer.
 */
export function replaceStockImagesInFiles(
  files: Array<{ path: string; content: string }>,
  taken: Set<string> = new Set(),
): { changedPaths: string[]; keys: string[]; replaced: number } {
  const changedPaths: string[] = [];
  const keys: string[] = [];
  let replaced = 0;
  for (const f of files) {
    const r = replaceStockImageUrls(f.content, f.path, taken);
    if (!r.replaced) continue;
    f.content = r.code;
    changedPaths.push(f.path);
    keys.push(...r.keys);
    replaced += r.replaced;
  }
  return { changedPaths, keys, replaced };
}
