import { describe, it, expect } from 'vitest';
import { buildSiteSender, senderLocalPart, cleanDisplayName } from './email-sender';
import { resolveFrom } from './email-provider';

describe('email-sender — expéditeur d\'un site généré', () => {
  it('slug du sous-domaine, sinon du nom (accents retirés)', () => {
    expect(senderLocalPart({ subdomain: 'ma-boutique' })).toBe('ma-boutique');
    expect(senderLocalPart({ name: 'Café Élégance & Co' })).toBe('cafe-elegance-co');
    expect(senderLocalPart({ name: '!!!' })).toBe('contact');
  });

  it('nom d\'affichage nettoyé (pas d\'injection d\'en-tête)', () => {
    expect(cleanDisplayName('Evil"\r\nBcc: x@y.z <a>')).toBe('Evil Bcc: x@y.z a');
  });

  it('adresse configurée prioritaire, nom du site, reply-to config', () => {
    const s = buildSiteSender({ name: 'Ma Boutique' }, { fromEmail: 'hello@maboutique.be', replyTo: 'sav@maboutique.be' }, 'owner@x.com', 'mail.velbaz.app');
    expect(s.from).toBe('"Ma Boutique" <hello@maboutique.be>');
    expect(s.replyTo).toBe('sav@maboutique.be');
  });

  it('SITE_EMAIL_DOMAIN → <slug>@domaine', () => {
    const s = buildSiteSender({ name: 'Ma Boutique', subdomain: 'maboutique' }, null, 'owner@x.com', 'sites.example.com');
    expect(s.address).toBe('maboutique@sites.example.com');
    expect(s.from).toBe('"Ma Boutique" <maboutique@sites.example.com>');
    expect(s.replyTo).toBe('owner@x.com');
  });

  it('sans adresse : nom seul, jamais « Velbaz »', () => {
    const s = buildSiteSender({ name: 'Ma Boutique', websiteLinks: JSON.stringify({ email: 'contact@mb.be' }) }, null, 'owner@x.com', '');
    expect(s.address).toBeNull();
    expect(s.from).toBe('Ma Boutique');
    expect(s.from).not.toMatch(/velbaz/i);
    expect(s.replyTo).toBe('contact@mb.be');
  });

  it('fromName de la config prioritaire sur le nom', () => {
    expect(buildSiteSender({ name: 'X' }, { fromName: 'Atelier Y' }, null, '').displayName).toBe('Atelier Y');
  });
});

describe('resolveFrom — en-tête From', () => {
  const fallback = 'Velbaz <noreply@velbaz.app>';
  it('vide → expéditeur par défaut', () => {
    expect(resolveFrom('', fallback)).toEqual({ header: fallback, explicitAddress: false, displayName: null });
  });
  it('nom seul → nom du site + adresse par défaut', () => {
    const r = resolveFrom('Ma Boutique', fallback);
    expect(r.header).toBe('"Ma Boutique" <noreply@velbaz.app>');
    expect(r.explicitAddress).toBe(false);
  });
  it('adresse seule / Nom <adresse>', () => {
    expect(resolveFrom('a@b.be', fallback)).toMatchObject({ header: 'a@b.be', explicitAddress: true });
    expect(resolveFrom('"Ma Boutique" <a@b.be>', fallback)).toMatchObject({ header: '"Ma Boutique" <a@b.be>', explicitAddress: true, displayName: 'Ma Boutique' });
  });
});
