import { describe, expect, it } from 'bun:test';
import {
  SOCIAL_ASK_MARKER,
  isSkipAnswer,
  isSocialSendTurn,
  planSocialSend,
  socialSendBlock,
  stripSendStatusClaims,
  wasSocialQuestionAsked,
} from './send-intent';

/**
 * Bug signalé : après un « Skip » sur le questionnaire d'envoi social, LA MÊME
 * question était reposée. Exigence : une question passée ne doit JAMAIS
 * revenir.
 */
describe('flux « skip » du questionnaire d’envoi social', () => {
  const SKIP = "I'll skip these questions — decide for yourself and launch directly. Go!";
  // Question réellement produite par le modèle en test navigateur (prose
  // promue en formulaire) : aucun de nos libellés fixes n'y apparaît.
  const MODEL_QUESTION =
    'Sur quel réseau veux-tu l’envoyer (Twitter/X, Discord, Reddit, Instagram) et quel texte exact dois-je publier ?'
    + '\n\n[QUESTIONS_ASKED]\n[QUESTIONS][{"q":"Sur quel réseau veux-tu l’envoyer ?"}][/QUESTIONS]';

  it('reconnaît les formulations de skip (FR et EN)', () => {
    for (const m of [SKIP, 'je passe', 'skip', 'décide pour moi', 'peu importe', 'à toi de voir']) {
      expect(isSkipAnswer(m)).toBe(true);
    }
    expect(isSkipAnswer('envoie « bonjour » sur twitter')).toBe(false);
  });

  it('voit la question posée via le marqueur [SOCIAL_ASK]', () => {
    expect(wasSocialQuestionAsked([`ok${SOCIAL_ASK_MARKER}`])).toBe(true);
  });

  it('voit aussi une question d’envoi formulée librement par le modèle', () => {
    expect(wasSocialQuestionAsked([MODEL_QUESTION])).toBe(true);
  });

  it('ne confond pas une question de build avec une question d’envoi', () => {
    expect(wasSocialQuestionAsked(['Quel texte veux-tu pour le bouton ?'])).toBe(false);
    expect(wasSocialQuestionAsked(['Quelles pages veux-tu sur le site ?'])).toBe(false);
  });

  it('traite le skip comme un tour d’envoi social (pas un ordre de build)', () => {
    const history = [{ role: 'assistant', content: MODEL_QUESTION }];
    expect(isSocialSendTurn(SKIP, history)).toBe(true);
    // Hors contexte d'envoi, le même message n'est PAS un tour d'envoi.
    expect(isSocialSendTurn(SKIP, [{ role: 'assistant', content: 'Quelles pages veux-tu ?' }]))
      .toBe(false);
  });

  it('décide à la place de l’utilisateur au lieu de reposer la question', () => {
    const plan = planSocialSend(SKIP, ['envoie un message sur les réseaux'], ['twitter', 'discord'], {
      alreadyAsked: true,
    });
    expect(plan.platforms).toEqual(['twitter', 'discord']);
    expect(plan.ambiguous).toBe(false);
    // Aucun texte donné + « décide pour moi » → l'IA rédige le message.
    expect(plan.text).toBeNull();
    expect(plan.writeItself).toBe(true);
  });

  it('garde la demande explicite intacte (pas de décision à la place)', () => {
    const plan = planSocialSend('poste sur twitter : « Nouveau menu ☕ »', [], ['twitter', 'discord']);
    expect(plan.platforms).toEqual(['twitter']);
    expect(plan.text).toBe('Nouveau menu ☕');
    expect(plan.writeItself).toBe(false);
  });

  it('retire la prose qui annonce un résultat d’envoi, garde le reste', () => {
    const reply = "On dirait que l’envoi sur Discord a échoué (connexion/API). Je réessaie tout de suite.\n\nEt pour ton message : c’est top 👍 — clair et chaleureux.";
    const out = stripSendStatusClaims(reply);
    expect(out).not.toContain('échoué');
    expect(out).not.toContain('réessaie');
    expect(out).toContain('c’est top');
  });

  it('ne touche pas une prose d’envoi normale', () => {
    const ok = "Je l'envoie sur X (Twitter) et Discord.";
    expect(stripSendStatusClaims(ok)).toBe(ok);
  });

  // Bug signalé : « envoie un message » → question → clic Skip, et l'IA
  // ÉDITAIT L'APP (le classifieur d'édition lisait « launch directly. Go! »
  // comme « vas-y, fais-le »). Le tour doit rester un tour d'ENVOI.
  it('une réponse « plateforme + décide pour le reste » reste un tour d’envoi', () => {
    const answer = "Sur quelle plateforme veux-tu que j'envoie ce message ?: X (Twitter) | For the rest, decide for yourself — don't ask me again.";
    const history = [{ role: 'assistant', content: MODEL_QUESTION }];
    expect(isSocialSendTurn(answer, history)).toBe(true);
    expect(isSkipAnswer(answer)).toBe(true);
    const plan = planSocialSend(answer, ['envoi moi un message'], ['twitter', 'discord']);
    expect(plan.platforms).toEqual(['twitter']);
    // « ne me demande plus » → on ne repose PAS la question du texte.
    expect(plan.writeItself).toBe(true);
  });

  it('le skip après une question d’envoi n’est jamais une édition d’app', () => {
    const history = [{ role: 'assistant', content: `ok${SOCIAL_ASK_MARKER}` }];
    // Ce sont exactement les formulations envoyées par le bouton Skip du front.
    for (const m of [SKIP, 'je passe, décide pour moi', 'skip']) {
      expect(isSocialSendTurn(m, history)).toBe(true);
    }
  });

  it('skip sans aucun compte lié : ne repose pas la question (consigne de connexion)', () => {
    const plan = planSocialSend(SKIP, ['envoie un message sur les réseaux'], [], {
      alreadyAsked: true,
    });
    // Aucune plateforme décidable → l'API répond « connecte un compte »
    // (branche needPlatform && alreadyAsked && !linkedIds.length) au lieu de
    // reposer la question de plateforme.
    expect(plan.platforms).toEqual([]);
    expect(plan.connected).toEqual([]);
    expect(plan.ambiguous).toBe(true);
    expect(plan.writeItself).toBe(true);
    // La consigne de connexion ne doit pas être rognée par le nettoyage de prose.
    const notice = "Aucun compte social n'est encore lié à ce projet — connecte-en un (X, Discord, Reddit ou Instagram) depuis le Dashboard et je publie tout de suite.";
    expect(stripSendStatusClaims(notice)).toBe(notice);
  });

  it('identifie chaque envoi rédigé par l’IA (pas de collision de mémo)', () => {
    const a = socialSendBlock(['twitter'], '', 'aaa111');
    const b = socialSendBlock(['twitter'], '', 'bbb222');
    expect(a).not.toBe(b);
    expect(a).toContain('"id":"aaa111"');
    expect(b).toContain('"id":"bbb222"');
  });
});
