import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  fromMediaToken, mediaProxyRequestRewrite, proxyMediaUrls, serveProxiedMedia, toMediaToken, toProxiedMediaUrl, unproxyMediaUrls,
} from './media-proxy';

const PFY = 'https://images-api.printify.com/mockup/6ac1199e/149615/98432/x.jpg?camera_label=front';

describe('jeton', () => {
  test('aller-retour, déterministe, opaque', () => {
    const t = toMediaToken(PFY);
    expect(t).toBe(toMediaToken(PFY));
    expect(t).toMatch(/^[\w-]+$/);
    expect(Buffer.from(t, 'base64url').toString('latin1')).not.toMatch(/printify/i);
    expect(fromMediaToken(t)).toBe(PFY);
  });

  test('jeton forgé ou modifié refusé', () => {
    const t = toMediaToken(PFY);
    const flipped = (t[30] === 'A' ? 'B' : 'A');
    expect(fromMediaToken(t.slice(0, 30) + flipped + t.slice(31))).toBeNull();
    expect(fromMediaToken(Buffer.from('https://evil.example/x'.padEnd(60, '#')).toString('base64url'))).toBeNull();
    expect(fromMediaToken('../../etc/passwd')).toBeNull();
  });
});

describe('réécriture', () => {
  test('seuls les hôtes fournisseurs/internes sont remplacés', () => {
    expect(toProxiedMediaUrl(PFY)).toMatch(/^\/api\/img\/[\w-]+$/);
    expect(toProxiedMediaUrl('https://ae01.alicdn.com/kf/a.jpg')).toMatch(/^\/api\/img\//);
    expect(toProxiedMediaUrl('https://storage.googleapis.com/runable-templates/a.png')).toMatch(/^\/api\/img\//);
    for (const u of ['https://images.unsplash.com/a.jpg', 'https://storage.googleapis.com/other-bucket/a.png', 'https://notprintify.com/a.png']) {
      expect(toProxiedMediaUrl(u)).toBe(u);
    }
  });

  test('texte : remplacé puis restauré à l\'identique', () => {
    const txt = `Photo [IMG:${PFY}] et ![x](${PFY}) puis https://example.com/ok`;
    const prox = proxyMediaUrls(txt);
    expect(prox).not.toMatch(/printify/i);
    expect(prox).toContain('https://example.com/ok');
    expect(unproxyMediaUrls(prox)).toBe(txt);
    // absolu (copié depuis le navigateur) aussi
    expect(unproxyMediaUrls(`https://velbaz.app${toProxiedMediaUrl(PFY)}`)).toBe(PFY);
  });
});

describe('middleware et route', () => {
  test('corps JSON reçu : adresses réelles avant le handler', async () => {
    const app = new Hono();
    app.use('*', mediaProxyRequestRewrite());
    app.post('/p', async (c) => c.json(await c.req.json()));
    const body = { imageUrl: toProxiedMediaUrl(PFY), images: [toProxiedMediaUrl(PFY)], name: 'Mug' };
    const res = await app.request('/p', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await res.json()).toEqual({ imageUrl: PFY, images: [PFY], name: 'Mug' });
  });

  test('GET /img/:token : 404 pour un jeton inconnu', async () => {
    const app = new Hono();
    app.get('/img/:token', serveProxiedMedia);
    expect((await app.request('/img/abc')).status).toBe(404);
  });
});
