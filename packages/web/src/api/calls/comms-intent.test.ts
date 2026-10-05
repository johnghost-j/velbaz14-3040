import { describe, expect, test } from 'bun:test';
import { commsIntentKind, isCommsTurn, isCommsRefusal, claimsCommsLaunch, commsOverAsked, commsFallbackReply, toE164, findPhones } from './comms-intent';

describe('commsIntentKind', () => {
  test('appels', () => {
    for (const m of ['appel moi', 'appelle-moi', 'Appelle Paul au 06 11 22 33 44', 'tu peux téléphoner au client ?', 'passe un coup de fil à Marc', 'call me', 'rappelle le 06 12 34 56 78'])
      expect(commsIntentKind(m)).toBe('call');
  });
  test('sms', () => {
    for (const m of ['envoie un sms à Julie', 'envoie un texto au 0611223344', 'envoie un message au 06 11 22 33 44', 'text me'])
      expect(commsIntentKind(m)).toBe('sms');
  });
  test('faux positifs', () => {
    for (const m of ["comment s'appelle mon projet ?", 'je m’appelle Jean', "réponds à l'appel d'offres", 'crée un site appelé Velbaz', 'ajoute un call to action', 'rappelle-moi l’idée du projet', "l'appel API échoue", 'envoie un message sur Discord'])
      expect(commsIntentKind(m)).toBeNull();
  });
});

describe('isCommsTurn', () => {
  test('suite : le numéro après la question', () => {
    const h = [{ role: 'user', content: 'appel moi' }, { role: 'assistant', content: 'À quel numéro ?' }];
    expect(isCommsTurn('06 11 22 33 44', h)).toBe(true);
    expect(isCommsTurn('crée une landing page', [{ role: 'user', content: 'salut' }])).toBe(false);
  });
});

describe('isCommsRefusal', () => {
  test('refus détectés', () => {
    expect(isCommsRefusal("I appreciate you sharing this context, but I need to be clear: I can't make actual calls or send real SMS messages.")).toBe(true);
    expect(isCommsRefusal("What you're showing me looks like a simulated demo interface, but I don't have access to: Phone systems or SMS APIs")).toBe(true);
    expect(isCommsRefusal("Désolé, je ne peux pas passer d'appels téléphoniques.")).toBe(true);
    expect(isCommsRefusal("Je n'ai pas la possibilité d'envoyer des SMS.")).toBe(true);
  });
  test('réponses normales', () => {
    expect(isCommsRefusal("Je peux t'appeler. À quel numéro ?")).toBe(false);
    expect(isCommsRefusal("C'est parti :\n[CALL]{\"to\":\"+33611223344\"}[/CALL]")).toBe(false);
    expect(isCommsRefusal('Voici ta page d’accueil mise à jour.')).toBe(false);
  });
});

describe('numéros', () => {
  test('E.164', () => {
    expect(toE164('06 11 22 33 44')).toBe('+33611223344');
    expect(toE164('+44 7700 900123')).toBe('+447700900123');
    expect(toE164('0033 6 11 22 33 44')).toBe('+33611223344');
    expect(toE164('12')).toBeNull();
    expect(findPhones('le 2026-10-01 à 14h')).toEqual([]);
  });
});

describe('commsFallbackReply', () => {
  test('appel sans numéro → demande le numéro (jamais un refus)', () => {
    const r = commsFallbackReply('appel moi');
    expect(r).toContain('numéro');
    expect(r).not.toContain('[CALL]');
    expect(isCommsRefusal(r)).toBe(false);
  });
  test('appel avec numéro → bloc [CALL] valide', () => {
    const r = commsFallbackReply('appelle Paul au 06 11 22 33 44 pour lui proposer un rendez-vous', [], 'Démo');
    const m = r.match(/\[CALL\]([\s\S]*?)\[\/CALL\]/);
    expect(m).not.toBeNull();
    const d = JSON.parse(m![1]);
    expect(d.to).toBe('+33611223344');
    expect(d.language).toBe('fr');
    expect(d.goal).toContain('rendez-vous');
  });
  test('numéro donné au tour suivant', () => {
    const h = [{ role: 'user', content: 'appelle mon client' }, { role: 'assistant', content: 'Quel numéro ?' }];
    expect(commsFallbackReply('0611223344', h)).toContain('"to":"+33611223344"');
  });
  test('sms sans texte → demande le texte', () => {
    expect(commsFallbackReply('envoie un sms au 06 11 22 33 44')).toContain('écris');
  });
  test('anglais', () => {
    expect(commsFallbackReply('call me')).toContain('What number');
  });
});

