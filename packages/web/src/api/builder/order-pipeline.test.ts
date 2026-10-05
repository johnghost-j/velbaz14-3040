// [2026-09-25] Demande utilisateur : « les sites générés ne sont pas connectés
// à Velbaz — quand on fait une commande sur le site généré, elle n'apparaît pas
// dans la partie Commandes du dashboard ».
//
// Cause : la commande payée ne remontait que par des chemins fragiles —
//   1. un unique fetch « tire et oublie » depuis /api/checkout/:id du site ;
//   2. la page /success du site, qui N'EXISTAIT PAS en mode clone ;
//   3. un webhook Stripe que presque personne ne configure.
// Un onglet fermé juste après le paiement = commande perdue pour toujours.
//
// Ce que ces tests verrouillent (tout est déterministe : aucun appel réseau) :
//   • le serveur du site généré RÉESSAIE avant de répondre, et dit s'il a
//     réussi (`recorded`) ;
//   • la page de retour de paiement existe dans les DEUX modes (normal ET
//     clone) et réessaie elle aussi ;
//   • la réconciliation Stripe côté Velbaz (le filet ultime) est bien branchée
//     sur l'ouverture du panneau Commandes et sur la route de disponibilité.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildScaffold, type AppMeta } from './scaffold';
import { buildAppTsx } from './engine';

const meta = (over: Partial<AppMeta> = {}): AppMeta => ({
  companyName: 'Aero Motors',
  idea: 'boutique de pièces auto',
  ...over,
} as AppMeta);

const stripeServer = (over: Partial<AppMeta> = {}) => {
  const files = buildScaffold(meta(over));
  const f = files.find((x) => x.path === 'server/stripe.ts');
  expect(f, 'server/stripe.ts absent du scaffold').toBeDefined();
  return f!.content;
};

const PAGES = [
  { name: 'Accueil', file: 'Home', route: '/' },
  { name: 'Boutique', file: 'Shop', route: '/shop' },
];

describe('site généré → Velbaz : la notification de commande est fiable', () => {
  it('prévient Velbaz sur /companies/:id/orders/confirm avec la session Stripe', () => {
    const src = stripeServer();
    expect(src).toContain('/orders/confirm');
    expect(src).toContain('JSON.stringify({ sessionId })');
  });

  it('réessaie au lieu de perdre la commande sur un hoquet réseau', () => {
    const src = stripeServer();
    expect(src).toContain('async function notifyVelbazOrder');
    // Plusieurs tentatives, avec attente entre deux.
    expect(src).toMatch(/for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
    expect(src).toContain('setTimeout(r, 400 * (attempt + 1))');
  });

  it('n’insiste pas sur un refus définitif (4xx) mais insiste sur un 5xx', () => {
    const src = stripeServer();
    expect(src).toMatch(/res\.status >= 400 && res\.status < 500/);
  });

  it('n’est plus un « tire et oublie » : /checkout/:id attend et rend `recorded`', () => {
    const src = stripeServer();
    expect(src).toContain('const n = await notifyVelbazOrder(session.id)');
    expect(src).toContain('recorded = !!n');
    expect(src).toMatch(/amount: session\.amount_total, recorded,/);
    // L'ancien motif fragile ne doit plus exister.
    expect(src).not.toMatch(/fetch\([^)]*orders\/confirm[\s\S]{0,400}?\}\)\.catch\(\(\) => \{\}\)/);
  });

  it('ne notifie que des sessions réellement payées', () => {
    const src = stripeServer();
    expect(src).toMatch(/session\.payment_status === "paid"/);
  });

  it('marque la session pour l’entreprise (c’est ce qui rend la reprise possible)', () => {
    // Sans metadata.companyId, Velbaz ne peut pas savoir qu'une session payée
    // chez Stripe appartient à ce projet lors de la réconciliation.
    expect(stripeServer()).toContain('metadata: { companyId: process.env.COMPANY_ID || ""');
  });
});

describe('page de retour de paiement : présente dans les DEUX modes', () => {
  it('mode normal : /success et /cancel existent et /success confirme la commande', () => {
    const app = buildAppTsx(PAGES, false);
    expect(app).toContain('path="/success"');
    expect(app).toContain('path="/cancel"');
    expect(app).toContain('/checkout/');
  });

  it('mode normal : la confirmation réessaie (onglet lent, API qui redémarre)', () => {
    const app = buildAppTsx(PAGES, false);
    expect(app).toMatch(/attempt/);
    expect(app).toMatch(/for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
  });

  it('mode CLONE : le client payant ne tombe plus sur un 404 (c’était le trou)', () => {
    const clone = buildAppTsx(PAGES, true);
    expect(clone).toContain('path="/success"');
    expect(clone).toContain('path="/cancel"');
    expect(clone).toContain('PaymentReturn');
    // Et il confirme la commande, comme le mode normal.
    expect(clone).toContain('/checkout/');
    expect(clone).toMatch(/for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
  });

  it('les routes de paiement passent AVANT le catch-all 404', () => {
    for (const clone of [false, true]) {
      const app = buildAppTsx(PAGES, clone);
      const success = app.indexOf('path="/success"');
      const star = app.indexOf('path="*"');
      expect(success, `/success absent (clone=${clone})`).toBeGreaterThan(-1);
      expect(star, `catch-all absent (clone=${clone})`).toBeGreaterThan(-1);
      expect(success, `/success après le catch-all (clone=${clone})`).toBeLessThan(star);
    }
  });

  it('le code généré reste cohérent : ce qu’il utilise, il l’importe', () => {
    const clone = buildAppTsx(PAGES, true);
    expect(clone).toMatch(/import \{[^}]*useState[^}]*\} from "react"/);
    expect(clone).toContain('from "./lib/api"');
    expect(clone).toMatch(/import \{[^}]*useSearchParams[^}]*\} from "react-router-dom"/);
  });
});

describe('Velbaz : filet de réconciliation Stripe → Commandes', () => {
  const api = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

  it('expose une réconciliation idempotente des sessions payées', () => {
    expect(api).toContain('export async function syncOrdersFromStripe');
    expect(api).toContain('checkout/sessions');
    // On n'importe que les sessions payées de CETTE entreprise.
    expect(api).toMatch(/payment_status !== 'paid'/);
    expect(api).toMatch(/metadata\?\.companyId \|\| ''\) !== companyId/);
    // L'enregistrement passe par la fonction existante (dédoublonnage inclus).
    expect(api).toContain('recordOrderFromStripeSession(companyId, full)');
  });

  it('se déclenche à l’ouverture du panneau Commandes', () => {
    const route = api.slice(api.indexOf("app.get('/companies/:id/orders',"));
    expect(route.slice(0, 900)).toContain('syncOrdersFromStripe(auth.company.id)');
  });

  it('ne martèle pas Stripe (throttle par entreprise)', () => {
    expect(api).toContain('ORDER_SYNC_MIN_MS');
    expect(api).toMatch(/skipped: 'throttled'/);
  });

  it('expose la disponibilité de l’onglet Commandes', () => {
    expect(api).toContain("app.get('/companies/:id/orders/availability'");
    const route = api.slice(api.indexOf("app.get('/companies/:id/orders/availability'"));
    const body = route.slice(0, 2000);
    // Propriétaire seulement, et la règle = commandes existantes OU catalogue vendable.
    expect(body).toContain('requireCompanyOwner');
    expect(body).toContain('orders > 0 || sellable > 0');
    expect(body).toContain('commerceGuard.coversCost');
  });
});
