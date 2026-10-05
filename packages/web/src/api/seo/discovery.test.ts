import { describe, it, expect } from 'vitest';
import {
  siteBaseUrl, pageUrl, buildSitemap, buildRobots, indexNowKey, submitToIndexNow,
} from './discovery';

describe('siteBaseUrl', () => {
  it('préfère le domaine personnalisé à l’hébergement interne', () => {
    expect(siteBaseUrl({ subdomain: 'acme', customDomain: 'acme.com' }, 'https://velbaz.site'))
      .toBe('https://acme.com');
  });

  it('nettoie un domaine saisi avec le protocole ou un slash final', () => {
    expect(siteBaseUrl({ customDomain: 'https://acme.com/' }, 'https://velbaz.site')).toBe('https://acme.com');
  });

  it('retombe sur le sous-domaine interne sans domaine personnalisé', () => {
    expect(siteBaseUrl({ subdomain: 'Acme' }, 'https://velbaz.site/')).toBe('https://velbaz.site/s/acme');
  });

  it('renvoie null quand le site n’a aucune adresse publique', () => {
    expect(siteBaseUrl({}, 'https://velbaz.site')).toBeNull();
    expect(siteBaseUrl({ subdomain: '  ' }, 'https://velbaz.site')).toBeNull();
  });
});

describe('pageUrl', () => {
  it('mappe le slug index sur la racine, pas sur /index', () => {
    expect(pageUrl('https://a.com', { slug: 'index' })).toBe('https://a.com/');
  });

  it('construit une URL de page normale', () => {
    expect(pageUrl('https://a.com', { slug: 'tarifs' })).toBe('https://a.com/tarifs');
  });

  it('ne double pas le slash si le slug en porte déjà un', () => {
    expect(pageUrl('https://a.com', { slug: '/contact' })).toBe('https://a.com/contact');
  });
});

describe('buildSitemap', () => {
  it('liste toujours la racine même sans page index', () => {
    const xml = buildSitemap('https://a.com', [{ slug: 'tarifs' }]);
    expect(xml).toContain('<loc>https://a.com/</loc>');
    expect(xml).toContain('<loc>https://a.com/tarifs</loc>');
    expect(xml).toContain('<priority>1.0</priority>');
  });

  it('n’émet jamais deux fois la même URL', () => {
    const xml = buildSitemap('https://a.com', [
      { slug: 'index' }, { slug: 'index', lang: 'fr' }, { slug: 'tarifs' }, { slug: 'tarifs', lang: 'nl' },
    ]);
    expect(xml.match(/<loc>https:\/\/a\.com\/<\/loc>/g)).toHaveLength(1);
    expect(xml.match(/<loc>https:\/\/a\.com\/tarifs<\/loc>/g)).toHaveLength(1);
  });

  it('écrit lastmod au format W3C et ignore une date invalide', () => {
    const ok = buildSitemap('https://a.com', [{ slug: 'a', updatedAt: '2026-09-01T10:20:30.000Z' }]);
    expect(ok).toContain('<lastmod>2026-09-01</lastmod>');
    const bad = buildSitemap('https://a.com', [{ slug: 'a', updatedAt: 'pas-une-date' }]);
    expect(bad).not.toContain('<lastmod>');
  });

  it('échappe les caractères XML interdits dans une URL', () => {
    const xml = buildSitemap('https://a.com', [{ slug: 'x?a=1&b=2' }]);
    expect(xml).toContain('&amp;');
    expect(xml).not.toMatch(/=1&b/);
  });

  it('produit un document valide même sans aucune page', () => {
    const xml = buildSitemap('https://a.com', []);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(xml.match(/<url>/g)).toHaveLength(1);
    expect(xml).toContain('</urlset>');
  });
});

