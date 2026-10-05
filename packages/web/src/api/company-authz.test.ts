import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stripTenantFields } from './company-authz';

// [2026-10-02] Autorisation des routes /companies/:id/*.
// Plusieurs routes ne vérifiaient que la connexion (voire rien) : n'importe
// quel compte pouvait lire ou écrire les produits, fournisseurs, emails,
// tâches Auto… d'un autre projet en changeant l'id dans l'URL.
// Ce test garantit que CHAQUE route /companies/:id/* d'index.ts ouvre sur une
// garde de propriété, sauf la liste blanche des routes publiques par conception
// (vitrine du site généré, appelée par les visiteurs sans compte).

const api = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

const PUBLIC_BY_DESIGN = new Set([
  'GET /companies/:id/website',
  'GET /companies/:id/website/:slugOrLang',
  'GET /companies/:id/website/:lang/:slug',
  'POST /companies/:id/checkout/validate',
  'GET /companies/:id/catalog',
  'POST /companies/:id/orders/confirm',
  'POST /companies/:id/contact',
  'POST /companies/:id/orders/webhook', // signé Stripe (STRIPE_WEBHOOK_SECRET)
]);

const GUARD =
  /requireCompanyOwner\(c|requireCompanyAccess\(c|accessibleCompany\(|eq\(schema\.companies\.userId, user\.id\)|\.userId !== user\.id/;

function companyRoutes(): Array<{ key: string; head: string }> {
  const re = /^app\.(get|post|put|patch|delete|all)\('(\/companies\/:id[^']*)'/gm;
  const hits = [...api.matchAll(re)];
  return hits.map((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index! : api.length;
    // La garde doit être en tête du handler, pas perdue plus bas.
    const head = api.slice(start, end).split('\n').slice(0, 18).join('\n');
    return { key: `${m[1].toUpperCase()} ${m[2]}`, head };
  });
}

describe('routes /companies/:id/* — garde de propriété', () => {
  const routes = companyRoutes();

  it('trouve bien les routes à contrôler', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('chaque route non publique vérifie la propriété du projet', () => {
    const unguarded = routes
      .filter((r) => !PUBLIC_BY_DESIGN.has(r.key) && !GUARD.test(r.head))
      .map((r) => r.key);
    expect(unguarded).toEqual([]);
  });

  it('les routes publiques par conception existent toujours (liste à jour)', () => {
    const keys = new Set(routes.map((r) => r.key));
    for (const k of PUBLIC_BY_DESIGN) expect(keys.has(k)).toBe(true);
  });

  it("aucune route n'utilise encore l'id brut de l'URL sur les routes corrigées", () => {
    for (const p of ['/products', '/suppliers', '/shipping', '/emails', '/designs']) {
      const r = routes.find((x) => x.key === `GET /companies/:id${p}`);
      expect(r).toBeDefined();
      expect(r!.head).not.toContain("c.req.param('id')");
    }
  });

  it('approve / reject vérifient que la tâche appartient au projet', () => {
    for (const k of ['approve', 'reject']) {
      const r = routes.find((x) => x.key === `POST /companies/:id/autopilot/tasks/:taskId/${k}`);
      expect(r!.head).toContain('autopilotTaskBelongsTo(taskId, auth.company.id)');
    }
  });
});

describe('stripTenantFields', () => {
  it("retire l'id et le rattachement imposés par le client", () => {
    expect(
      stripTenantFields({ id: 'x', companyId: 'other', company_id: 'o', userId: 'u', user_id: 'u', name: 'T-shirt', retailPrice: 20 }),
    ).toEqual({ name: 'T-shirt', retailPrice: 20 });
  });

  it('renvoie un objet vide pour un corps invalide', () => {
    expect(stripTenantFields(null)).toEqual({});
    expect(stripTenantFields('x')).toEqual({});
    expect(stripTenantFields([{ id: 1 }])).toEqual({});
  });
});
