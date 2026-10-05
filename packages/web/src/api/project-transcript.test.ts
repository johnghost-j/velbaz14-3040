import { describe, expect, it } from 'bun:test';
import { normalizeIdea } from './idea-subject';
import {
  extractNumberedOptions,
  focusProjectTranscript,
  isActionRequest,
  isProjectIntent,
  parseChoiceNumber,
} from './project-transcript';

// Conversation réelle du 2026-10-02 (projet « MailFlow ») : actions d'abord,
// puis demande d'idées, choix « 1 » et « décide toi-même ».
const MIXED = [
  'User: envoie moi un mail',
  'AI: C’est fait : je viens d’envoyer un email à ton adresse.',
  'User: je veux ue qle mail sois par le nom de john',
  'AI: C’est fait : j’ai envoyé un nouvel email en mettant le nom “John” comme signature.',
  'User: appel moi',
  'AI: Je peux t’appeler. Donne-moi juste ton numéro de téléphone.',
  'User: +32 469186482',
  "AI: Je lance l'appel :",
  '',
  '[CALL_VIEW]{"id":"lc_2KQT2uRvPdR7-7JK"}[/CALL_VIEW]',
  'User: envoi moi un sms',
  'AI: Quel SMS tu veux envoyer (le texte exact) ?',
  'User: test',
  'AI: Je l’envoie tout de suite : SMS “test” à **+32 469186482**.',
  'User: tu la envoyer ?',
  'AI: Oui, le SMS a bien été envoyé.',
  'User: j ai rie ressus',
  'AI: D’accord — on va vérifier. Tu veux que je te renvoie le SMS ?',
  'User: ece que tu est pret pou rme crer mon entrepries ?',
  'AI: Oui, je suis prêt. Dis-moi le **nom de ton entreprise** et ce que tu vends.',
  'User: propose moi des idé',
  "AI: En ce mois d'octobre 2026, voici 4 idées de business :",
  '',
  '1.  **Studio de Mode Circulaire (Upcycling 3.0)** : Une boutique en ligne qui transforme des vêtements de seconde main via des designs uniques, avec un système de rachat automatique.',
  "2.  **Conciergerie pour Résidences Autonomes** : Maintenance spécialisée pour les maisons équipées de systèmes solaires.",
  '3.  **Agence de Micro-Expériences Locales** : Plateforme de réservation d’aventures "slow travel".',
  '4.  **Optimisation de Nutrition Personnalisée** : Un service de box repas basées sur vos données biométriques.',
  '',
  '[QUESTIONS_ASKED]',
  `[QUESTIONS][{"q":"Laquelle de ces pistes t'inspire le plus pour commencer ?","kind":"text","placeholder":"Ta réponse…"}][/QUESTIONS]`,
  "User: Laquelle de ces pistes t'inspire le plus pour commencer ?: 1",
  "AI: C'est noté, nous partons sur la **piste 1**.",
  '[QUESTIONS_ASKED]',
  '[QUESTIONS][{"q":"Quelle est ton idée ?","kind":"text","placeholder":"Ta réponse…"}][/QUESTIONS]',
  "User: I'll skip these questions — decide for yourself and launch directly. Go!",
].join('\n');

