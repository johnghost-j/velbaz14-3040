// Tests de la 4ᵉ option de la règle de vérité : « contenu d'exemple assumé ».
// Cas d'origine (demande utilisateur du 25/09/2026) : on demande une entreprise
// de VOITURES ou d'AVIONS — rien de réel ne peut être vendu tout de suite. Il
// faut quand même générer la marque et le showroom, DIRE au propriétaire que ce
// sont des exemples — dans le CHAT VELBAZ, plus dans le site (correction du
// 25/09/2026 : ce message le concerne, pas ses visiteurs) — et surtout que le
// paiement ne « bugue » pas alors qu'il n'y a rien à vendre. Tout est
// déterministe ici : aucun appel modèle.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CHECKOUT_BLOCK_COPY,
  CHECKOUT_BLOCK_FALLBACK,
  DEMO_CONTENT_RULE,
  DEMO_CONTENT_RULE_SHORT,
  DEMO_NEVER_ALLOWED,
  checkoutBlockCopy,
  demoNoticeChatMessage,
  demoNoticeCopy,
  needsDemoNotice,
} from './demo-content';
import { CONTENT_TRUTH, CONTENT_TRUTH_SHORT } from './content-truth';
import { buildScaffold, type AppMeta } from './scaffold';

const meta = (over: Partial<AppMeta> = {}): AppMeta => ({
  companyName: 'Aero Motors',
  idea: 'concession de voitures de sport',
  ...over,
} as AppMeta);

describe('needsDemoNotice', () => {
  it('exige la mention pour une concession auto / un courtier avion (aucun catalogue réel)', () => {
    // C'est LE cas signalé : « une entreprise de voiture par exemple ou avion ».
    expect(needsDemoNotice({ appType: 'brand' })).toBe(true);
    expect(needsDemoNotice({ appType: 'ecommerce' })).toBe(true);
    expect(needsDemoNotice({ appType: 'configurator' })).toBe(true);
    expect(needsDemoNotice({ appType: 'marketplace' })).toBe(true);
    expect(needsDemoNotice({ appType: 'service' })).toBe(true);
  });

  it('est insensible à la casse et aux espaces du type d\'app', () => {
    expect(needsDemoNotice({ appType: '  ECommerce ' })).toBe(true);
  });

  it('ne met pas de mention sur un outil/SaaS qui démarre légitimement vide', () => {
    // Un tracker n'invente rien : il commence vide et se remplit à l'usage.
    expect(needsDemoNotice({ appType: 'saas' })).toBe(false);
    expect(needsDemoNotice({ appType: 'tool' })).toBe(false);
    expect(needsDemoNotice({ appType: 'tracker' })).toBe(false);
    expect(needsDemoNotice({ appType: 'productivity' })).toBe(false);
  });

  it('ne met JAMAIS de mention quand un catalogue réel est branché', () => {
    // Produits, prix et photos viennent du fournisseur : rien n'est inventé.
    expect(needsDemoNotice({ appType: 'ecommerce', hasRealCatalog: true })).toBe(false);
    expect(needsDemoNotice({ appType: 'dropshipping', hasRealCatalog: true })).toBe(false);
    // Le catalogue réel bat même un plan qui s'est déclaré en exemple.
    expect(needsDemoNotice({ appType: 'brand', hasRealCatalog: true, planDemoContent: true })).toBe(false);
  });

  it('ne met jamais de mention en mode clone (on reproduit un site réel)', () => {
    expect(needsDemoNotice({ appType: 'ecommerce', cloneMode: true })).toBe(false);
    expect(needsDemoNotice({ appType: 'clone', cloneMode: true, planDemoContent: true })).toBe(false);
  });

  it('respecte le plan IA quand il déclare avoir rempli l\'offre avec des exemples', () => {
    expect(needsDemoNotice({ appType: 'tool', planDemoContent: true })).toBe(true);
  });

  it('exige la mention dès qu\'une page encaisse, quel que soit le type d\'app', () => {
    expect(needsDemoNotice({ appType: 'social', hasPaymentPage: true })).toBe(true);
    expect(needsDemoNotice({ appType: 'social', hasPaymentPage: false })).toBe(false);
    expect(needsDemoNotice({})).toBe(false);
  });
});

