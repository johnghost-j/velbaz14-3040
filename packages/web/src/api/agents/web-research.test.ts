import { describe, expect, it } from 'bun:test';
import { cleanTopic } from './web-research';
import { normalizeIdea, SUBJECT_LOCK_START_FR } from '../idea-subject';

// [2026-09-19] Régression : le sujet de recherche web partait avec le libellé
// du bloc de verrou (« [SUJET — VERROUILLÉ, NE PAS RÉINTERPRÉTER] ») au lieu de
// l'activité réelle → 5 requêtes Google hors sujet + scraping de sites au
// hasard, ~7 s perdues avant le vrai travail de génération.
describe('cleanTopic — verrou de sujet', () => {
  it("n'utilise jamais le libellé du verrou comme sujet", () => {
    const idea = normalizeIdea('un site de reservation de cours de yoga en ligne').idea;
    expect(idea.startsWith(SUBJECT_LOCK_START_FR)).toBe(true);
    const topic = cleanTopic(idea, 'Wellness');
    expect(topic).not.toContain('SUJET');
    expect(topic).not.toContain('VERROUILL');
    expect(topic.toLowerCase()).toContain('yoga');
  });

  it('garde le texte utilisateur quand le verrou est présent', () => {
    const idea = normalizeIdea('cree une marque de vetements streetwear').idea;
    const topic = cleanTopic(idea, 'Fashion');
    expect(topic.toLowerCase()).toContain('streetwear');
  });

  it('récupère le sujet cité quand il ne reste que le bloc de verrou', () => {
    const lockOnly = [
      SUBJECT_LOCK_START_FR,
      "- L'entreprise à construire EST : « une boulangerie artisanale », exploitée par l'utilisateur POUR SON PROPRE COMPTE.",
      '[/SUJET]',
    ].join('\n');
    const topic = cleanTopic(lockOnly, 'Food');
    expect(topic).not.toContain('SUJET');
    expect(topic.toLowerCase()).toContain('boulangerie');
  });

  it('continue de distiller un transcript de chat', () => {
    const transcript = [
      'User: salut 👋',
      'AI: Salut ! Je vais créer ton site.',
      'User: je veux une app de reservation de salles de sport',
    ].join('\n');
    const topic = cleanTopic(transcript, 'Fitness');
    expect(topic.toLowerCase()).toContain('salles de sport');
    expect(topic).not.toContain('User:');
    expect(topic).not.toContain('AI:');
  });

  it('retombe sur le secteur si rien de significatif ne survit', () => {
    expect(cleanTopic('   ', 'Technology')).toBe('Technology');
  });
});

describe('cleanTopic — doublons', () => {
  it("ne garde qu'une occurrence d'une phrase répétée deux fois", () => {
    const t = cleanTopic(
      'un site de reservation de cours de yoga en ligne un site de reservation de cours de yoga en ligne',
      'Wellness',
    );
    expect(t).toBe('un site de reservation de cours de yoga en ligne');
  });

  it('laisse intact un texte sans doublon', () => {
    const t = cleanTopic('une boulangerie artisanale a lyon', 'Food');
    expect(t).toBe('une boulangerie artisanale a lyon');
  });
});
