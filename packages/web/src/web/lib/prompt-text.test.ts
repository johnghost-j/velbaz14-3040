/**
 * Barre de prompt — texte collé transformé en pièce jointe.
 *
 * [2026-09-19] Ce qui doit rester vrai :
 *  • un collage court n'est pas touché (il entre dans le champ normalement) ;
 *  • un collage long devient un .txt et n'entre PAS dans le champ ;
 *  • l'aller-retour base64 rend le texte à l'identique, accents et emoji
 *    compris (btoa seul casse sur l'UTF-8) et sans exploser sur un gros texte.
 */
import { describe, expect, it, jest } from 'bun:test';
import {
  decodeTextAttachment,
  handleLongTextPaste,
  MAX_PROMPT_CHARS,
  pastedTextAttachment,
  PROMPT_COUNTER_THRESHOLD,
} from './prompt-text';

/** Faux événement de collage, avec juste ce que le handler lit. */
function pasteEvent(text: string) {
  const preventDefault = jest.fn();
  return {
    event: { clipboardData: { getData: () => text }, preventDefault } as never,
    preventDefault,
  };
}

describe('pastedTextAttachment', () => {
  it('rend le texte à l’identique après l’aller-retour base64', () => {
    const text = 'Cahier des charges : boutique éàü, marge 40 %, 😀 中文.';
    const att = pastedTextAttachment(text, 'Texte collé', 1);
    expect(decodeTextAttachment(att)).toBe(text);
  });

  it('nomme le fichier d’après le libellé traduit, en gardant les accents', () => {
    const att = pastedTextAttachment('peu importe', 'Texte collé', 3);
    expect(att.name).toBe('Texte collé-3.txt');
    expect(att.mimeType).toBe('text/plain');
    expect(att.type).toBe('text');
  });

  it('retombe sur un nom par défaut quand le libellé n’a aucun caractère utilisable', () => {
    expect(pastedTextAttachment('x', '///', 1).name).toBe('texte-1.txt');
  });

  it('compte la taille en octets UTF-8, pas en caractères', () => {
    // « é » = 2 octets, l’emoji = 4 : une taille en caractères serait fausse.
    const att = pastedTextAttachment('é😀', 'Texte collé', 1);
    expect(att.size).toBe(6);
  });

  it('encode un très gros texte sans exploser la pile', () => {
    // Avant le découpage en tranches : RangeError au-delà de ~100 ko.
    const text = 'Ligne éàü 😀 de test\n'.repeat(25000);
    const att = pastedTextAttachment(text, 'Texte collé', 1);
    expect(decodeTextAttachment(att)).toBe(text);
  });

  it('renvoie une chaîne vide plutôt que de lever sur une donnée illisible', () => {
    expect(decodeTextAttachment({ data: 'pas-du-base64' })).toBe('');
  });
});

describe('handleLongTextPaste', () => {
  it('laisse passer un collage sous la limite', () => {
    const { event, preventDefault } = pasteEvent('a'.repeat(MAX_PROMPT_CHARS));
    const onAttach = jest.fn();
    expect(handleLongTextPaste(event, { label: 'Texte collé', index: 1, onAttach })).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });

  it('transforme un collage au-delà de la limite en pièce jointe, hors du champ', () => {
    const text = 'b'.repeat(MAX_PROMPT_CHARS + 1);
    const { event, preventDefault } = pasteEvent(text);
    const onAttach = jest.fn();
    const onNotice = jest.fn();
    expect(handleLongTextPaste(event, { label: 'Texte collé', index: 2, onAttach, onNotice })).toBe(true);
    // preventDefault : sans lui, le mur de texte entrait AUSSI dans le champ.
    expect(preventDefault).toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(text.length);
    const att = onAttach.mock.calls[0][0];
    expect(att.name).toBe('Texte collé-2.txt');
    expect(decodeTextAttachment(att)).toBe(text);
  });

  it('ne fait rien quand le presse-papiers ne contient pas de texte', () => {
    const preventDefault = jest.fn();
    const event = { clipboardData: null, preventDefault } as never;
    const onAttach = jest.fn();
    expect(handleLongTextPaste(event, { label: 'Texte collé', index: 1, onAttach })).toBe(false);
    expect(onAttach).not.toHaveBeenCalled();
  });
});

describe('seuil du compteur', () => {
  it('reste sous la limite d’envoi, pour prévenir avant le blocage', () => {
    expect(PROMPT_COUNTER_THRESHOLD).toBeLessThan(MAX_PROMPT_CHARS);
  });
});
