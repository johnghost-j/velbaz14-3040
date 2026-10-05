import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { fromMediaToken } from './media-proxy';
import {
  createCustomerTextStream,
  createSseRewriter,
  customerTextGuard,
  isCustomerTextExempt,
  toCustomerPayload,
  toCustomerText,
} from './customer-text';

const LEAK = /printify|printful|blueprint|dropshipping|aliexpress|\(cj\)|gpt|gemini|claude|openai|higgsfield|openrouter|nano banana|seedream|runable|turso/i;

describe('toCustomerText', () => {
  test('messages serveur réels : plus aucun fournisseur', () => {
    const cases = [
      '✅ T-shirt Nova créé sur Printify (mockup Printify — blueprint 384)',
      'Coût Printify réel : 12,40 €',
      'Expédition : automatique (CJ)',
      '📦 Printify: commande 123 envoyée',
      '🔗 vrai produit Printify #6523abcdef0123456789abcd',
      'Printify non connecté — connecte ton token API Printify',
      '2 photo(s) retirée(s) de Printify',
      'Quel produit Printify veux-tu ajouter ? Voici les vrais produits disponibles chez Printify.',
      'Les mockups Printify réels sont prêts',
      'Created on Printify via CJ Dropshipping',
    ];
    for (const c of cases) {
      const out = toCustomerText(c);
      expect(out).not.toMatch(LEAK);
      expect(out.length).toBeGreaterThan(0);
    }
    expect(toCustomerText('Coût Printify réel : 12,40 €')).toBe('coût de fabrication réel : 12,40 €');
    expect(toCustomerText('Expédition : automatique (CJ)')).toBe('Expédition : automatique');
    expect(toCustomerText('créé sur Printify')).toBe('créé chez notre atelier partenaire');
  });

  test('modèles et outils d’IA masqués', () => {
    for (const c of [
      'Je suis basé sur GPT-5.4',
      'propulsé par openai/gpt-6-luna',
      'image faite avec Nano Banana Pro puis Seedream v4',
      'Google Gemini 3 Flash et Claude Sonnet 4.5',
      'vidéo Higgsfield, routée par OpenRouter, hébergée sur Runable',
      'ChatGPT',
    ]) expect(toCustomerText(c)).not.toMatch(LEAK);
  });

  test('mots courants et noms de marque client laissés intacts', () => {
    for (const c of ['Runway Collection', 'Sora Studio', 'le flux de commandes', 'Imagen Paris', 'Meta Ads', 'Studio CJ']) {
      expect(toCustomerText(c)).toBe(c);
    }
  });

  test('URL et marqueurs [IMG:…] : photo fournisseur servie par Velbaz, autres URL intactes', () => {
    const url = 'https://images-api.printify.com/mockup/abc/123.jpg';
    const out = toCustomerText(`Voici la photo [IMG:${url}] du produit`);
    expect(out).toMatch(/^Voici la photo \[IMG:\/api\/img\/[\w-]+\] du produit$/);
    expect(out).not.toMatch(/printify/i);
    const tok = out.match(/\/api\/img\/([\w-]+)/)![1];
    expect(fromMediaToken(tok)).toBe(url);
    const other = 'https://images.unsplash.com/photo-1.jpg';
    expect(toCustomerText(`[IMG:${other}]`)).toBe(`[IMG:${other}]`);
    expect(toCustomerText('type printify_design et printifyProductId')).toBe('type printify_design et printifyProductId');
    expect(toCustomerText('PRINTIFY_API_TOKEN')).toBe('PRINTIFY_API_TOKEN');
  });
});

describe('toCustomerPayload', () => {
  test('clés techniques et valeurs identifiants intactes, texte nettoyé', () => {
    const out = toCustomerPayload({
      id: 'x', type: 'printify_design', model: 'openai/gpt-6-luna', provider: 'printify',
      fulfillment: 'printify', imageUrl: 'https://printify.com/a.png', printifyProductId: 'abc',
      message: 'créé sur Printify', items: [{ title: 'Coût Printify réel' }],
    }) as any;
    expect(out.type).toBe('printify_design');
    expect(out.model).toBe('openai/gpt-6-luna');
    expect(out.provider).toBe('printify');
    expect(out.fulfillment).toBe('printify');
    expect(out.imageUrl).toMatch(/^\/api\/img\/[\w-]+$/);
    expect(fromMediaToken(out.imageUrl.slice('/api/img/'.length))).toBe('https://printify.com/a.png');
    expect(out.printifyProductId).toBe('abc');
    expect(out.message).not.toMatch(LEAK);
    expect(out.items[0].title).not.toMatch(LEAK);
  });
});