describe('demoNoticeCopy', () => {
  it('dit que ce ne sont PAS encore de vraies informations, et comment les rendre vraies', () => {
    const fr = demoNoticeCopy('fr');
    expect(fr.title.toLowerCase()).toContain('exemple');
    expect(fr.title.toLowerCase()).toContain('pas encore de vraies informations');
    expect(fr.body.toLowerCase()).toContain('remplace');
    // Et que rien n'est encaissé entre-temps : c'est la promesse anti-arnaque.
    expect(fr.body.toLowerCase()).toContain('aucun paiement');
  });

  it('bascule en anglais et garde les deux mêmes promesses', () => {
    const en = demoNoticeCopy('en');
    expect(en.badge).toBe('Sample content');
    expect(en.title.toLowerCase()).toContain('not real information yet');
    expect(en.body.toLowerCase()).toContain('no payment');
  });

  it('retombe sur le français par défaut', () => {
    expect(demoNoticeCopy().badge).toBe("Contenu d'exemple");
    expect(demoNoticeCopy(null).badge).toBe("Contenu d'exemple");
    expect(demoNoticeCopy('').badge).toBe("Contenu d'exemple");
  });

  it('ne contient aucun caractère qui casserait une interpolation', () => {
    for (const lang of ['fr', 'en']) {
      const c = demoNoticeCopy(lang);
      for (const v of [c.badge, c.title, c.body]) {
        expect(v).not.toContain('`');
        expect(v).not.toContain('{');
        expect(v).not.toContain('}');
      }
    }
  });
});

describe('demoNoticeChatMessage — la mention est DITE DANS LE CHAT', () => {
  it('contient le texte complet (étiquette + phrase + explication)', () => {
    const fr = demoNoticeChatMessage('fr');
    const c = demoNoticeCopy('fr');
    expect(fr).toContain(c.badge);
    expect(fr).toContain(c.title);
    expect(fr).toContain(c.body);
    // Le message doit être lisible tel quel dans le chat : pas un résumé tronqué.
    expect(fr.length).toBeGreaterThan(c.title.length + c.body.length);
  });

  it('dit bien les deux choses utiles au propriétaire : remplacer + rien encaissé', () => {
    const fr = demoNoticeChatMessage();
    expect(fr).toContain('Velbaz');
    expect(fr.toLowerCase()).toContain('vrai catalogue');
    expect(fr.toLowerCase()).toContain('aucun paiement');
  });

  it('suit la langue du site', () => {
    expect(demoNoticeChatMessage('en')).toContain('Sample content');
    expect(demoNoticeChatMessage('fr')).toContain("Contenu d'exemple");
    expect(demoNoticeChatMessage(null)).toContain("Contenu d'exemple");
  });
});

