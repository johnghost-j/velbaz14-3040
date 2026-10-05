import { describe, it, expect } from 'bun:test';
import { checkAvatarFile, squareCrop, ACCEPTED_AVATAR_TYPES, MAX_SOURCE_BYTES } from './avatar-file';

describe('checkAvatarFile', () => {
  it('accepte les formats image courants', () => {
    for (const type of ACCEPTED_AVATAR_TYPES) {
      expect(checkAvatarFile({ type, size: 100_000 }).ok).toBe(true);
    }
  });

  it('refuse un PDF ou un SVG avec un message en français', () => {
    for (const type of ['application/pdf', 'image/svg+xml', 'text/html']) {
      const r = checkAvatarFile({ type, size: 1000 });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('Format non accepté');
    }
  });

  it('refuse une image au-delà de 12 Mo', () => {
    const r = checkAvatarFile({ type: 'image/jpeg', size: MAX_SOURCE_BYTES + 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('trop lourde');
  });

  it('refuse l\'absence de fichier', () => {
    expect(checkAvatarFile(null).ok).toBe(false);
    expect(checkAvatarFile(undefined).ok).toBe(false);
  });
});

describe('squareCrop', () => {
  it('garde le carré centré d\'une image paysage', () => {
    expect(squareCrop(1000, 600)).toEqual({ sx: 200, sy: 0, size: 600 });
  });

  it('garde le carré centré d\'une image portrait', () => {
    expect(squareCrop(600, 1000)).toEqual({ sx: 0, sy: 200, size: 600 });
  });

  it('ne recadre pas une image déjà carrée', () => {
    expect(squareCrop(512, 512)).toEqual({ sx: 0, sy: 0, size: 512 });
  });

  it('renvoie une taille nulle pour une image vide (détecté par l\'appelant)', () => {
    expect(squareCrop(0, 0).size).toBe(0);
  });
});
