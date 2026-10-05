import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isAdminUser } from './security';

// [2026-09-25] Growth Engine = bêta privée admin.
// Le Growth Engine envoie de VRAIS emails / SMS / appels IA dès que les
// fournisseurs sont configurés. Tant qu'il est en bêta il est réservé à
// l'admin : masquer l'onglet ne suffit pas (l'API resterait appelable en
// direct), donc le gate vit au niveau des routes /companies/:id/growth/*.
// Ces tests empêchent la régression des deux côtés.

const api = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const companyPage = readFileSync(
  new URL('../web/pages/company.tsx', import.meta.url),
  'utf8',
);
const chatPage = readFileSync(
  new URL('../web/pages/chat.tsx', import.meta.url),
  'utf8',
);

function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}

describe('Growth Engine — bêta admin (backend)', () => {
  const src = stripComments(api);

  it("gate TOUTES les routes /companies/:id/growth/* par un middleware", () => {
    expect(src).toContain("app.use('/companies/:id/growth/*'");
  });

  it('le middleware refuse les non-admins via isAdminUser', () => {
    const start = src.indexOf("app.use('/companies/:id/growth/*'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 400);
    expect(block).toContain('isAdminUser(user)');
    // 401 si pas connecté, 404 (pas 403) sinon : la feature reste invisible.
    expect(block).toContain('401');
    expect(block).toContain('404');
  });

  it('le middleware est déclaré avant la première route growth', () => {
    const gate = src.indexOf("app.use('/companies/:id/growth/*'");
    const firstRoute = src.search(/app\.(get|post)\('\/companies\/:id\/growth\//);
    expect(gate).toBeGreaterThan(-1);
    expect(firstRoute).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstRoute);
  });
});

describe('Growth Engine — bêta admin (interface)', () => {
  it("company.tsx calcule growthEnabled depuis isAdminUser", () => {
    expect(companyPage).toContain("import { useAuth, isAdminUser }");
    expect(companyPage).toContain('const growthEnabled = isAdminUser(user)');
  });

  it("l'onglet Growth n'est listé que pour un admin", () => {
    expect(companyPage).toContain("...(growthEnabled ? [{ key: 'growth' as Tab, label: 'Growth' }] : [])");
    // plus d'entrée d'onglet inconditionnelle
    expect(companyPage).not.toContain("{ key: 'growth', label: 'Growth' },");
  });

  it("GrowthTab n'est jamais monté pour un non-admin (zéro requête réseau)", () => {
    expect(companyPage).toContain("{tab === 'growth' && growthEnabled && (");
  });

  it("un lien ?tab=growth retombe sur l'onglet App pour un non-admin", () => {
    expect(companyPage).toContain("if (!loading && !growthEnabled && tab === 'growth') setTab('website')");
  });

  it("chat.tsx ne détecte pas d'intention growth pour un non-admin", () => {
    const start = chatPage.indexOf('function detectGrowthIntent');
    expect(start).toBeGreaterThan(-1);
    const block = stripComments(chatPage.slice(start, start + 600));
    expect(block).toContain('if (!isAdminUser(user)) return false;');
  });
});

describe('Growth Engine — allowlist admin', () => {
  it("l'admin passe, un utilisateur normal non", () => {
    expect(isAdminUser({ email: 'johnemadmansour1@gmail.com', role: 'user' })).toBe(true);
    expect(isAdminUser({ email: 'random@user.com', role: 'user' })).toBe(false);
    expect(isAdminUser(null)).toBe(false);
  });
});
