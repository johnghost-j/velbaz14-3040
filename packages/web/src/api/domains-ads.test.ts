import { describe, expect, test, afterEach } from 'bun:test';
import { planVelbazHosts, splitDomain } from './namecheap';
import { siteHostFromHeaders, EDGE_HOST_HEADER, EDGE_KEY_HEADER } from './domains';
import { clampBudget, MAX_DAILY_BUDGET, DEFAULT_DAILY_BUDGET } from './ad-accounts/service';
import { providerForAdPlatform, metaCta, googleRsaAssets } from './ad-accounts/providers';
import { verifyKeys } from './key-check';

describe('namecheap splitDomain', () => {
  test('apex simple', () => {
    expect(splitDomain('Boutique.com')).toEqual({ sld: 'boutique', tld: 'com', host: '@', apex: 'boutique.com' });
  });
  test('sous-domaine', () => {
    expect(splitDomain('shop.boutique.fr')).toEqual({ sld: 'boutique', tld: 'fr', host: 'shop', apex: 'boutique.fr' });
  });
  test('TLD à deux niveaux', () => {
    expect(splitDomain('www.boutique.co.uk')).toEqual({ sld: 'boutique', tld: 'co.uk', host: 'www', apex: 'boutique.co.uk' });
  });
});

describe('namecheap planVelbazHosts', () => {
  const existing = [
    { name: '@', type: 'A', address: '1.2.3.4', ttl: '1800' },
    { name: 'www', type: 'CNAME', address: 'parking.example.', ttl: '1800' },
    { name: '@', type: 'MX', address: 'mx.mail.example.', mxPref: '10', ttl: '1800' },
    { name: '@', type: 'TXT', address: 'v=spf1 include:mail.example ~all', ttl: '1800' },
    { name: 'blog', type: 'CNAME', address: 'ghost.example.', ttl: '1800' },
  ];

  test('apex : ALIAS @ + CNAME www, MX/TXT et autres sous-domaines gardés', () => {
    const out = planVelbazHosts('boutique.com', 'sites.velbaz.example', existing);
    expect(out.find((h) => h.name === '@' && h.type === 'A')).toBeUndefined();
    expect(out.find((h) => h.name === '@' && h.type === 'ALIAS')?.address).toBe('sites.velbaz.example.');
    expect(out.find((h) => h.name === 'www' && h.type === 'CNAME')?.address).toBe('sites.velbaz.example.');
    expect(out.some((h) => h.type === 'MX')).toBe(true);
    expect(out.some((h) => h.type === 'TXT')).toBe(true);
    expect(out.find((h) => h.name === 'blog')?.address).toBe('ghost.example.');
  });

  test('sous-domaine : un seul CNAME, rien d\'autre touché', () => {
    const out = planVelbazHosts('shop.boutique.com', 'sites.velbaz.example.', existing);
    expect(out.filter((h) => h.name === 'shop')).toEqual([{ name: 'shop', type: 'CNAME', address: 'sites.velbaz.example.', ttl: '300' }]);
    expect(out.find((h) => h.name === '@' && h.type === 'A')?.address).toBe('1.2.3.4');
    expect(out.length).toBe(existing.length + 1);
  });
});

describe('siteHostFromHeaders', () => {
  const prev = process.env.VELBAZ_EDGE_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.VELBAZ_EDGE_SECRET;
    else process.env.VELBAZ_EDGE_SECRET = prev;
  });
  const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()] ?? null;

  test('sans en-tête edge : x-forwarded-host puis host', () => {
    expect(siteHostFromHeaders(headers({ 'x-forwarded-host': 'App.Velbaz.com:443', host: 'internal' }))).toBe('app.velbaz.com');
    expect(siteHostFromHeaders(headers({ host: 'localhost:4200' }))).toBe('localhost');
  });

  test('en-tête edge ignoré sans secret configuré', () => {
    process.env.VELBAZ_EDGE_SECRET = '';
    expect(siteHostFromHeaders(headers({ [EDGE_HOST_HEADER]: 'client.com', [EDGE_KEY_HEADER]: 'x', host: 'origin.example' }))).toBe('origin.example');
  });

  test('en-tête edge ignoré avec une mauvaise clé', () => {
    process.env.VELBAZ_EDGE_SECRET = 'a-very-long-edge-secret-123';
    expect(siteHostFromHeaders(headers({ [EDGE_HOST_HEADER]: 'client.com', [EDGE_KEY_HEADER]: 'wrong', host: 'origin.example' }))).toBe('origin.example');
  });

  test('en-tête edge accepté avec la bonne clé', () => {
    process.env.VELBAZ_EDGE_SECRET = 'a-very-long-edge-secret-123';
    expect(siteHostFromHeaders(headers({ [EDGE_HOST_HEADER]: 'Client.com', [EDGE_KEY_HEADER]: 'a-very-long-edge-secret-123', host: 'origin.example' }))).toBe('client.com');
  });
});

