/**
 * Mise en page d'un run — ce qui doit rester vrai.
 *
 * [2026-09-19] Les régressions qu'on ne veut plus jamais revoir :
 *  • un fichier déposé au milieu du travail qui disparaît avec le déroulé ;
 *  • le texte de conclusion replié comme un simple commentaire d'étape ;
 *  • une ligne vide fantôme là où il n'y avait qu'un fichier ;
 *  • quelque chose qui se déplace tout seul pendant que le run tourne.
 */
import { describe, expect, it } from 'bun:test';
import { collectFileTags, layoutRun, stripFileTags, type RunItem } from './run-layout';

const build = (): RunItem => ({ type: 'build' });
const ai = (content: string): RunItem => ({ type: 'msg', role: 'assistant', content });
const team = (): RunItem => ({ type: 'msg', role: 'assistant', content: 'x', hasTeamMsgs: true });

describe('stripFileTags', () => {
  it('retire la balise et ne laisse pas de trou', () => {
    expect(stripFileTags('Voici le rapport.\n[FILE:rapport.pdf]\n')).toBe('Voici le rapport.');
  });

  it('rend vide un texte qui ne contenait que des fichiers', () => {
    expect(stripFileTags('[FILE:a.csv]\n[FILE:b.csv]')).toBe('');
  });

  it('garde le texte intact quand il n\'y a aucun fichier', () => {
    expect(stripFileTags('Je regarde les chiffres…')).toBe('Je regarde les chiffres…');
  });

  it('ne colle pas deux paragraphes séparés par un fichier', () => {
    expect(stripFileTags('Avant.\n\n[FILE:x.pdf]\n\nAprès.')).toBe('Avant.\n\nAprès.');
  });
});

describe('collectFileTags', () => {
  it('rend les balises dans l\'ordre', () => {
    expect(collectFileTags('a [FILE:un.pdf] b [FILE:deux.csv]')).toEqual([
      '[FILE:un.pdf]',
      '[FILE:deux.csv]',
    ]);
  });

  it('rend une liste vide sans balise', () => {
    expect(collectFileTags('rien ici')).toEqual([]);
  });
});

describe('layoutRun — run terminé', () => {
  it('sort le DERNIER texte de l\'IA du déroulé', () => {
    const r = layoutRun([build(), ai('je cherche…'), build(), ai('voilà le résultat')]);
    expect(r.recapIdx).toBe(3);
    expect(r.visibleIdx).toEqual([1]);
  });

  it('remonte en fin de run un fichier déposé au milieu', () => {
    const r = layoutRun([build(), ai('le devis :\n[FILE:devis.pdf]'), build(), ai('fini')]);
    expect(r.fileTags).toEqual(['[FILE:devis.pdf]']);
    expect(r.visibleIdx).toEqual([1]);
  });

  it('efface le texte qui n\'était qu\'un fichier', () => {
    const r = layoutRun([build(), ai('[FILE:rapport.pdf]'), build(), ai('terminé')]);
    expect(r.visibleIdx).toEqual([]);
    expect(r.fileTags).toEqual(['[FILE:rapport.pdf]']);
  });

  it('garde aussi les fichiers émis dans le récap', () => {
    const r = layoutRun([build(), ai('voici tout\n[FILE:final.pdf]')]);
    expect(r.recapIdx).toBe(1);
    expect(r.fileTags).toEqual(['[FILE:final.pdf]']);
  });

  it('ne montre pas deux fois le même fichier', () => {
    const r = layoutRun([ai('[FILE:a.pdf]'), build(), ai('revoici [FILE:a.pdf]')]);
    expect(r.fileTags).toEqual(['[FILE:a.pdf]']);
  });

  it('n\'oublie pas les fichiers d\'un run sans récap', () => {
    // Seule une conversation d'équipe suit les étapes : pas de récap, mais le
    // fichier doit quand même ressortir.
    const r = layoutRun([build(), ai('[FILE:orphelin.csv]'), team()]);
    expect(r.recapIdx).toBe(-1);
    expect(r.fileTags).toEqual(['[FILE:orphelin.csv]']);
  });

  it('ne prend jamais une conversation d\'équipe pour le récap', () => {
    const r = layoutRun([build(), ai('la réponse'), team()]);
    expect(r.recapIdx).toBe(1);
  });

  it('survit à un run fait d\'étapes seulement', () => {
    const r = layoutRun([build(), build()]);
    expect(r).toEqual({ recapIdx: -1, visibleIdx: [], fileTags: [] });
  });
});

describe('layoutRun — run en cours', () => {
  it('ne déplace aucun texte pendant que ça tourne', () => {
    const r = layoutRun([build(), ai('je continue…'), build(), ai('presque fini')], true);
    expect(r.recapIdx).toBe(-1);
    expect(r.visibleIdx).toEqual([1, 3]);
  });

  it('montre quand même les fichiers déjà déposés', () => {
    const r = layoutRun([build(), ai('tiens :\n[FILE:brouillon.md]')], true);
    expect(r.fileTags).toEqual(['[FILE:brouillon.md]']);
  });
});
