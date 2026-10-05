/**
 * Source du module `lib/images.ts` écrit dans chaque projet généré.
 * ---------------------------------------------------------------------------
 * [2026-09-25] Bug signalé par un compte de test : « ça a généré des images
 * très buguées ».
 *
 * Mécanique : le manifeste est un simple `Record<string, string>`, et le
 * prompt de génération de page demande au modèle de n'utiliser QUE les clés
 * fournies. Une règle écrite dans un prompt n'est pas une garantie : le modèle
 * invente régulièrement une clé (`IMAGES.hero_2`, `IMAGES.team_photo`…). Dans
 * ce cas `IMAGES.cle_inventee` vaut `undefined`, donc :
 *
 *   <img src={undefined}>            → icône d'image cassée du navigateur
 *   <Image source={{ uri: undefined }}> → cadre vide en React Native
 *   backgroundImage: url(undefined)  → fond cassé
 *
 * L'`engine` web rattrape une partie du problème après coup en générant de
 * vraies images pour les clés manquantes, mais il ne scanne que certains
 * dossiers, il ne tourne pas sur le build mobile, et il ne couvre pas les clés
 * inventées PLUS TARD lors d'une édition depuis le chat.
 *
 * D'où ce module : le repli est déplacé DANS le projet généré. `IMAGES` devient
 * un Proxy qui renvoie un dégradé neutre pour toute clé inconnue ou vide. Une
 * clé inventée donne alors un visuel discret au lieu d'une image cassée —
 * jamais `undefined`.
 */

/**
 * Dégradé indigo→cyan 96×60, PNG (et non SVG : `<Image>` de React Native ne
 * sait pas afficher un SVG en data URI, donc le même repli doit marcher sur le
 * web ET sur mobile). 558 octets.
 */
export const IMAGE_PLACEHOLDER_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAA8CAMAAACuCk+GAAAAYFBMVEU8tfc/rvdBqvdDqPZEpfZFovZGoPZHnvZInPVJm/VJmvVKmPVLl/VMlfVMlPVNk/VOkvROkPRPjvRQjfRQjPRRivRSifRTh/RUhPNWgfNXf/NYfPNaePJcdfJdcfJga/FGy1QNAAABiUlEQVR42rXUWXaCQBSE4XJCDCqiYgyJZv+7TA9MXRBJtPou4Ktz7sOPb7p7czd3X/Y+66uq6sPd1d67uYu5sizP59PpaK4oDoc8z/f73W5rLsuyN4j9vPMz6/OA3N9g1L895R9G/HDggV896ad4xS87v/jF7w+MvP9FP037A3/xr9P+NvTXkPq7gd8OqP1N7dcD93/5l84/Tvl+QOH389DzE0T1k8QOTORh3H+Qt8A3A+p8hv4Kkf1uQJbP0G8HpP6685dQ55l8P6DMM/luQJpn8u2ANs/kmwFxnr2/avwl1HkmfwF1nsn3A8o89/3Fwg9I80y+HdDmmXwzIM4z+XPI8xn6fiCi7wakeSbfDmjzTL4ZEOe59R0/n0GdZ/KbAV2eya8HhHkm3w8o80y+G5DmmXw7oM0z+WZAnOfanzUHdZ7JdwPSPLMPdZ7D/5iT55N8xPahzjP7UOeZfcjzST5i+1DnmX2o88w+1HlmH+o8sw91ntmHOs/sQ57nwYA6z3wR8jYYiOr/AK4WYWSPqHkGAAAAAElFTkSuQmCC";

/**
 * Clés `IMAGES` réellement utilisées par le code généré.
 *
 * Scanne TOUT le code du projet (hors le manifeste lui-même) et pas seulement
 * `src/pages` + `src/components` : le modèle place aussi des clés dans
 * `src/lib/data.ts`, `src/sections/…`, `App.tsx`… et ces clés-là échappaient
 * au filet de sécurité. Reconnaît l'accès par point ET par crochets.
 */
