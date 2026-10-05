import { describe, it, expect } from 'bun:test';
import {
  emailHash, gravatarUrl, normalizeGoogleAvatar, checkAvatarUpload,
  resolveAvatar, initialsOf, isExplicitSource, MAX_AVATAR_BYTES,
} from './avatar';

// Petite data URL PNG valide (1×1 transparent).
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('emailHash / gravatarUrl', () => {
  it('normalise l\'e-mail (casse et espaces) avant de hacher', () => {
    expect(emailHash('  John@Example.COM ')).toBe(emailHash('john@example.com'));
  });

  it('demande 404 quand le compte n\'a pas de photo (pas d\'image grise générique)', () => {
    const url = gravatarUrl('john@example.com');
    expect(url).toContain('d=404');
    expect(url).toContain('s=256');
    expect(url).toContain(emailHash('john@example.com'));
  });
});

describe('normalizeGoogleAvatar', () => {
  it('remplace la taille suffixée par 256', () => {
    expect(normalizeGoogleAvatar('https://lh3.googleusercontent.com/a/ABC=s96-c')).toBe('https://lh3.googleusercontent.com/a/ABC=s256-c');
  });

  it('remplace la taille dans le chemin', () => {
    expect(normalizeGoogleAvatar('https://lh3.googleusercontent.com/a/s96-c/ABC')).toBe('https://lh3.googleusercontent.com/a/s256-c/ABC');
  });

  it('laisse intacte une URL sans indication de taille', () => {
    expect(normalizeGoogleAvatar('https://example.com/photo.jpg')).toBe('https://example.com/photo.jpg');
  });

  it('ne casse pas sur une valeur vide', () => {
    expect(normalizeGoogleAvatar('')).toBe('');
  });
});

describe('checkAvatarUpload', () => {
  it('accepte une image PNG valide', () => {
    const r = checkAvatarUpload(PNG_1PX);
    expect(r.ok).toBe(true);
    expect(r.mime).toBe('image/png');
  });

  it('refuse ce qui n\'est pas une data URL', () => {
    expect(checkAvatarUpload('https://example.com/p.png').ok).toBe(false);
    expect(checkAvatarUpload('').ok).toBe(false);
    expect(checkAvatarUpload(null).ok).toBe(false);
    expect(checkAvatarUpload(42).ok).toBe(false);
  });

  it('refuse un type non image (protection contre le SVG/HTML injecté)', () => {
    const r = checkAvatarUpload('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('non accepté');
  });

  it('refuse une image trop lourde', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((MAX_AVATAR_BYTES + 50_000) * 4 / 3));
    const r = checkAvatarUpload(big);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('trop lourde');
  });

  it('donne un message d\'erreur en français, affichable tel quel', () => {
    for (const bad of ['', 'nope', 'data:text/html;base64,PGI+']) {
      const r = checkAvatarUpload(bad);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
      expect(r.error!.length).toBeGreaterThan(5);
    }
  });
});

describe('isExplicitSource', () => {
  it('reconnaît un choix de l\'utilisateur', () => {
    expect(isExplicitSource('upload')).toBe(true);
    expect(isExplicitSource('google')).toBe(true);
  });
  it('ne compte pas la détection automatique comme un choix', () => {
    expect(isExplicitSource('gravatar')).toBe(false);
    expect(isExplicitSource(null)).toBe(false);
    expect(isExplicitSource(undefined)).toBe(false);
  });
});

describe('resolveAvatar', () => {
  const never = async () => { throw new Error('ne doit pas être appelé'); };

  it('garde la photo envoyée par l\'utilisateur sans aucun appel réseau', async () => {
    const r = await resolveAvatar({ avatarUrl: PNG_1PX, avatarSource: 'upload', email: 'a@b.com' }, never);
    expect(r.url).toBe(PNG_1PX);
    expect(r.source).toBe('upload');
    expect(r.changed).toBe(false);
  });

  it('garde la photo Google sans la remplacer par Gravatar', async () => {
    const g = 'https://lh3.googleusercontent.com/a/ABC=s256-c';
    const r = await resolveAvatar({ avatarUrl: g, avatarSource: 'google', email: 'a@b.com' }, never);
    expect(r.url).toBe(g);
    expect(r.source).toBe('google');
  });

  it('ne re-vérifie pas un Gravatar déjà connu', async () => {
    const r = await resolveAvatar({ avatarUrl: 'https://www.gravatar.com/avatar/x', avatarSource: 'gravatar', email: 'a@b.com' }, never);
    expect(r.source).toBe('gravatar');
    expect(r.changed).toBe(false);
  });

  it('détecte une photo Gravatar quand rien n\'est stocké, et signale l\'enregistrement', async () => {
    const r = await resolveAvatar({ email: 'a@b.com' }, async () => 'https://www.gravatar.com/avatar/found');
    expect(r.url).toBe('https://www.gravatar.com/avatar/found');
    expect(r.source).toBe('gravatar');
    expect(r.changed).toBe(true);
  });

  it('retombe sur l\'initiale (url null) quand aucune photo n\'existe', async () => {
    const r = await resolveAvatar({ email: 'a@b.com' }, async () => null);
    expect(r.url).toBeNull();
    expect(r.source).toBeNull();
    expect(r.changed).toBe(false);
  });

  it('ne tente rien sans e-mail', async () => {
    const r = await resolveAvatar({ email: '' }, never);
    expect(r.url).toBeNull();
  });
});

describe('initialsOf', () => {
  it('prend les deux initiales d\'un nom complet', () => {
    expect(initialsOf('John Mansour')).toBe('JM');
  });
  it('prend une seule lettre pour un prénom seul', () => {
    expect(initialsOf('John')).toBe('J');
  });
  it('se rabat sur l\'e-mail quand il n\'y a pas de nom', () => {
    expect(initialsOf('', 'john.doe@example.com')).toBe('JD');
  });
  it('renvoie U quand il n\'y a rien', () => {
    expect(initialsOf(null, null)).toBe('U');
  });
});
