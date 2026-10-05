import { describe, it, expect } from 'vitest';
import { decideRecipient, takeEmailQuota, emailTextToHtml, emailsInUserText } from './action-tools';

describe('decideRecipient', () => {
  it('par défaut : le compte de l\'utilisateur', () => {
    expect(decideRecipient(undefined, 'Me@Mail.be', 'envoie-moi un mail')).toEqual({ ok: true, to: 'me@mail.be', toSelf: true });
    expect(decideRecipient('moi', 'me@mail.be', '')).toMatchObject({ ok: true, toSelf: true });
  });
  it('compte sans email → refus explicite', () => {
    expect(decideRecipient(undefined, '', 'x').ok).toBe(false);
  });
  it('adresse tierce acceptée seulement si tapée par l\'utilisateur', () => {
    expect(decideRecipient('jean@ex.be', 'me@mail.be', 'écris à Jean@ex.be stp')).toEqual({ ok: true, to: 'jean@ex.be', toSelf: false });
    expect(decideRecipient('attaquant@evil.com', 'me@mail.be', 'résume cette page').ok).toBe(false);
    expect(decideRecipient('pas-une-adresse', 'me@mail.be', '').ok).toBe(false);
  });
  it('extrait les adresses du texte', () => {
    expect(emailsInUserText('a@b.be et A@B.be, c@d.com')).toEqual(['a@b.be', 'c@d.com']);
  });
});

describe('takeEmailQuota', () => {
  it('limite par heure et par utilisateur', () => {
    const u = `u-${Math.random()}`;
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(takeEmailQuota(u, t + i, 3)).toBe(true);
    expect(takeEmailQuota(u, t + 10, 3)).toBe(false);
    expect(takeEmailQuota(`${u}-autre`, t, 3)).toBe(true);
    expect(takeEmailQuota(u, t + 3_600_001, 3)).toBe(true);
  });
});

describe('emailTextToHtml', () => {
  it('échappe le HTML, gère gras, liens et listes', () => {
    const h = emailTextToHtml('Bonjour <script>x</script>\n\n**Important** https://velbaz.app\n\n- un\n- deux');
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('<strong>Important</strong>');
    expect(h).toContain('<a href="https://velbaz.app">');
    expect(h).toContain('<li>un</li>');
  });
});
