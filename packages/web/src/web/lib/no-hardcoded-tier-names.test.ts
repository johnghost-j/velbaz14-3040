import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// [2026-10-03] Les comptes normaux n'ont qu'un modèle (Velbaz). Les noms des
// paliers admin (Lite / Pro / Max) ne doivent venir QUE de lib/brand.ts, lus
// par lib/model-tiers.ts (menu admin). Un nom écrit en dur ailleurs (ex. la
// pastille « Velbaz Lite » de la page d'attente) s'affiche à tout le monde.
const WEB_ROOT = join(import.meta.dir, '..');
const ALLOWED = new Set(['lib/brand.ts']);
const TIER_NAME = /Velbaz\s+(Lite|Pro|Max)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*');
}

describe('noms de paliers admin', () => {
  it("n'apparaissent en dur nulle part dans le front (hors brand.ts)", () => {
    const hits: string[] = [];
    for (const f of files(WEB_ROOT)) {
      const rel = relative(WEB_ROOT, f);
      if (ALLOWED.has(rel)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (TIER_NAME.test(line) && !isComment(line)) hits.push(`${rel}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