describe('buildRobots', () => {
  it('autorise tout et déclare le sitemap', () => {
    const txt = buildRobots('https://a.com');
    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Allow: /');
    expect(txt).toContain('Sitemap: https://a.com/sitemap.xml');
    expect(txt).not.toContain('Disallow: /');
  });

  it('interdit tout sur un site privé', () => {
    const txt = buildRobots('https://a.com', { private: true });
    expect(txt).toContain('Disallow: /');
    expect(txt).not.toContain('Sitemap:');
  });
});

describe('indexNowKey', () => {
  it('est stable pour une même société', () => {
    expect(indexNowKey('co-1', 's')).toBe(indexNowKey('co-1', 's'));
  });

  it('diffère d’une société à l’autre et d’un secret à l’autre', () => {
    expect(indexNowKey('co-1', 's')).not.toBe(indexNowKey('co-2', 's'));
    expect(indexNowKey('co-1', 's1')).not.toBe(indexNowKey('co-1', 's2'));
  });

  it('respecte le format exigé par le protocole (8-128 car. alphanumériques)', () => {
    const k = indexNowKey('co-1', 's');
    expect(k).toMatch(/^[a-zA-Z0-9-]{8,128}$/);
    expect(k).toHaveLength(32);
  });
});

describe('submitToIndexNow', () => {
  it('n’appelle pas le réseau sans URL', async () => {
    let called = false;
    const res = await submitToIndexNow('https://a.com', [], 'k', (async () => { called = true; return new Response(); }) as any);
    expect(res).toMatchObject({ submitted: false, reason: 'no_urls' });
    expect(called).toBe(false);
  });

  it('écarte un host non public au lieu de soumettre du localhost', async () => {
    let called = false;
    const fake = (async () => { called = true; return new Response(null, { status: 200 }); }) as any;
    for (const base of ['http://localhost:4200/s/x', 'http://127.0.0.1/s/x', 'https://dev.local/s/x']) {
      const res = await submitToIndexNow(base, [`${base}/`], 'k', fake);
      expect(res.reason).toBe('non_public_host');
      expect(res.submitted).toBe(false);
    }
    expect(called).toBe(false);
  });

  it('signale une base url invalide', async () => {
    const res = await submitToIndexNow('pas-une-url', ['https://a.com/'], 'k', (async () => new Response()) as any);
    expect(res.reason).toBe('bad_base_url');
  });

  it('envoie host, key, keyLocation et la liste dédoublonnée', async () => {
    let body: any = null;
    let url = '';
    const res = await submitToIndexNow(
      'https://a.com',
      ['https://a.com/', 'https://a.com/', 'https://a.com/tarifs', 'javascript:alert(1)'],
      'thekey',
      (async (u: string, init: any) => { url = u; body = JSON.parse(init.body); return new Response(null, { status: 200 }); }) as any,
    );
    expect(url).toBe('https://api.indexnow.org/indexnow');
    expect(body.host).toBe('a.com');
    expect(body.key).toBe('thekey');
    expect(body.keyLocation).toBe('https://a.com/thekey.txt');
    expect(body.urlList).toEqual(['https://a.com/', 'https://a.com/tarifs']);
    expect(res).toMatchObject({ submitted: true, status: 200, urls: 2 });
  });

  it('traite 202 comme un succès (clé en cours de validation)', async () => {
    const res = await submitToIndexNow('https://a.com', ['https://a.com/'], 'k',
      (async () => new Response(null, { status: 202 })) as any);
    expect(res.submitted).toBe(true);
  });

  it('ne réussit pas sur un refus du moteur', async () => {
    const res = await submitToIndexNow('https://a.com', ['https://a.com/'], 'k',
      (async () => new Response(null, { status: 403 })) as any);
    expect(res).toMatchObject({ submitted: false, status: 403 });
  });

  it('ne lève jamais quand le réseau tombe', async () => {
    const res = await submitToIndexNow('https://a.com', ['https://a.com/'], 'k',
      (async () => { throw new Error('boom'); }) as any);
    expect(res).toMatchObject({ submitted: false, reason: 'boom' });
  });
});