export function collectImageKeys(files: Iterable<{ path: string; content: string }>): Set<string> {
  const keys = new Set<string>();
  const dotRe = /\bIMAGES\.([A-Za-z_$][\w$]*)\b/g;
  const bracketRe = /\bIMAGES\[\s*["'`]([^"'`]+)["'`]\s*\]/g;
  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(f.path)) continue;
    if (/(^|\/)(lib\/)?images\.ts$/.test(f.path)) continue; // le manifeste lui-même
    let m: RegExpExecArray | null;
    while ((m = dotRe.exec(f.content))) keys.add(m[1]);
    while ((m = bracketRe.exec(f.content))) keys.add(m[1]);
  }
  return keys;
}

// ── Repères de placeholder ───────────────────────────────────────────────────
// [2026-09-25 — 3e passe] « toujours des images buguées ». Les deux passes
// précédentes portaient sur les OCTETS renvoyés par le modèle (contrôle
// qualité + relance + refus de publier une image `fatal`). Vérifié cette fois
// par sonde réelle sur le modèle : la génération ET le ré-encodage WebP sont
// propres (8 images, 3 largeurs, 24/24 `ok`). Le défaut restant est en AVAL :
//
// L'aperçu en direct amorce le manifeste avec un dégradé « photo en cours de
// chargement » pour CHAQUE visuel planifié, puis les vraies images le
// remplacent au fur et à mesure. Mais `generateImageManifest` ne renvoie QUE
// les clés réussies : un visuel refusé par le contrôle qualité (ou raté par le
// fournisseur) gardait donc le dégradé de chargement… DÉFINITIVEMENT, et le
// filet de sécurité ne le rattrapait pas (il ne cherche que les clés ABSENTES
// du manifeste, et la clé était bien là — avec un dégradé dedans).
// Résultat vu par l'utilisateur : des rectangles dégradés plats à la place des
// photos, sur un site par ailleurs terminé. C'est ça, « les images buguées ».
//
// D'où ce repère : tous les placeholders du produit sont fabriqués ici et
// portent un marqueur. Une valeur de manifeste est donc reconnaissable comme
// « pas une vraie image », que ce soit en mémoire ou dans un `images.ts` déjà
// écrit sur disque — c'est ce qui permet de la RÉGÉNÉRER au lieu de la livrer.
export const PLACEHOLDER_MARKER = "velbaz-placeholder";

/**
 * Dégradé SVG de repli, marqué comme placeholder.
 * @param opacity 1 = dégradé franc (repli final), <1 = voile « en chargement »
 */
export function placeholderGradientDataUri(
  c1: string,
  c2: string,
  opacity: [number, number] = [1, 1],
): string {
  const safe = (c: string) => (/^#?[0-9a-fA-F]{3,8}$/.test(c) ? (c.startsWith("#") ? c : `#${c}`) : "#6366f1");
  const a = safe(c1), b = safe(c2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" data-role="${PLACEHOLDER_MARKER}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${a}" stop-opacity="${opacity[0]}"/>` +
    `<stop offset="100%" stop-color="${b}" stop-opacity="${opacity[1]}"/>` +
    `</linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * `true` si cette valeur de manifeste n'est PAS une vraie image : vide,
 * dégradé de repli/chargement, ou repli du Proxy. Sert à repérer les visuels
 * à (re)générer — en mémoire comme dans un `images.ts` déjà écrit.
 */
export function isPlaceholderImage(url: string | undefined | null): boolean {
  if (!url) return true;
  if (url === IMAGE_PLACEHOLDER_DATA_URI) return true;
  const m = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(url.trim());
  if (!m) return false;
  try {
    return Buffer.from(m[1], "base64").toString("utf8").includes(PLACEHOLDER_MARKER);
  } catch {
    return false;
  }
}

/** Toutes les entrées `"clé": "valeur"` d'un `lib/images.ts` existant. */
export function manifestEntriesInSource(source: string): Map<string, string> {
  const out = new Map<string, string>();
  // Une valeur de manifeste ne contient jamais de `"` (base64 ou URL).
  const re = /"(\w+)":\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.set(m[1], m[2]);
  return out;
}

/**
 * Clés déjà présentes dans un `lib/images.ts` existant (patch textuel).
 * Toute valeur de chaîne compte, pas seulement les data URIs : une image
 * hébergée sur un CDN (https://…) est déjà là et n'a pas à être régénérée.
 *
 * [2026-09-25 — 3e passe] Une clé qui ne porte QU'UN PLACEHOLDER n'est plus
 * comptée comme présente : sinon un visuel raté au premier build restait un
 * rectangle dégradé pour toujours, y compris après une édition qui touche la
 * page où il s'affiche.
 */
export function manifestKeysInSource(source: string): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of manifestEntriesInSource(source)) {
    if (isPlaceholderImage(value)) continue;
    keys.add(key);
  }
  return keys;
}

/**
 * Régénère les visuels du manifeste qui ne portent QU'UN placeholder, en place.
 *
 * [2026-09-25 — 3e passe] Extrait du moteur pour être ÉPROUVABLE : c'est le
 * rattrapage qui empêche un visuel raté au 1er essai d'être livré en rectangle
 * dégradé. `regenerate` reçoit les clés à refaire et rend `clé → image` (une
 * clé absente de sa réponse, ou encore placeholder, reste manquante).
 *
 * @param urls       manifeste muté en place (les vraies images remplacent les dégradés)
 * @param regenerate générateur réel (`generateMissingImages` en production)
 * @returns les clés tentées et celles qui restent sans vraie image
 */
export async function retryPlaceholderImages(
  urls: Record<string, string>,
  regenerate: (keys: string[]) => Promise<Record<string, string>>,
  onProgress?: (msg: string) => void,
): Promise<{ attempted: string[]; unresolved: string[] }> {
  const attempted = Object.keys(urls).filter((k) => isPlaceholderImage(urls[k]));
  if (!attempted.length) return { attempted, unresolved: [] };
  onProgress?.(`🔁 ${attempted.length} visuel(s) manqué(s) au 1er essai, nouvelle génération…`);
  let retried: Record<string, string> = {};
  try {
    retried = await regenerate(attempted);
  } catch (e: any) {
    // Un échec de relance ne doit jamais faire tomber le build : on garde les
    // dégradés déjà en place et on le dit.
    onProgress?.(`⚠️ Relance des visuels impossible: ${e?.message || e}`);
  }
  for (const [k, v] of Object.entries(retried)) {
    // Ne JAMAIS écraser une vraie image par un placeholder renvoyé en repli.
    if (!isPlaceholderImage(v) || isPlaceholderImage(urls[k])) urls[k] = v;
  }
  const unresolved = attempted.filter((k) => isPlaceholderImage(urls[k]));
  if (unresolved.length) {
    onProgress?.(`⚠️ ${unresolved.length} visuel(s) restent un dégradé de repli (génération impossible)`);
  }
  return { attempted, unresolved };
}

// ── Audit RÉTROACTIF des images déjà écrites dans un manifeste ──────────────
// [2026-09-25 — 4e passe] Jusqu'ici, tous les garde-fous étaient EN AMONT : ils
// jugeaient une image au moment de la produire. Rien ne relisait un manifeste
// déjà écrit. Conséquence vérifiée sur un projet construit après les 3 passes
// précédentes : ses 16 visuels, tous annoncés « généré » au build, sont
// REJETÉS par notre propre contrôle quand on les repasse depuis le fichier
// livré (7 `fatal`, 9 `suspect`) — et ils y restaient définitivement, aucun
// chemin du produit ne les relisant jamais. Les placeholders, eux, étaient déjà
// rattrapés (3e passe) ; une vraie image abîmée, non.
//
// D'où cet audit : il relit les OCTETS effectivement présents dans le
// manifeste et rend les clés à régénérer. `inspect` est injecté pour rester
// éprouvable sans dépendre de sharp.

/** Décode une valeur de manifeste en octets, ou `null` si ce n'est pas un data URI image. */
export function manifestImageBytes(url: string | undefined | null): Buffer | null {
  const m = /^data:image\/(webp|png|jpe?g|avif);base64,([A-Za-z0-9+/=]+)$/i.exec(String(url || "").trim());
  if (!m) return null; // URL http (CDN, assets /genesis), SVG de repli, vide…
  try {
    const buf = Buffer.from(m[2], "base64");
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Clés d'un manifeste dont l'image LIVRÉE est refusée par le contrôle qualité.
 *
 * Ne regarde que les images en data URI (les seules dont nous produisons les
 * octets) et ignore les placeholders, traités par `retryPlaceholderImages`.
 *
 * @param inspect contrôle qualité réel (`inspectImageBuffer` en production)
 */
export async function unpublishableManifestKeys(
  urls: Record<string, string>,
  inspect: (buf: Buffer) => Promise<{ ok: boolean; severity: string; reason: string }>,
  /**
   * Gravités à considérer comme non livrables. Par défaut `fatal` SEULEMENT :
   * une image `suspect` (score de bloc élevé) est un heuristique avec ~14 % de
   * faux positifs mesurés, et elle a DÉJÀ survécu aux 3 tentatives + au profil
   * de secours en amont — la refaire coûte une génération pour un gain quasi
   * nul. Une `fatal` (flux tronqué, traînées, illisible) ne doit jamais être
   * livrée, à aucun prix.
   */
  severities: string[] = ["fatal"],
): Promise<Array<{ key: string; severity: string; reason: string }>> {
  const out: Array<{ key: string; severity: string; reason: string }> = [];
  for (const [key, value] of Object.entries(urls)) {
    if (isPlaceholderImage(value)) continue;
    const bytes = manifestImageBytes(value);
    if (!bytes) continue;
    try {
      const verdict = await inspect(bytes);
      if (!verdict.ok && severities.includes(verdict.severity)) {
        out.push({ key, severity: verdict.severity, reason: verdict.reason });
      }
    } catch {
      // Un contrôle qui échoue ne doit pas condamner l'image : on la garde.
    }
  }
  return out;
}

/**
 * Remplace dans `urls` les images refusées par le contrôle qualité, en place.
 * Même contrat que `retryPlaceholderImages`, mais pour les VRAIES images
 * abîmées déjà présentes. Une régénération qui échoue laisse l'image en place :
 * une image moche vaut mieux qu'un trou dans un site déjà livré.
 */
export async function repairUnpublishableImages(
  urls: Record<string, string>,
  inspect: (buf: Buffer) => Promise<{ ok: boolean; severity: string; reason: string }>,
  regenerate: (keys: string[]) => Promise<Record<string, string>>,
  onProgress?: (msg: string) => void,
  severities: string[] = ["fatal"],
): Promise<{ rejected: string[]; repaired: string[] }> {
  const bad = await unpublishableManifestKeys(urls, inspect, severities);
  if (!bad.length) return { rejected: [], repaired: [] };
  const rejected = bad.map((b) => b.key);
  const fatals = bad.filter((b) => b.severity === "fatal").length;
  onProgress?.(
    `🔎 ${rejected.length} visuel(s) livré(s) refusé(s) par le contrôle qualité` +
    `${fatals ? ` (dont ${fatals} illisible(s)/abîmé(s))` : ""} — nouvelle génération…`,
  );
  let redone: Record<string, string> = {};
  try {
    redone = await regenerate(rejected);
  } catch (e: any) {
    onProgress?.(`⚠️ Régénération des visuels abîmés impossible: ${e?.message || e}`);
    return { rejected, repaired: [] };
  }
  const repaired: string[] = [];
  for (const [k, v] of Object.entries(redone)) {
    // Ne jamais remplacer une vraie image (même moche) par un placeholder.
    if (!v || isPlaceholderImage(v)) continue;
    if (v === urls[k]) continue;
    urls[k] = v;
    repaired.push(k);
  }
  onProgress?.(
    repaired.length
      ? `✅ ${repaired.length}/${rejected.length} visuel(s) abîmé(s) remplacé(s)`
      : `⚠️ Aucun des ${rejected.length} visuel(s) abîmé(s) n'a pu être remplacé — images conservées`,
  );
  return { rejected, repaired };
}

/**
 * Écrit `entries` dans un `lib/images.ts` existant SANS re-sérialiser tout le
 * manifeste (souvent plusieurs Mo de base64).
 *
 * [2026-09-25 — 3e passe] Le patch précédent insérait TOUJOURS les clés
 * derrière l'ancre, en tête de l'objet. Pour une clé DÉJÀ présente (cas exact
 * d'un placeholder qu'on vient de régénérer), l'objet littéral se retrouvait
 * avec la clé deux fois — et en JS c'est la DERNIÈRE qui gagne, donc le
 * placeholder écrasait la vraie image tout juste générée. On remplace donc la
 * valeur sur place quand la clé existe, et on n'insère que le reste.
 *
 * @returns la nouvelle source, ou `null` si l'ancre est introuvable (l'appelant
 *          doit alors réécrire le module en entier).
 */
export function patchImagesManifestSource(
  source: string,
  entries: Record<string, string>,
): string | null {
  let out = source;
  const toInsert: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(entries)) {
    const existing = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
    if (existing.test(out)) out = out.replace(existing, (_m, head) => `${head}${JSON.stringify(value)}`);
    else toInsert.push([key, value]);
  }
  if (!toInsert.length) return out;
  if (!MANIFEST_INSERT_ANCHOR.test(out)) return null;
  const block = toInsert.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
  return out.replace(MANIFEST_INSERT_ANCHOR, (match) => `${match}\n${block}`);
}

/**
 * Ancre pour insérer de nouvelles clés dans un `lib/images.ts` existant sans
 * re-sérialiser tout le manifeste (souvent plusieurs Mo de base64).
 * Accepte le format actuel (`const RAW = {`) ET l'ancien (`export const
 * IMAGES = {`), sinon un projet généré avant [2026-09-25] verrait son
 * manifeste ENTIÈREMENT remplacé par les seules nouvelles clés.
 */
export const MANIFEST_INSERT_ANCHOR =
  /(?:const RAW: Record<string, string> = \{|export const IMAGES: Record<string, string> = \{)/;

/**
 * Code source du module `IMAGES` d'un projet généré.
 * @param urls   clé → data URI / URL de l'image générée
 * @param header commentaire d'en-tête (formulation web ou mobile)
 */
export function imagesModuleSource(
  urls: Record<string, string> = {},
  header = "// Visuels générés par l'IA. Clés stables réutilisables dans les pages.",
): string {
  return (
    `${header}\n` +
    `// Une clé absente du manifeste renvoie ce dégradé de repli, jamais\n` +
    `// \`undefined\` : sinon <img src={undefined}> afficherait une image cassée.\n` +
    `const PLACEHOLDER = ${JSON.stringify(IMAGE_PLACEHOLDER_DATA_URI)};\n\n` +
    `const RAW: Record<string, string> = ${JSON.stringify(urls, null, 2)};\n\n` +
    `// Propriétés d'objet à laisser passer telles quelles : les intercepter\n` +
    `// casserait \`\${IMAGES}\`, JSON.stringify(IMAGES) ou un await accidentel.\n` +
    `const PASSTHROUGH = new Set([\n` +
    `  "then", "toJSON", "constructor", "toString", "valueOf",\n` +
    `  "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",\n` +
    `  "toLocaleString", "__proto__",\n` +
    `]);\n\n` +
    `export const IMAGES: Record<string, string> = new Proxy(RAW, {\n` +
    `  get(target, key) {\n` +
    `    if (typeof key !== "string") return (target as any)[key];\n` +
    `    const value = (target as any)[key];\n` +
    `    if (typeof value === "string" && value.length > 0) return value;\n` +
    `    if (PASSTHROUGH.has(key)) return (target as any)[key];\n` +
    `    return PLACEHOLDER;\n` +
    `  },\n` +
    `});\n`
  );
}
