// ─── Préparation d'une photo de profil côté navigateur ───────────────────────
// [2026-09-19] Une photo de téléphone pèse plusieurs Mo : on la recadre en
// carré et on la réduit à 256×256 AVANT l'envoi. Le serveur refuse au-delà de
// 700 Ko (cf. api/avatar.ts), et un rond de 56px n'a pas besoin de plus.

/** Types acceptés, alignés sur la validation serveur. */
export const ACCEPTED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Garde-fou d'entrée : au-delà, on refuse avant même de décoder. */
export const MAX_SOURCE_BYTES = 12 * 1024 * 1024; // 12 Mo

export interface AvatarFileResult {
  ok: boolean;
  /** Data URL prête à envoyer à POST /auth/avatar. */
  dataUrl?: string;
  /** Message en français, affichable tel quel. */
  error?: string;
}

/** Vérifie le fichier choisi avant tout traitement. */
export function checkAvatarFile(file: { type?: string; size?: number } | null | undefined): AvatarFileResult {
  if (!file) return { ok: false, error: 'Aucun fichier sélectionné.' };
  const type = (file.type || '').toLowerCase();
  if (!ACCEPTED_AVATAR_TYPES.includes(type)) {
    return { ok: false, error: 'Format non accepté. Choisis une image PNG, JPEG, WebP ou GIF.' };
  }
  if ((file.size || 0) > MAX_SOURCE_BYTES) {
    return { ok: false, error: `Image trop lourde (${Math.round((file.size || 0) / 1024 / 1024)} Mo, maximum 12 Mo).` };
  }
  return { ok: true };
}

/**
 * Calcule le recadrage carré centré d'une image : on garde le plus grand carré
 * possible au centre, pour que le rond de profil ne déforme jamais la photo.
 */
export function squareCrop(width: number, height: number): { sx: number; sy: number; size: number } {
  const size = Math.min(width, height);
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size };
}

/**
 * Recadre en carré + réduit à `out`×`out`, puis renvoie une data URL WebP
 * (repli JPEG si le navigateur ne sait pas encoder en WebP).
 */
export async function prepareAvatarFile(file: File, out = 256): Promise<AvatarFileResult> {
  const pre = checkAvatarFile(file);
  if (!pre.ok) return pre;

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image illisible'));
      el.src = objectUrl;
    });

    const { sx, sy, size } = squareCrop(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (!size) return { ok: false, error: 'Image vide ou illisible.' };

    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: "Ce navigateur ne peut pas traiter l'image." };
    ctx.drawImage(img, sx, sy, size, size, 0, 0, out, out);

    let dataUrl = canvas.toDataURL('image/webp', 0.9);
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    return { ok: true, dataUrl };
  } catch (e: any) {
    return { ok: false, error: `Image illisible (${e?.message || 'format non supporté'}).` };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
