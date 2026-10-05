import { describe, it, expect } from 'bun:test';
import {
  hasBlockingQuestion,
  isNonBlockingPopupType,
  showsAwaitingBadge,
  NON_BLOCKING_POPUP_TYPES,
} from './question-badge';

describe('isNonBlockingPopupType', () => {
  it('reconnaît les pop-ups qui ne demandent rien', () => {
    expect(isNonBlockingPopupType('info')).toBe(true);
    expect(isNonBlockingPopupType('progress')).toBe(true);
  });

  it('considère toute autre pop-up comme une vraie question', () => {
    for (const t of ['confirm', 'choice', 'alert', 'recap', 'secret', 'preview', 'upgrade', 'brand_preview']) {
      expect(isNonBlockingPopupType(t)).toBe(false);
    }
  });

  it('ne casse pas sur un type absent', () => {
    expect(isNonBlockingPopupType(null)).toBe(false);
    expect(isNonBlockingPopupType(undefined)).toBe(false);
    expect(isNonBlockingPopupType('')).toBe(false);
  });

  it('expose la liste des types non bloquants (source unique avec AIPopup)', () => {
    expect([...NON_BLOCKING_POPUP_TYPES]).toEqual(['info', 'progress']);
  });
});

describe('hasBlockingQuestion', () => {
  it('reste éteint sur un projet où rien n’attend de réponse', () => {
    expect(hasBlockingQuestion({})).toBe(false);
    expect(hasBlockingQuestion(null)).toBe(false);
    expect(hasBlockingQuestion(undefined)).toBe(false);
    expect(hasBlockingQuestion({ pendingQuestions: [] })).toBe(false);
  });

  // Le bug signalé : une pop-up informative allumait le rond jaune.
  it('n’allume PAS la pastille pour une pop-up info ou progress', () => {
    expect(hasBlockingQuestion({ pendingPopup: { type: 'info' } })).toBe(false);
    expect(hasBlockingQuestion({ pendingPopup: { type: 'progress' } })).toBe(false);
  });

  it('allume la pastille pour une pop-up qui attend une réponse', () => {
    expect(hasBlockingQuestion({ pendingPopup: { type: 'confirm' } })).toBe(true);
    expect(hasBlockingQuestion({ pendingPopup: { type: 'choice' } })).toBe(true);
    expect(hasBlockingQuestion({ pendingPopup: { type: 'secret' } })).toBe(true);
  });

  it('allume la pastille pour des questions en attente', () => {
    expect(hasBlockingQuestion({ pendingQuestions: [{ q: 'Quel secteur ?' }] })).toBe(true);
  });

  it('allume la pastille pour une approbation, une fiche société ou un plan de pages', () => {
    expect(hasBlockingQuestion({ pendingApproval: { message: 'ok ?' } })).toBe(true);
    expect(hasBlockingQuestion({ pendingCompany: { id: 'c1' } })).toBe(true);
    expect(hasBlockingQuestion({ pendingPagePlan: { pages: [] } })).toBe(true);
  });

  it('ignore une pop-up info même accompagnée d’un état vide', () => {
    expect(hasBlockingQuestion({
      pendingQuestions: [],
      pendingPopup: { type: 'info' },
      pendingApproval: null,
      pendingCompany: null,
      pendingPagePlan: null,
    })).toBe(false);
  });

  it('garde la priorité à la vraie question quand les deux coexistent', () => {
    expect(hasBlockingQuestion({
      pendingQuestions: [{ q: 'x' }],
      pendingPopup: { type: 'progress' },
    })).toBe(true);
  });
});

describe('showsAwaitingBadge', () => {
  it('affiche le rond jaune quand le flag est posé et qu’aucun build ne tourne', () => {
    expect(showsAwaitingBadge(true, false)).toBe(true);
    expect(showsAwaitingBadge(1, undefined)).toBe(true);
  });

  // Un build qui tourne ne peut pas attendre une réponse : flag périmé.
  it('masque le rond jaune pendant qu’un build tourne', () => {
    expect(showsAwaitingBadge(true, true)).toBe(false);
    expect(showsAwaitingBadge(1, true)).toBe(false);
  });

  it('reste éteint sans flag', () => {
    expect(showsAwaitingBadge(false, false)).toBe(false);
    expect(showsAwaitingBadge(null, false)).toBe(false);
    expect(showsAwaitingBadge(undefined, true)).toBe(false);
    expect(showsAwaitingBadge(0, false)).toBe(false);
  });
});