describe('checkoutBlockCopy — « que Stripe ne bugue pas alors qu\'il n\'y a rien à vendre »', () => {
  it('couvre TOUS les codes de refus émis par le garde-fou catalogue', () => {
    // Codes de commerce-guard.ts + server/stripe.ts du site généré. Un code non
    // couvert = un message générique au visiteur → on les fige ici.
    const codes = [
      'no_items', 'plan_without_price', 'no_product_reference', 'product_not_found',
      'product_not_published', 'variant_not_found', 'variant_required',
      'product_without_price', 'price_below_supplier_cost', 'cart_has_unknown_items',
      'catalog_unverifiable', 'catalog_unreachable', 'stripe_not_connected', 'stripe_error',
    ];
    for (const code of codes) {
      expect(CHECKOUT_BLOCK_COPY[code], `code manquant: ${code}`).toBeDefined();
      expect(CHECKOUT_BLOCK_COPY[code].message.length).toBeGreaterThan(20);
    }
  });

  it('explique qu\'un article d\'exemple n\'est pas en vente, sans erreur technique', () => {
    const c = checkoutBlockCopy('no_product_reference');
    expect(c.kind).toBe('demo');
    expect(c.message).toContain('exemple');
    expect(c.message).toContain("Aucun paiement n'a été effectué.");
  });

  it('classe le défaut de configuration du propriétaire à part du contenu d\'exemple', () => {
    expect(checkoutBlockCopy('stripe_not_connected').kind).toBe('config');
    expect(checkoutBlockCopy('price_below_supplier_cost').kind).toBe('config');
    expect(checkoutBlockCopy('cart_has_unknown_items').kind).toBe('demo');
  });

  it('demande une action au visiteur sans le rassurer inutilement', () => {
    const c = checkoutBlockCopy('variant_required');
    expect(c.kind).toBe('cart');
    // Panier vide / option manquante : rien n'a été tenté, pas de « aucun paiement ».
    expect(c.message).not.toContain('Aucun paiement');
  });

  it('privilégie le message du serveur (il peut nommer le produit) et garde la réassurance', () => {
    const c = checkoutBlockCopy('product_not_found', 'Le produit « Falcon 900 » n\'est pas au catalogue.');
    expect(c.message).toContain('Falcon 900');
    expect(c.message).toContain("Aucun paiement n'a été effectué.");
  });

  it('ne duplique pas la réassurance si le serveur l\'a déjà écrite', () => {
    const c = checkoutBlockCopy('product_not_found', "Produit inconnu. Aucun paiement n'a été effectué.");
    expect(c.message.match(/ucun paiement/g)).toHaveLength(1);
  });

  it('ignore un message serveur vide, trop court ou absent', () => {
    expect(checkoutBlockCopy('product_not_found', '   ').message).toBe(CHECKOUT_BLOCK_COPY.product_not_found.message);
    expect(checkoutBlockCopy('product_not_found', 'nope').message).toBe(CHECKOUT_BLOCK_COPY.product_not_found.message);
    expect(checkoutBlockCopy('product_not_found', null).message).toBe(CHECKOUT_BLOCK_COPY.product_not_found.message);
  });

  it('n\'écrase pas une consigne « cart » par un message serveur technique', () => {
    const c = checkoutBlockCopy('variant_required', 'variant_required: missing vid for product 42');
    expect(c.message).toBe(CHECKOUT_BLOCK_COPY.variant_required.message);
  });

  it('retombe sur un message honnête pour un code inconnu ou absent', () => {
    expect(checkoutBlockCopy('code_qui_nexiste_pas')).toEqual(CHECKOUT_BLOCK_FALLBACK);
    expect(checkoutBlockCopy()).toEqual(CHECKOUT_BLOCK_FALLBACK);
    expect(checkoutBlockCopy(null, null)).toEqual(CHECKOUT_BLOCK_FALLBACK);
  });

  it('ne promet jamais un paiement encaissé ni un faux succès', () => {
    for (const [, v] of Object.entries(CHECKOUT_BLOCK_COPY)) {
      expect(v.message.toLowerCase()).not.toContain('commande confirmée');
      expect(v.message.toLowerCase()).not.toContain('merci pour votre achat');
    }
  });
});

describe('règle injectée dans les prompts', () => {
  it('la 4ᵉ option est bien dans la règle complète ET dans la version courte', () => {
    expect(CONTENT_TRUTH).toContain(DEMO_CONTENT_RULE);
    expect(CONTENT_TRUTH_SHORT).toContain(DEMO_CONTENT_RULE_SHORT);
    expect(CONTENT_TRUTH).toContain('4 options');
  });

  it('interdit toujours ce qui trompe même étiqueté (faux avis, labels, coordonnées)', () => {
    // L'étiquette « exemple » n'autorise QUE la structure de l'offre.
    expect(DEMO_CONTENT_RULE).toContain('avis');
    expect(DEMO_CONTENT_RULE).toContain('certifications');
    for (const banned of DEMO_NEVER_ALLOWED) {
      expect(DEMO_CONTENT_RULE).toContain(banned);
    }
  });

  it('impose l\'étiquetage et l\'absence de paiement sur un contenu d\'exemple', () => {
    expect(DEMO_CONTENT_RULE).toContain('isSample: true');
    expect(DEMO_CONTENT_RULE).toContain('AUCUN PAIEMENT SUR UN CONTENU D\'EXEMPLE');
    expect(DEMO_CONTENT_RULE_SHORT).toContain('isSample: true');
  });

  it('interdit de supprimer le cœur de l\'offre (le bug qu\'on corrige)', () => {
    expect(CONTENT_TRUTH).toContain('on ne livre pas un site vide');
  });
});