describe('ad accounts helpers', () => {
  test('clampBudget', () => {
    expect(clampBudget(undefined)).toBe(DEFAULT_DAILY_BUDGET);
    expect(clampBudget(-5)).toBe(DEFAULT_DAILY_BUDGET);
    expect(clampBudget('abc')).toBe(DEFAULT_DAILY_BUDGET);
    expect(clampBudget(10_000)).toBe(MAX_DAILY_BUDGET);
    expect(clampBudget(0.3)).toBe(1);
    expect(clampBudget(12.345)).toBe(12.35);
  });

  test('providerForAdPlatform', () => {
    expect(providerForAdPlatform('google')).toBe('google_ads');
    expect(providerForAdPlatform('Instagram')).toBe('meta_ads');
    expect(providerForAdPlatform('facebook')).toBe('meta_ads');
    expect(providerForAdPlatform('tiktok')).toBeNull();
  });

  test('metaCta retombe sur LEARN_MORE', () => {
    expect(metaCta(null)).toBe('LEARN_MORE');
    expect(metaCta('blabla')).toBe('LEARN_MORE');
    expect(typeof metaCta('Acheter maintenant')).toBe('string');
  });

  test('googleRsaAssets respecte les limites Google', () => {
    const long = 'x'.repeat(200);
    const r = googleRsaAssets({ headline: long, primaryText: long, callToAction: 'Achetez maintenant', brand: 'Marque très très longue pour le test' });
    expect(r.headlines.length).toBeGreaterThanOrEqual(3);
    expect(r.headlines.length).toBeLessThanOrEqual(15);
    expect(r.headlines.every((h) => h.length <= 30)).toBe(true);
    expect(r.descriptions.length).toBeGreaterThanOrEqual(2);
    expect(r.descriptions.length).toBeLessThanOrEqual(4);
    expect(r.descriptions.every((d) => d.length <= 90)).toBe(true);
    expect(new Set(r.headlines.map((h) => h.toLowerCase())).size).toBe(r.headlines.length);
  });
});

describe('key-check : nouvelles clés (forme seulement, aucun appel réseau)', () => {
  test('formes valides', async () => {
    const rep = await verifyKeys(
      ['CLOUDFLARE_ZONE_ID', 'VELBAZ_DOMAIN_TARGET', 'VELBAZ_EDGE_SECRET', 'NAMECHEAP_API_USER', 'NAMECHEAP_API_KEY', 'NAMECHEAP_CLIENT_IP', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'GOOGLE_ADS_API_VERSION', 'META_GRAPH_VERSION', 'META_APP_SECRET'],
      {
        CLOUDFLARE_ZONE_ID: '0123456789abcdef0123456789abcdef',
        VELBAZ_DOMAIN_TARGET: 'sites.example.com',
        VELBAZ_EDGE_SECRET: 'abcdefghijklmnopqrstuvwxyz',
        NAMECHEAP_API_USER: 'johnuser',
        NAMECHEAP_API_KEY: '0123456789abcdef0123456789abcdef',
        NAMECHEAP_CLIENT_IP: '203.0.113.7',
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-456-7890',
        GOOGLE_ADS_API_VERSION: 'v25',
        META_GRAPH_VERSION: 'v26.0',
        META_APP_SECRET: 'abcdef0123456789abcdef0123456789',
      },
    );
    expect(rep.results.map((r) => `${r.name}:${r.status}`).filter((s) => !s.endsWith(':ok'))).toEqual([]);
  });

  test('formes invalides', async () => {
    const rep = await verifyKeys(
      ['CLOUDFLARE_ZONE_ID', 'VELBAZ_DOMAIN_TARGET', 'VELBAZ_EDGE_SECRET', 'NAMECHEAP_CLIENT_IP', 'META_APP_ID', 'META_GRAPH_VERSION'],
      {
        CLOUDFLARE_ZONE_ID: 'nope',
        VELBAZ_DOMAIN_TARGET: 'https://sites.example.com/',
        VELBAZ_EDGE_SECRET: 'short',
        NAMECHEAP_CLIENT_IP: '999.1.1.1',
        META_APP_ID: 'abc',
        META_GRAPH_VERSION: '26',
      },
    );
    expect(rep.results.every((r) => r.status === 'bad')).toBe(true);
  });
});
