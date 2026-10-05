/**
 * Upload d'une image data-URI → URL publique (commande `upload` du sandbox).
 * ---------------------------------------------------------------------------
 * [2026-09-25] Les photos produit générées par l'IA sont stockées en base sous
 * forme de data-URI base64 (`product_images.image_data`). Le catalogue injecté
 * dans le site généré (builder/routes.ts) n'accepte QUE des URL http(s) : un
 * data-URI de 2 Mo dans `catalog.ts` ferait exploser le bundle. Résultat, avant
 * ce module, tout produit sans mockup Printify (donc TOUS les produits d'un
 * compte sans token Printify) arrivait dans le site avec `imageUrl: null`, et
 * le générateur de page comblait le vide avec des visuels de contenu
 * génériques — des images qui n'ont aucun rapport avec le produit vendu.
 *
 * Ce module transforme ces data-URI en vraies URL publiques, avec un cache en
 * mémoire par identifiant de ligne pour ne pas re-uploader la même image à
 * chaque build.
 */

/**
 * Cache par clé. On mémorise la *promesse* et non l'URL : deux demandes
 * simultanées pour la même photo (le catalogue et la génération de page
 * tournent en parallèle) partagent ainsi le même upload au lieu d'en lancer
 * deux, ce qui produisait deux URL différentes pour une même image.
 */
const cache = new Map<string, Promise<string>>();

/**
 * Renvoie l'URL publique d'un data-URI image, ou '' si l'upload échoue.
 *
 * L'upload passe par `execFile` (asynchrone) et NON par `execSync` : le
 * catalogue d'une boutique peut contenir 30 produits, et 30 `execSync` d'une
 * seconde chacun bloqueraient la boucle d'événements de Bun — donc TOUTE l'API,
 * pour tout le monde — pendant une demi-minute. Ici l'attente est rendue au
 * runtime, et les appels peuvent se chevaucher.
 */
export async function uploadDataUriToPublicUrl(dataUri: string, label = "img"): Promise<string> {
  try {
    const m = dataUri.match(/^data:image\/([\w+.-]+);base64,(.+)$/s);
    if (!m) return "";
    // Liste blanche : jamais d'extension arbitraire (« image/php » → .php).
    if (!/^(png|jpe?g|webp|gif|avif|svg\+xml)$/i.test(m[1])) return "";
    // 20 Mo max (base64 ≈ 4/3 de la taille réelle).
    if (m[2].length > 27_000_000) return "";
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const raw = m[1].toLowerCase();
    const ext = raw === "jpeg" ? "jpg" : raw === "svg+xml" ? "svg" : raw;
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "img";
    const tmpFile = path.join(os.tmpdir(), `velbaz_${safeLabel}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
    await fs.writeFile(tmpFile, Buffer.from(m[2], "base64"));
    let url = "";
    try {
      // execFile + tableau d'arguments : aucun passage par le shell, donc un
      // chemin de fichier inattendu ne peut pas être interprété comme commande.
      const { stdout } = await promisify(execFile)("upload", [tmpFile], { encoding: "utf-8", timeout: 120000 });
      url = String(stdout).trim();
    } finally {
      await fs.unlink(tmpFile).catch(() => { /* fichier temporaire déjà parti */ });
    }
    return url.startsWith("http") ? url : "";
  } catch (e) {
    console.error("[cdn-upload] échec:", e);
    return "";
  }
}

/**
 * Même chose, mais mémorisée : la 2ᵉ demande pour la même clé (ex. l'id de la
 * ligne `product_images`) réutilise l'URL déjà obtenue. Un rebuild du site ne
 * re-téléverse donc pas les mêmes photos produit.
 */
export async function publicUrlForDataUri(key: string, dataUri: string, label = "img"): Promise<string> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = uploadDataUriToPublicUrl(dataUri, label);
  cache.set(key, pending);
  const url = await pending;
  // Un échec n'est pas mis en cache : le prochain build retentera l'upload.
  if (!url) cache.delete(key);
  return url;
}

/** Vide le cache (tests). */
export function __clearCdnUploadCache(): void {
  cache.clear();
}