describe('scaffold — la mention n\'est PLUS affichée dans le site', () => {
  it('écrit toujours le composant DemoNotice, mais il ne rend RIEN (import sûr)', () => {
    // Le fichier reste écrit : du code généré (ou un projet créé avant le
    // changement) peut encore l'importer, et un import cassé ferait échouer
    // TOUT le build. Il ne doit simplement plus rien afficher.
    for (const m of [meta(), meta({ demoContent: true }), meta({ cloneMode: true })]) {
      const files = buildScaffold(m);
      const notice = files.find((f) => f.path === 'src/components/DemoNotice.tsx');
      expect(notice, `DemoNotice manquant (demoContent=${m.demoContent}, clone=${m.cloneMode})`).toBeDefined();
      expect(notice!.content).toContain('export default function DemoNotice');
      expect(notice!.content).toContain('return null');
      // Aucun texte de la mention n'est embarqué dans le site.
      expect(notice!.content).not.toContain("Contenu d'exemple");
      expect(notice!.content).not.toContain('Sample content');
    }
  });

  it('Layout ne rend JAMAIS la mention, même quand demoContent est vrai', () => {
    for (const m of [meta(), meta({ demoContent: true }), meta({ demoContent: true, lang: 'en' })]) {
      const layout = buildScaffold(m).find((f) => f.path === 'src/components/Layout.tsx')!.content;
      expect(layout).not.toContain('DemoNotice');
      expect(layout).not.toContain('<DemoNotice />');
    }
  });

  it('aucun fichier du site généré ne contient le texte de la mention', () => {
    // C'est LA demande : ce texte ne doit pas être dans le site, mais dans le chat.
    for (const m of [meta({ demoContent: true }), meta({ demoContent: true, lang: 'en' })]) {
      for (const f of buildScaffold(m)) {
        expect(f.content, `texte de la mention trouvé dans ${f.path}`).not.toContain(demoNoticeCopy(m.lang).title);
      }
    }
  });

  it('le garde-fou de paiement reste entier (il n\'était pas visé par le changement)', () => {
    // Retirer le bandeau ne doit surtout pas retirer le refus serveur : c'est lui
    // qui empêche de vendre un article qui n'existe pas.
    const api = buildScaffold(meta({ demoContent: true })).find((f) => f.path === 'src/lib/api.ts')!.content;
    expect(api).toContain('no_product_reference');
    expect(api).toContain('cart_has_unknown_items');
    expect(api).toContain(CHECKOUT_BLOCK_COPY.no_product_reference.message);
  });

  it('le client de paiement généré ne lève plus d\'exception et affiche un message', () => {
    const api = buildScaffold(meta()).find((f) => f.path === 'src/lib/api.ts')!.content;
    // Avant : `throw new Error(r.message)` → bouton « Acheter » mort/erreur rouge.
    expect(api).toContain('Promise<CheckoutResult>');
    expect(api).toContain('showPaymentNotice');
    expect(api).toContain('return { ok: true }');
    expect(api).not.toContain('throw new Error(r.message');
    // La table des messages est bien sérialisée dans le site (source unique).
    expect(api).toContain('catalog_unverifiable');
    expect(api).toContain('no_product_reference');
  });

  it('expose l\'état réel des paiements, servi par une vraie route serveur', () => {
    const files = buildScaffold(meta());
    const api = files.find((f) => f.path === 'src/lib/api.ts')!.content;
    const stripe = files.find((f) => f.path === 'server/stripe.ts')!.content;
    expect(api).toContain('paymentsStatus');
    expect(api).toContain('"/payments/status"');
    // La route doit EXISTER côté serveur, sinon paymentsStatus() ment (404).
    expect(stripe).toContain('checkoutRoute.get("/payments/status"');
    expect(stripe).toContain('stripe_not_connected');
  });
});

// ── Câblage : les DEUX chemins de build doivent dire la mention dans le chat ──
// Sans ça, la mention disparaîtrait purement et simplement (retirée du site et
// dite nulle part) — c'est le pire résultat possible : le propriétaire ne
// saurait plus que son catalogue est un exemple.
describe('câblage — la mention est postée dans le chat par les deux builds', () => {
  const paths = {
    'api/index.ts': new URL('../index.ts', import.meta.url),
    'api/builder/routes.ts': new URL('./routes.ts', import.meta.url),
  };

  for (const [label, url] of Object.entries(paths)) {
    it(`${label} annonce le contenu d'exemple dans le chat après le build`, () => {
      const src = readFileSync(url, 'utf8');
      expect(src).toContain('demo-notice-chat');
      expect(src).toContain('announceDemoContentInChat');
      // Et le retire quand le site n'a plus de contenu d'exemple (catalogue réel).
      expect(src).toContain('clearDemoContentAnnouncement');
      expect(src).toContain('generated.meta?.demoContent');
    });
  }

  it('le message posté dans le chat est bien le texte complet de la mention', () => {
    const src = readFileSync(new URL('./demo-notice-chat.ts', import.meta.url), 'utf8');
    expect(src).toContain('demoNoticeChatMessage');
    // Message assistant persistant, dans le fil du projet (sessionId = companyId).
    expect(src).toContain("role: \"assistant\"");
    expect(src).toContain('sessionId: companyId');
    // Idempotent : un rebuild ne doit pas empiler les doublons.
    expect(src).toContain('onConflictDoUpdate');
  });
});