describe('flux', () => {
  const run = (chunks: string[]) => {
    const s = createCustomerTextStream();
    return chunks.map((c) => s.push(c)).join('') + s.flush();
  };

  test('nom coupé entre deux morceaux', () => {
    const text = 'Bonne question ! Nos produits sont fabriqués avec soin. Je passe par Print' + 'ify pour ça et le coût Printify réel est bas, vraiment très bas pour toi aujourd’hui.';
    const chunks = ['Bonne question ! Nos produits sont fabriqués avec soin. Je passe par Print', 'ify pour ça et le coût Print', 'ify réel est bas, vraiment très bas pour toi aujourd’hui.'];
    const out = run(chunks);
    expect(out).not.toMatch(LEAK);
    expect(out).toBe(toCustomerText(text));
  });

  test('découpe caractère par caractère = texte nettoyé en une fois', () => {
    const text = 'Le modèle Google Gemini 3 Flash et Nano Banana Pro créent des visuels, puis CJ Dropshipping expédie. '.repeat(3) + 'Voir https://example.com/a?b=1 fin.';
    expect(run([...text])).toBe(toCustomerText(text));
  });

  test('le texte sort au fil de l’eau (pas tout à la fin)', () => {
    const s = createCustomerTextStream();
    let early = '';
    for (const w of 'un deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize dix-sept dix-huit vingt'.split(' ')) early += s.push(`${w} `);
    expect(early.length).toBeGreaterThan(0);
  });
});

describe('SSE', () => {
  test('token, draftReset, done', () => {
    const rw = createSseRewriter();
    const out: string[] = [];
    out.push(...rw.rewriteBlock(`data: ${JSON.stringify({ draftToken: 'brouillon Printify '.repeat(10) })}`));
    out.push(...rw.rewriteBlock(`data: ${JSON.stringify({ draftReset: true })}`));
    out.push(...rw.rewriteBlock(`data: ${JSON.stringify({ token: 'Je passe par Print' })}`));
    out.push(...rw.rewriteBlock(`data: ${JSON.stringify({ token: 'ify.' })}`));
    out.push(...rw.rewriteBlock(`data: ${JSON.stringify({ progress: 'Création sur Printify…' })}`));
    out.push(...rw.rewriteBlock(`data: ${JSON.stringify({ done: true, model: 'openai/gpt-6-luna' })}`));
    const events = out.map((b) => JSON.parse(b.slice(5)));
    const tokens = events.filter((e) => 'token' in e).map((e) => e.token).join('');
    expect(tokens).toBe('Je passe chez notre atelier partenaire.');
    expect(events.find((e) => e.progress).progress).not.toMatch(LEAK);
    const done = events.find((e) => e.done);
    expect(done.model).toBe('openai/gpt-6-luna');
    // Le reste du flux est vidé AVANT done.
    expect(events.findIndex((e) => 'token' in e)).toBeLessThan(events.findIndex((e) => e.done));
    // Le brouillon jeté n'est jamais réémis après draftReset.
    const afterReset = events.slice(events.findIndex((e) => e.draftReset));
    expect(afterReset.some((e) => 'draftToken' in e)).toBe(false);
  });
});

describe('middleware', () => {
  const app = new Hono();
  app.use('*', customerTextGuard());
  app.get('/companies/:id/jobs', (c) => c.json({ activity: [{ id: 'a1', message: '✅ créé sur Printify (blueprint 384)', type: 'printify_design' }] }));
  app.get('/admin/x', (c) => c.json({ message: 'créé sur Printify' }));
  app.get('/stream', () => new Response(
    `data: ${JSON.stringify({ token: 'Print' })}\n\ndata: ${JSON.stringify({ token: 'ify ok' })}\n\ndata: ${JSON.stringify({ done: true })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  ));

  test('JSON client nettoyé, admin intact', async () => {
    const j = await (await app.request('/companies/1/jobs')).json() as any;
    expect(j.activity[0].message).not.toMatch(LEAK);
    expect(j.activity[0].type).toBe('printify_design');
    const a = await (await app.request('/admin/x')).json() as any;
    expect(a.message).toBe('créé sur Printify');
  });

  test('SSE nettoyé', async () => {
    const t = await (await app.request('/stream')).text();
    const tokens = t.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.slice(5))).filter((e) => 'token' in e).map((e) => e.token).join('');
    expect(tokens).toBe('notre atelier partenaire ok');
  });

  test('routes exemptées', () => {
    expect(isCustomerTextExempt('/api/companies/1/file-content')).toBe(true);
    expect(isCustomerTextExempt('/api/companies/1/website/fr/home')).toBe(true);
    expect(isCustomerTextExempt('/api/companies/1/website-links')).toBe(false);
    expect(isCustomerTextExempt('/api/companies/1/jobs')).toBe(false);
  });
});

describe('tournures des anciennes lignes en base', () => {
  test('catalogue, en-tête de message, mockup', () => {
    expect(toCustomerText("🔎 Recherche d'un mug dans le catalogue Printify…")).toBe("🔎 Recherche d'un mug dans le catalogue…");
    expect(toCustomerText('🖨️ Printify : aucun produit imprimé ne sera créé.')).toBe('🖨️ Création : aucun produit imprimé ne sera créé.');
    expect(toCustomerText('🖨️ Printify — rien à imprimer')).toBe('🖨️ Création — rien à imprimer');
    expect(toCustomerText("✅ Mockup Printify prêt — regarde l'aperçu.")).toBe("✅ Aperçu du produit prêt — regarde l'aperçu.");
    expect(toCustomerText('🖨️ Création du mug sur Printify et récupération du mockup réel…')).toBe("🖨️ Création du mug chez notre atelier partenaire et récupération de l'aperçu réel…");
    expect(toCustomerText('Voici le mockup et 2 mockups')).toBe("Voici l'aperçu et 2 aperçus");
    // identifiants intacts
    expect(toCustomerText('mockup_url et printify_design')).toBe('mockup_url et printify_design');
  });
});
