/**
 * Tests de la collecte de leads.
 *
 * Ce module reçoit des données d'un endpoint PUBLIC et non authentifié : les
 * cas hostiles (robot, domaine jetable, injection HTML dans le nom) sont donc
 * testés au même titre que le cas nominal.
 */

import { describe, expect, test } from 'bun:test';
import { normalizeLeadEmail, sanitizeLeadMessage, scoreInboundLead, unsubscribeToken, welcomeEmail } from './capture';

describe('sanitizeLeadMessage', () => {
  test('garde le texte et les retours à la ligne', () => {
    expect(sanitizeLeadMessage('  Bonjour,\nje cherche un devis.  ')).toBe('Bonjour,\nje cherche un devis.');
  });

  test('retire les caractères de contrôle et plafonne à 1000', () => {
    expect(sanitizeLeadMessage('a\u0007b')).toBe('ab');
    expect((sanitizeLeadMessage('x'.repeat(5000)) || '').length).toBe(1000);
  });

  test('renvoie null pour vide ou non textuel', () => {
    for (const v of ['', '   ', undefined, null, 5, {}]) expect(sanitizeLeadMessage(v as unknown)).toBeNull();
  });
});

describe('normalizeLeadEmail', () => {
  test('accepte et normalise une adresse valide', () => {
    const r = normalizeLeadEmail('  Jean.Dupont@Exemple.BE  ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.email).toBe('jean.dupont@exemple.be');
    expect(r.domain).toBe('exemple.be');
    expect(r.name).toBeNull();
  });

  test('deux graphies de la même adresse donnent la même clé (déduplication)', () => {
    const a = normalizeLeadEmail('Jean@Site.be');
    const b = normalizeLeadEmail('jean@site.be ');
    expect(a.ok && b.ok && a.email === b.email).toBe(true);
  });

  test('conserve le point et le +tag du local-part', () => {
    // Les « corriger » rendrait un vrai prospect injoignable chez certains
    // fournisseurs qui les traitent comme significatifs.
    const r = normalizeLeadEmail('jean.d+velbaz@exemple.com');
    expect(r.ok && r.email).toBe('jean.d+velbaz@exemple.com');
  });

  test('refuse une valeur absente, vide ou non textuelle', () => {
    for (const v of [undefined, null, '', '   ', 42, {}, []]) {
      const r = normalizeLeadEmail(v as unknown);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('missing');
    }
  });

  test('refuse une valeur trop longue avant même de la valider', () => {
    const r = normalizeLeadEmail('a'.repeat(300) + '@exemple.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_long');
  });

  test('refuse les formats invalides', () => {
    for (const v of ['jean', 'jean@', '@exemple.com', 'jean@exemple', 'je an@exemple.com', 'a@b@c.com']) {
      const r = normalizeLeadEmail(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('bad_format');
    }
  });

  test('refuse les local-parts à points malformés (typiques des robots)', () => {
    for (const v of ['.jean@exemple.com', 'jean.@exemple.com', 'jean..d@exemple.com']) {
      const r = normalizeLeadEmail(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('bad_format');
    }
  });

  test('refuse les domaines jetables', () => {
    const r = normalizeLeadEmail('test@mailinator.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('disposable');
  });

  test('refuse les adresses techniques', () => {
    for (const v of ['noreply@exemple.com', 'postmaster@exemple.com', 'BOUNCES@Exemple.com']) {
      const r = normalizeLeadEmail(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('role_address');
    }
  });

  test('nettoie le nom : chevrons, caractères de contrôle, longueur', () => {
    const r = normalizeLeadEmail('jean@exemple.com', '  <script>alert(1)</script>\u0007Jean  ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).not.toContain('<');
    expect(r.name).not.toContain('>');
    expect(r.name).toContain('Jean');
    // Une balise est retirée entièrement, pas juste ses chevrons : « bJean/b »
    // dans le CRM ferait passer un vrai prospect pour du bruit.
    expect(r.name).toBe('alert(1)Jean');
    const long = normalizeLeadEmail('jean@exemple.com', 'x'.repeat(500));
    expect(long.ok && (long.name || '').length).toBe(200);
  });

  test('un nom vide après nettoyage revient à null', () => {
    const r = normalizeLeadEmail('jean@exemple.com', '<b></b>');
    expect(r.ok && r.name).toBeNull();
  });
});

describe('scoreInboundLead', () => {
  test('un lead entrant part plus haut que le défaut importé (50)', () => {
    expect(scoreInboundLead({})).toBeGreaterThan(50);
  });

  test('un checkout ouvert est le signal le plus fort', () => {
    expect(scoreInboundLead({ checkoutStarted: true })).toBeGreaterThan(scoreInboundLead({ pageviews: 9 }));
  });

  test('plus de pages vues = meilleur score', () => {
    const a = scoreInboundLead({ pageviews: 1 });
    const b = scoreInboundLead({ pageviews: 3 });
    const c = scoreInboundLead({ pageviews: 8 });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  test('le payant est pénalisé face à l’organique', () => {
    expect(scoreInboundLead({ channel: 'paid' })).toBeLessThan(scoreInboundLead({ channel: 'organic' }));
  });

  test('reste toujours dans 1..100', () => {
    const max = scoreInboundLead({ channel: 'organic', pageviews: 50, checkoutStarted: true });
    expect(max).toBeLessThanOrEqual(100);
    expect(max).toBeGreaterThanOrEqual(1);
    expect(scoreInboundLead({ channel: 'paid' })).toBeGreaterThanOrEqual(1);
  });
});

describe('unsubscribeToken', () => {
  test('stable pour la même entrée (un vieux lien doit rester valable)', () => {
    expect(unsubscribeToken('c1', 'jean@exemple.com', 's')).toBe(unsubscribeToken('c1', 'jean@exemple.com', 's'));
  });

  test('insensible à la casse et aux espaces de l’email', () => {
    expect(unsubscribeToken('c1', '  Jean@Exemple.com ', 's')).toBe(unsubscribeToken('c1', 'jean@exemple.com', 's'));
  });

  test('différent par société, par email et par secret', () => {
    const base = unsubscribeToken('c1', 'jean@exemple.com', 's');
    expect(unsubscribeToken('c2', 'jean@exemple.com', 's')).not.toBe(base);
    expect(unsubscribeToken('c1', 'marie@exemple.com', 's')).not.toBe(base);
    expect(unsubscribeToken('c1', 'jean@exemple.com', 'autre')).not.toBe(base);
  });

  test('non devinable : 40 hex, pas l’email en clair', () => {
    const t = unsubscribeToken('c1', 'jean@exemple.com', 's');
    expect(t).toMatch(/^[0-9a-f]{40}$/);
    expect(t).not.toContain('jean');
  });
});

describe('welcomeEmail', () => {
  test('porte le nom de la société, le prénom et le lien de désinscription', () => {
    const m = welcomeEmail({
      companyName: 'ModeAtelier',
      leadName: 'Jean',
      siteUrl: 'https://modeatelier.be',
      unsubscribeUrl: 'https://velbaz.app/u/abc',
    });
    expect(m.subject).toContain('ModeAtelier');
    expect(m.text).toContain('Jean');
    expect(m.html).toContain('ModeAtelier');
    // Exigence RGPD : présent dans les DEUX variantes, pas seulement en HTML.
    expect(m.html).toContain('https://velbaz.app/u/abc');
    expect(m.text).toContain('https://velbaz.app/u/abc');
  });

  test('fonctionne sans nom ni URL de site', () => {
    const m = welcomeEmail({ companyName: 'Velora', unsubscribeUrl: 'https://velbaz.app/u/x' });
    expect(m.html).not.toContain('Revenir sur le site');
    expect(m.text).toContain('Bonjour,');
  });

  test('échappe le HTML venant du nom de la société ou du lead', () => {
    const m = welcomeEmail({
      companyName: '<img src=x onerror=1>Acme',
      leadName: '<b>Jean</b>',
      unsubscribeUrl: 'https://velbaz.app/u/x',
    });
    expect(m.html).not.toContain('<img');
    expect(m.html).not.toContain('<b>Jean');
    expect(m.html).toContain('&lt;img');
  });
});
