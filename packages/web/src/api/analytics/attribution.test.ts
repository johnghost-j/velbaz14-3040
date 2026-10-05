import { describe, expect, it } from 'bun:test';
import { attribute, detectDevice, isBot, normalizePath } from './attribution';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1 Mobile/15E148 Safari/604.1';

describe('attribute — canal', () => {
  it('sans referrer ni utm → direct', () => {
    expect(attribute({ url: 'https://shop.test/', userAgent: CHROME }).channel).toBe('direct');
  });

  it('referrer Google → organic', () => {
    expect(attribute({ referrer: 'https://www.google.com/search?q=x', url: 'https://shop.test/', userAgent: CHROME }).channel).toBe('organic');
  });

  it('referrer Instagram → social', () => {
    expect(attribute({ referrer: 'https://l.instagram.com/', url: 'https://shop.test/', userAgent: IPHONE }).channel).toBe('social');
  });

  it('utm_medium=cpc → paid', () => {
    const a = attribute({ url: 'https://shop.test/?utm_source=google&utm_medium=cpc&utm_campaign=launch', userAgent: CHROME });
    expect(a.channel).toBe('paid');
    expect(a.utmCampaign).toBe('launch');
  });

  it('gclid seul → paid google_ads', () => {
    const a = attribute({ url: 'https://shop.test/?gclid=abc123', userAgent: CHROME });
    expect(a.channel).toBe('paid');
    expect(a.utmSource).toBe('google_ads');
  });

  it('fbclid seul → paid meta_ads', () => {
    const a = attribute({ url: 'https://shop.test/?fbclid=xyz', userAgent: CHROME });
    expect(a.channel).toBe('paid');
    expect(a.utmSource).toBe('meta_ads');
  });

  it('utm_medium=email → email', () => {
    expect(attribute({ url: 'https://shop.test/?utm_source=nurture&utm_medium=email', userAgent: CHROME }).channel).toBe('email');
  });

  it('referrer inconnu → referral', () => {
    const a = attribute({ referrer: 'https://someblog.fr/post', url: 'https://shop.test/', userAgent: CHROME });
    expect(a.channel).toBe('referral');
    expect(a.referrerHost).toBe('someblog.fr');
  });

  it('referrer Velbaz (éditeur) → internal, pas un vrai visiteur', () => {
    expect(attribute({ referrer: 'https://velbaz.com/projects/1', url: 'https://shop.test/', userAgent: CHROME }).channel).toBe('internal');
  });

  it('la pub prime sur le referrer social', () => {
    const a = attribute({ referrer: 'https://facebook.com/', url: 'https://shop.test/?utm_medium=paid_social&utm_source=meta_ads', userAgent: IPHONE });
    expect(a.channel).toBe('paid');
  });

  it('www est retiré du host', () => {
    expect(attribute({ referrer: 'https://www.someblog.fr/', userAgent: CHROME }).referrerHost).toBe('someblog.fr');
  });
});

describe('detectDevice', () => {
  it('iPhone → mobile', () => expect(detectDevice(IPHONE)).toBe('mobile'));
  it('desktop Chrome → desktop', () => expect(detectDevice(CHROME)).toBe('desktop'));
  it('iPad → tablet', () => expect(detectDevice('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('tablet'));
  it('Android sans Mobile → tablet', () => expect(detectDevice('Mozilla/5.0 (Linux; Android 13; SM-X200)')).toBe('tablet'));
  it('UA vide → desktop par défaut', () => expect(detectDevice('')).toBe('desktop'));
});

describe('isBot', () => {
  it('Googlebot est un bot', () => expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true));
  it('curl est un bot', () => expect(isBot('curl/8.4.0')).toBe(true));
  it('Playwright est un bot', () => expect(isBot('Mozilla/5.0 HeadlessChrome/124 Playwright')).toBe(true));
  it('UA absent → traité comme bot', () => expect(isBot(null)).toBe(true));
  it('Chrome réel n’est pas un bot', () => expect(isBot(CHROME)).toBe(false));
  it('GPTBot est un bot', () => expect(isBot('Mozilla/5.0 (compatible; GPTBot/1.0)')).toBe(true));
});

describe('normalizePath', () => {
  it('URL complète → pathname', () => expect(normalizePath('https://shop.test/pricing?a=1#x')).toBe('/pricing'));
  it('racine reste /', () => expect(normalizePath('https://shop.test/')).toBe('/'));
  it('slash final retiré', () => expect(normalizePath('/pricing/')).toBe('/pricing'));
  it('chemin relatif préfixé', () => expect(normalizePath('pricing')).toBe('/pricing'));
  it('vide → /', () => expect(normalizePath('')).toBe('/'));
  it('query strippée', () => expect(normalizePath('/p?utm_source=x')).toBe('/p'));

  // Le chemin doit être relatif au site mesuré, pas à l'hébergement Velbaz :
  // sinon toutes les pages remontent sous « /s/<sous-domaine> » et les agents
  // ne voient plus quelle page est l'accueil.
  it('préfixe d’hébergement /s/<sous-domaine> retiré', () =>
    expect(normalizePath('https://velbaz.app/s/monsite/pricing')).toBe('/pricing'));
  it('accueil du site publié → /', () =>
    expect(normalizePath('https://velbaz.app/s/monsite')).toBe('/'));
  it('accueil avec slash final → /', () =>
    expect(normalizePath('https://velbaz.app/s/monsite/')).toBe('/'));
  it('préfixe interne /api/s/<sous-domaine> retiré', () =>
    expect(normalizePath('http://localhost:4200/api/s/monsite/a/b?x=1')).toBe('/a/b'));
  it('une page nommée « s » du site n’est pas confondue avec le préfixe', () =>
    expect(normalizePath('https://shop.test/services')).toBe('/services'));
});
