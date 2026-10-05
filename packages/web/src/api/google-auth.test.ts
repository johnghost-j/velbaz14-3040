import { describe, it, expect } from 'bun:test';
import { googleRedirectUri, parseGoogleProfile, googleAuthUrl, googleAuthConfigured, exchangeGoogleCode, oauthBaseFromHost } from './google-auth';

describe('googleRedirectUri', () => {
  it('construit l\'URL de retour attendue par la console Google', () => {
    expect(googleRedirectUri('https://velbaz.site')).toBe('https://velbaz.site/api/auth/google/callback');
  });
  it('tolère un slash final', () => {
    expect(googleRedirectUri('http://localhost:4200/')).toBe('http://localhost:4200/api/auth/google/callback');
  });
});

describe('parseGoogleProfile', () => {
  it('lit le nom, l\'e-mail et la PHOTO du compte', () => {
    const p = parseGoogleProfile({
      sub: '1234567890', email: 'John@Example.com', email_verified: true,
      name: 'John Mansour', picture: 'https://lh3.googleusercontent.com/a/ABC=s96-c',
    });
    expect(p).not.toBeNull();
    expect(p!.googleId).toBe('1234567890');
    expect(p!.email).toBe('john@example.com'); // normalisé en minuscules
    expect(p!.name).toBe('John Mansour');
    expect(p!.picture).toBe('https://lh3.googleusercontent.com/a/ABC=s96-c');
    expect(p!.emailVerified).toBe(true);
  });

  it('se rabat sur la partie locale de l\'e-mail quand le nom manque', () => {
    const p = parseGoogleProfile({ sub: '1', email: 'jane@example.com' });
    expect(p!.name).toBe('jane');
  });

  it('accepte un compte sans photo (picture vide, pas d\'erreur)', () => {
    const p = parseGoogleProfile({ sub: '1', email: 'a@b.com' });
    expect(p!.picture).toBe('');
  });

  it('refuse un profil sans sub ou sans e-mail', () => {
    expect(parseGoogleProfile({ email: 'a@b.com' })).toBeNull();
    expect(parseGoogleProfile({ sub: '1' })).toBeNull();
    expect(parseGoogleProfile(null)).toBeNull();
  });
});

describe('sans identifiants Google configurés', () => {
  it('googleAuthConfigured est faux et aucune URL n\'est produite', () => {
    // L'environnement de test n'a pas GOOGLE_CLIENT_ID/SECRET : le module doit
    // se désactiver proprement au lieu de produire une URL cassée.
    if (!googleAuthConfigured()) {
      expect(googleAuthUrl({ baseUrl: 'http://localhost:4200', state: 'x' })).toBeNull();
    } else {
      expect(typeof googleAuthUrl({ baseUrl: 'http://localhost:4200', state: 'x' })).toBe('string');
    }
  });

  it('l\'échange de code échoue avec un message en français, sans jeter', async () => {
    if (googleAuthConfigured()) return;
    const r = await exchangeGoogleCode({ code: 'fake', baseUrl: 'http://localhost:4200' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('configurée');
  });
});

describe('googleAuthUrl (quand configuré)', () => {
  it('demande les droits openid/email/profile pour obtenir la photo', () => {
    const url = googleAuthUrl({ baseUrl: 'http://localhost:4200', state: 'abc123' });
    if (!url) return; // instance sans Google : rien à vérifier
    expect(url).toContain('scope=openid+email+profile');
    expect(url).toContain('state=abc123');
    expect(url).toContain('prompt=select_account');
    expect(url).toContain(encodeURIComponent('http://localhost:4200/api/auth/google/callback'));
  });
});

// [2026-09-25] Régression « Accès bloqué : Error 400 redirect_uri_mismatch ».
// La base OAuth se déduisait de APP_BASE_URL (URL de préversion) : depuis
// velbaz.com, Google recevait la redirect_uri de la préversion et refusait la
// connexion. Elle doit suivre l'hôte réellement visité.
describe('oauthBaseFromHost', () => {
  const fallback = 'https://velbaz-preview.runable.site';

  it("suit le domaine visité plutôt que l'URL configurée", () => {
    expect(oauthBaseFromHost({ host: 'velbaz.com', proto: 'https', fallback }))
      .toBe('https://velbaz.com');
    expect(googleRedirectUri(oauthBaseFromHost({ host: 'velbaz.com', proto: 'https', fallback })))
      .toBe('https://velbaz.com/api/auth/google/callback');
  });

  it('garde chaque sous-domaine distinct (www doit être enregistré à part)', () => {
    expect(oauthBaseFromHost({ host: 'www.velbaz.com', proto: 'https', fallback }))
      .toBe('https://www.velbaz.com');
  });

  it('suppose https quand le proxy ne transmet pas le protocole', () => {
    expect(oauthBaseFromHost({ host: 'velbaz.com', proto: '', fallback })).toBe('https://velbaz.com');
  });

  it('reste en http sur le dev local', () => {
    expect(oauthBaseFromHost({ host: 'localhost:4200', proto: null, fallback }))
      .toBe('http://localhost:4200');
  });

  it("ne prend que le premier hôte d'une chaîne de proxys", () => {
    expect(oauthBaseFromHost({ host: 'velbaz.com, internal.local', proto: 'https, http', fallback }))
      .toBe('https://velbaz.com');
  });

  it("ignore l'hôte interne du bac à sable et retombe sur l'URL publique", () => {
    expect(oauthBaseFromHost({ host: '4200-ixt8emoxveckagalgio49.e2b.app', proto: 'https', fallback }))
      .toBe(fallback);
    expect(oauthBaseFromHost({ host: 'e2b.dev', proto: 'https', fallback })).toBe(fallback);
  });

  it("retombe sur l'URL publique quand aucun hôte n'est transmis", () => {
    expect(oauthBaseFromHost({ host: '', proto: '', fallback })).toBe(fallback);
    expect(oauthBaseFromHost({ host: null, proto: null, fallback: fallback + '/' })).toBe(fallback);
  });
});
