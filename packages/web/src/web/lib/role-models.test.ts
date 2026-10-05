import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { roleModel, DEFAULT_ROLE_MODEL, MARKETING_MODEL } from './role-models';

const SRC = join(import.meta.dir, '../..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

// L'étiquette affichée sous une étape de build est une DÉDUCTION du rôle
// (agent_activity ne stocke pas le modèle). Ces tests la confrontent au code
// qui appelle réellement l'IA : c'est ce qui a manqué quand les deux copies de
// la table annonçaient sonnet-4.6 pour des agents passés sur mini.

describe('roleModel', () => {
  it('annonce le modèle du builder pour les étapes engineering', () => {
    const engine = read('api/builder/engine.ts');
    const codeModel = engine.match(/const CODE_MODEL = "([^"]+)"/)?.[1];
    expect(codeModel).toBeTruthy();
    // L'étiquette front est sans préfixe provider.
    expect(codeModel!.endsWith(roleModel('engineering'))).toBe(true);
    expect(roleModel('engineer')).toBe(roleModel('engineering'));
  });

  it('annonce le modèle réel de la stratégie marketing', () => {
    const strat = read('api/builder/marketing-strategy.ts');
    expect(strat).toContain(MARKETING_MODEL);
    expect(MARKETING_MODEL.endsWith(roleModel('marketing'))).toBe(true);
  });

  it('ne fait plus passer support et supply_chain pour du sonnet', () => {
    // Retirés des agents texte le 08/09 (12× plus cher que mini).
    expect(roleModel('support')).toBe('gpt-5.4-mini');
    expect(roleModel('supply_chain')).toBe('gpt-5.4-mini');
  });

  it('étiquette design avec le modèle image, pas un modèle texte', () => {
    expect(roleModel('design')).toContain('image');
  });

  it('retombe sur la marque pour un rôle sans appel IA propre', () => {
    // growth/operations/trading = Printify, ordres, leads de démo : aucun LLM.
    for (const r of ['growth', 'operations', 'trading', 'browser', undefined, null, '']) {
      expect(roleModel(r as any)).toBe(DEFAULT_ROLE_MODEL);
    }
  });
});

describe('table des étiquettes', () => {
  it("n'est plus dupliquée dans les deux consommateurs", () => {
    // Elles vivaient en double (build-store.ts + chat.tsx) et avaient dérivé.
    for (const f of ['web/lib/build-store.ts', 'web/pages/chat.tsx']) {
      const src = read(f);
      expect(src).not.toContain('ROLE_MODEL_MAP');
      expect(src).not.toContain('ACTIVITY_ROLE_MODEL');
      expect(src).toContain('roleModel(');
    }
  });
});

describe('commentaires du builder', () => {
  it('ne décrit plus un partage Sonnet/Opus qui n\'existe pas', () => {
    const engine = read('api/builder/engine.ts');
    const edit = engine.match(/const EDIT_MODEL = "([^"]+)"/)?.[1];
    // Tant qu'EDIT_MODEL n'est pas un Opus, aucun commentaire ne doit dire
    // qu'Opus patche.
    if (!/opus/i.test(edit || '')) {
      expect(engine).not.toMatch(/Opus patche/);
      expect(engine).not.toMatch(/MODIFICATION d'un fichier EXISTANT : Opus/);
    }
  });
});