describe('focusProjectTranscript', () => {
  it('retire les échanges mail / appel / SMS et garde la partie projet', () => {
    const f = focusProjectTranscript(MIXED);
    expect(f.text).not.toMatch(/envoie moi un mail|nom de john|appel moi|469186482|envoi moi un sms|CALL_VIEW|rie ressus/i);
    expect(f.text).toContain('crer mon entrepries');
    expect(f.text).toContain('propose moi des idé');
    expect(f.droppedActionTurns).toBeGreaterThanOrEqual(14);
  });

  it('remplace « … ?: 1 » par l’idée réellement choisie', () => {
    const f = focusProjectTranscript(MIXED);
    expect(f.chosen?.title).toBe('Studio de Mode Circulaire (Upcycling 3.0)');
    expect(f.text).toContain('[IDÉE CHOISIE] Studio de Mode Circulaire (Upcycling 3.0) — Une boutique en ligne');
    expect(f.text).not.toMatch(/commencer \?: 1/);
    expect(f.text).not.toContain('[QUESTIONS_ASKED]');
  });

  it('est idempotent', () => {
    const once = focusProjectTranscript(MIXED).text;
    expect(focusProjectTranscript(once).text).toBe(once);
  });

  it('laisse un message simple et une conversation sans action intacts', () => {
    expect(focusProjectTranscript('une marque de vêtements').text).toBe('une marque de vêtements');
    const t = 'User: crée-moi une boutique de bougies\nAI: Quel style ?\nUser: minimaliste';
    expect(focusProjectTranscript(t).text).toBe(t);
  });

  it('garde le projet décrit AVANT une action faite en cours de route', () => {
    const t = [
      'User: crée-moi une boutique de bougies artisanales',
      'AI: Super, quel style ?',
      'User: envoie moi un mail avec le résumé',
      'AI: C’est fait, email envoyé.',
      'User: style minimaliste, Belgique, on lance la boutique',
    ].join('\n');
    const f = focusProjectTranscript(t);
    expect(f.text).toContain('boutique de bougies artisanales');
    expect(f.text).toContain('style minimaliste');
    expect(f.text).not.toContain('résumé');
  });

  it('conversation faite uniquement d’actions : texte d’origine (pas d’idée vide)', () => {
    const t = 'User: envoie moi un mail\nAI: C’est fait.';
    expect(focusProjectTranscript(t).text).toBe(t);
  });

  it('garde les blocs ajoutés par le client (plan validé) même après une action', () => {
    const t = 'User: crée-moi une marque de vêtements\nUser: appelle moi au 0611223344\nAI: Je lance l’appel\n\n[PLAN VALIDÉ] Accueil, Boutique';
    const f = focusProjectTranscript(t);
    expect(f.text).toContain('[PLAN VALIDÉ] Accueil, Boutique');
    expect(f.text).not.toContain('0611223344');
  });
});

describe('normalizeIdea sur une conversation mixte', () => {
  it('le sujet verrouillé est l’idée choisie, pas « envoie moi un mail »', () => {
    const n = normalizeIdea(MIXED);
    expect(n.subject).toContain('Studio de Mode Circulaire');
    expect(n.subject).not.toMatch(/mail|sms|appel/i);
    expect(n.level).toBe('first_party');
    expect(n.idea).not.toMatch(/envoie moi un mail|CALL_VIEW|469186482/);
    expect(normalizeIdea(n.idea).idea).toBe(n.idea);
  });

  it('une idée tapée en toutes lettres après la liste gagne aussi', () => {
    const t = [
      'User: envoie moi un sms',
      'AI: Quel texte ?',
      'User: salut',
      'User: propose moi des idées de business',
      'AI: 1. **Boulangerie bio** : pains au levain\n2. **Salle de sport** : coaching',
      'User: Laquelle te plaît ?: une salle de sport pour femmes à Liège',
    ].join('\n');
    expect(normalizeIdea(t).subject).toContain('salle de sport pour femmes');
  });

  it('« la deuxième » choisit bien l’option 2', () => {
    const t = [
      'User: donne moi des idées',
      'AI: 1. **Boulangerie bio** : pains au levain\n2. **Salle de sport** : coaching pour femmes',
      'User: la deuxième',
    ].join('\n');
    expect(normalizeIdea(t).subject).toContain('Salle de sport');
  });
});

describe('détecteurs', () => {
  it('parseChoiceNumber', () => {
    expect(parseChoiceNumber('1')).toBe(1);
    expect(parseChoiceNumber('la 2')).toBe(2);
    expect(parseChoiceNumber('option 3 !')).toBe(3);
    expect(parseChoiceNumber('je prends la 4')).toBe(4);
    expect(parseChoiceNumber('la première')).toBe(1);
    expect(parseChoiceNumber('la dernière')).toBe(-1);
    expect(parseChoiceNumber('une boutique de 2 étages')).toBeNull();
    expect(parseChoiceNumber('25-45€')).toBeNull();
  });

  it('extractNumberedOptions lit titre + description', () => {
    const o = extractNumberedOptions('Voici :\n1. **A propre** : desc a\n2) B — desc b');
    expect(o).toEqual([{ title: 'A propre', description: 'desc a' }, { title: 'B', description: 'desc b' }]);
  });

  it('actions vs projet', () => {
    expect(isActionRequest('envoie moi un mail')).toBe(true);
    expect(isActionRequest('appel moi')).toBe(true);
    expect(isActionRequest('envoi moi un sms')).toBe(true);
    expect(isActionRequest('crée-moi une boutique de bougies')).toBe(false);
    expect(isProjectIntent('ece que tu est pret pou rme crer mon entrepries ?')).toBe(true);
    expect(isProjectIntent('propose moi des idé')).toBe(true);
    expect(isProjectIntent('envoie moi un mail')).toBe(false);
  });
});