describe('claimsCommsLaunch', () => {
  test('annonce sans bloc', () => {
    expect(claimsCommsLaunch('Parfait — je lance l’appel à ==+33611223344== pour te présenter l’offre traiteur.')).toBe(true);
    expect(claimsCommsLaunch("J'envoie le SMS à Claire.")).toBe(true);
    expect(claimsCommsLaunch('Calling you now!')).toBe(true);
    expect(claimsCommsLaunch('Voici trois idées de menus.')).toBe(false);
  });
  test('sms avec texte entre guillemets → bloc [SMS]', () => {
    const r = commsFallbackReply('envoie un sms au 06 11 22 33 44 : « Bonjour, votre commande est prête »');
    const d = JSON.parse(r.match(/\[SMS\]([\s\S]*?)\[\/SMS\]/)![1]);
    expect(d.to).toBe('+33611223344');
    expect(d.message).toBe('Bonjour, votre commande est prête');
  });
});

describe('suite de conversation (cas réel +32)', () => {
  const h = [
    { role: 'user', content: 'appel moi' },
    { role: 'assistant', content: 'Je peux t’appeler—donne-moi juste ton numéro au format international (ex: +33…).' },
    { role: 'user', content: '0469186482' },
    { role: 'assistant', content: 'C’est en France (+33) ? Sinon donne-moi l’indicatif.' },
    { role: 'user', content: '+32' },
  ];
  test('le tour « +32 469186482 » reste un tour d’appel', () => {
    expect(isCommsTurn('+32 469186482', h)).toBe(true);
  });
  test('fallback → bloc [CALL] vers le bon numéro belge', () => {
    const r = commsFallbackReply('+32 469186482', h);
    expect(JSON.parse(r.match(/\[CALL\]([\s\S]*?)\[\/CALL\]/)![1]).to).toBe('+32469186482');
  });
  test('numéro ambigu « 0469… » → demande l’indicatif, pas d’appel', () => {
    const r = commsFallbackReply('0469186482', h.slice(0, 2));
    expect(r).not.toContain('[CALL]');
    expect(r).toContain('indicatif');
  });
  test('après la carte d’appel, la demande n’est plus en attente', () => {
    expect(isCommsTurn('merci', [...h, { role: 'assistant', content: '[CALL_VIEW]{"id":"lc_x"}[/CALL_VIEW]' }])).toBe(false);
  });
});

describe('commsOverAsked', () => {
  const h = [
    { role: 'user', content: 'appel moi' },
    { role: 'assistant', content: 'À quel numéro ?' },
    { role: 'user', content: '+33 6 11 22 33 44' },
    { role: 'assistant', content: 'Quel objectif ?' },
  ];
  test('déjà demandé + numéro connu → on arrête de questionner', () => {
    expect(commsOverAsked('juste pour tester', h, 'Tu veux un test bonjour ou un test rendez-vous ?')).toBe(true);
  });
  test('première question → normal', () => {
    expect(commsOverAsked('appel moi', [], 'À quel numéro ?')).toBe(false);
  });
  test('numéro ambigu → on ne force rien', () => {
    expect(commsOverAsked('pour tester', [h[0], h[1], { role: 'user', content: '0469186482' }, h[3]], 'Quel pays ?')).toBe(false);
  });
});
