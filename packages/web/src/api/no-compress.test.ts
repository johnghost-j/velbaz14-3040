import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DOCUMENT_SECURITY_HEADERS, SECURITY_HEADERS } from './security';

// [2026-09-25] Garde-fou de non-régression.
// `app.use('*', compress())` avait cassé TOUTE l'app en production : les
// réponses repartaient avec `content-encoding: gzip` et un corps invalide,
// le navigateur échouait sur `net::ERR_CONTENT_DECODING_FAILED` et le JS
// affichait « Failed to fetch » — connexion et inscription impossibles.
// La compression est faite par l'edge : ce middleware ne doit pas revenir.
describe('pas de compression applicative', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it("n'importe pas hono/compress", () => {
    expect(/^\s*import\s+\{[^}]*compress[^}]*\}\s+from\s+['"]hono\/compress['"]/m.test(src)).toBe(false);
  });

  it("n'enregistre aucun middleware compress()", () => {
    const active = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(/\bcompress\s*\(\s*\)/.test(active)).toBe(false);
  });
});

// La CSP du document doit laisser tourner les <script> inline de index.html
// (fond pré-peint, bootstrap langue), l'attribut onload du <link> Google Fonts
// et le Worker créé depuis un blob: (lib/favicon.ts). Sinon la prod casse en
// silence alors que le dev (Vite, sans CSP) reste vert.
describe('CSP du document', () => {
  const csp = DOCUMENT_SECURITY_HEADERS['Content-Security-Policy'];

  it("autorise les scripts inline et les workers blob:", () => {
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it('garde la CSP des réponses API stricte', () => {
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("script-src 'self'");
    expect(SECURITY_HEADERS['Content-Security-Policy']).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
