import { describe, it, expect } from 'vitest';
import { detectActionRequest, isActionRefusal, claimsActionDone, reportFromCalls, followUpActionKind, emailStillPending } from './action-intent';

describe('detectActionRequest', () => {
  const email = [
    'envoie-moi un mail à mon compte',
    'Envoie moi un email avec le résumé',
    'tu peux m\'envoyer un mail de test ?',
    'mail-moi la liste',
    'send me an email with the plan',
    'écris un mail à jean@exemple.be pour lui dire bonjour',
    'envoie-le-moi par mail',
  ];
  for (const m of email) it(`email : ${m}`, () => expect(detectActionRequest(m)).toBe('email'));

  const image = ['génère une image de chat astronaute', 'fais-moi une illustration d\'un phare', 'dessine un dragon en image', 'generate an image of a sunset'];
  for (const m of image) it(`image : ${m}`, () => expect(detectActionRequest(m)).toBe('image'));

  it('document seulement dans un projet', () => {
    expect(detectActionRequest('génère un pdf du business plan', { inProject: true })).toBe('document');
    expect(detectActionRequest('génère un pdf du business plan')).toBeNull();
  });

  const none = [
    'crée un site qui envoie des mails aux clients',
    'crée une boutique avec des photos de produits',
    'ajoute un formulaire qui envoie un email',
    'fais-moi un logo',
    'salut ça va ?',
    'c\'est quoi un mail ?',
    'crée-moi une entreprise de café',
    'mets en place une newsletter par mail',
    "mon site n'envoie pas les mails de confirmation",
    'les mails envoyés par mon site arrivent en spam',
  ];
  for (const m of none) it(`pas d'action : ${m}`, () => expect(detectActionRequest(m, { inProject: true })).toBeNull());
});

describe('filets anti-refus / anti-faux-succès', () => {
  it('refus détecté', () => {
    expect(isActionRefusal("Désolé, je ne peux pas envoyer d'email.", 'email')).toBe(true);
    expect(isActionRefusal("I can't generate images.", 'image')).toBe(true);
    expect(isActionRefusal('Quel sujet veux-tu pour le mail ?', 'email')).toBe(false);
  });
  it('faux succès détecté', () => {
    expect(claimsActionDone("C'est fait, je t'ai envoyé le mail !", 'email')).toBe(true);
    expect(claimsActionDone('Ton email est envoyé.', 'email')).toBe(true);
    expect(claimsActionDone('À quelle adresse ?', 'email')).toBe(false);
    expect(claimsActionDone('Voici ton image : [IMG:https://x/y.png]', 'image')).toBe(true);
  });
  it('compte rendu factuel à partir du journal', () => {
    const r = reportFromCalls([
      { tool: 'web_search', ok: true, summary: 'x' },
      { tool: 'send_email', ok: true, summary: 'envoyé à a@b.be' },
      { tool: 'generate_image', ok: true, summary: 'https://cdn/x.png' },
      { tool: 'create_document', ok: true, summary: 'documents/plan.md|Plan' },
    ]);
    expect(r).toContain('envoyé à a@b.be');
    expect(r).toContain('[IMG:https://cdn/x.png]');
    expect(r).toContain('[FILE:documents/plan.md|Plan]');
    expect(r).not.toContain('web_search');
    expect(reportFromCalls([{ tool: 'web_search', ok: true, summary: 'x' }])).toBe('');
  });
});

describe('followUpActionKind', () => {
  const asked = [
    { role: 'user', content: 'envoie un mail à mon associé' },
    { role: 'assistant', content: "Il me faut l'adresse de ton associé : laquelle ?" },
  ];
  it('réponse à la question de l\'IA = suite de l\'action', () => {
    expect(followUpActionKind(asked, "son adresse c'est jean@ex.be")).toBe('email');
  });
  it('pas de question posée → pas de suite', () => {
    expect(followUpActionKind([asked[0], { role: 'assistant', content: 'Email envoyé.' }], 'merci')).toBeNull();
  });
  it('action déjà faite + question de politesse → pas de doublon', () => {
    expect(followUpActionKind([asked[0], { role: 'assistant', content: "C'est fait, je t'ai envoyé le mail ! Autre chose ?" }], 'non merci')).toBeNull();
  });
  it('une demande de build reste un build', () => {
    expect(followUpActionKind(asked, 'crée-moi un site de bougies')).toBeNull();
  });
  it('demande d\'info SANS « ? » (texte mesuré le 2026-10-02) = suite', () => {
    const h = [
      { role: 'user', content: 'envoie un mail à mon associé pour lui dire que la réunion est décalée à jeudi' },
      { role: 'assistant', content: "Pour envoyer le mail à ton associé, il me faut son adresse email. Donne-la moi (et dis-moi aussi le ton souhaité : formel ou décontracté)." },
    ];
    expect(followUpActionKind(h, "son adresse c'est vbz2657020372@uberip.com, objet ok")).toBe('email');
  });
  it('« précise-moi l\'objet » / « I need the address » = suite', () => {
    const u = { role: 'user', content: 'envoie un mail à mon associé' };
    expect(followUpActionKind([u, { role: 'assistant', content: "Précise-moi l'objet du mail." }], 'Réunion décalée')).toBe('email');
    expect(followUpActionKind([u, { role: 'assistant', content: 'I need the address of your partner.' }], 'jean@ex.be')).toBe('email');
  });
  it('affirmation sans demande → pas de suite', () => {
    const u = { role: 'user', content: 'envoie un mail à mon associé' };
    expect(followUpActionKind([u, { role: 'assistant', content: 'Le service mail est momentanément indisponible.' }], 'ok')).toBeNull();
  });
  it('demande précédente ordinaire → rien', () => {
    expect(followUpActionKind([{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'Ça va ?' }], 'oui')).toBeNull();
  });
});

describe('emailStillPending (filet final anti-faux-succès)', () => {
  const req = { role: 'user', content: 'envoie un mail à mon associé pour lui dire que la réunion est décalée' };
  it('demande puis question → email toujours en attente', () => {
    expect(emailStillPending([req, { role: 'assistant', content: 'Il me faut son adresse email.' }], "c'est jean@ex.be", false)).toBe(true);
  });
  it('email déjà annoncé envoyé → plus en attente (pas de doublon)', () => {
    expect(emailStillPending([req, { role: 'assistant', content: '✅ Email envoyé à jean@ex.be' }], 'merci', false)).toBe(false);
  });
  it('aucune demande d\'email → pas en attente', () => {
    expect(emailStillPending([{ role: 'user', content: 'parle-moi des emails de confirmation' }], 'ok', true)).toBe(false);
  });
  it('demande dans ce message → en attente', () => {
    expect(emailStillPending([], 'envoie-moi un mail récapitulatif', false)).toBe(true);
  });
});
