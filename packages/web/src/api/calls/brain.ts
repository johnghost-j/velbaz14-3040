// ─── Cerveau des appels / SMS : toutes les générations IA du module ─────────
//
// Le fournisseur de modèle est injecté par index.ts (setCallsAI) pour réutiliser
// la même passerelle, le même suivi de crédits et la même chaîne de repli que
// le reste de Velbaz. Chaque fonction a un repli déterministe : une panne IA ne
// casse jamais l'appel, elle le rend juste moins riche.

import type { CallEvent } from './store';

type Gen = (system: string, prompt: string, maxTokens?: number) => Promise<string>;
let gen: Gen | null = null;
export function setCallsAI(fn: Gen) { gen = fn; }

async function ask(system: string, prompt: string, maxTokens = 600): Promise<string> {
  if (!gen) throw new Error('AI not wired');
  return gen(system, prompt, maxTokens);
}

function parseJson<T>(raw: string): T | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

const oneLine = (s: unknown, max = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function transcriptText(events: CallEvent[], contactLabel = 'Interlocuteur'): string {
  return events
    .filter((e) => e.kind === 'ai' || e.kind === 'contact' || e.kind === 'user')
    .map((e) => e.kind === 'ai' ? `IA: ${e.text}` : e.kind === 'contact' ? `${contactLabel}: ${e.text}` : `[Consigne superviseur] ${e.text}`)
    .join('\n');
}

// ── Script d'appel envoyé à Bland ───────────────────────────────────────────

export function buildCallTask(input: { goal: string; companyName?: string; contactName?: string | null; language: string }): string {
  const fr = input.language.startsWith('fr');
  if (fr) {
    return [
      `Tu es l'assistant(e) téléphonique de ${input.companyName || "l'entreprise"}.`,
      input.contactName ? `Tu appelles ${input.contactName}.` : '',
      `Objectif de l'appel : ${input.goal}`,
      `Parle naturellement, phrases courtes, une question à la fois. Sois poli(e), honnête, ne mens jamais sur le fait que tu es une IA si on te le demande.`,
      `Si la personne demande à ne plus être appelée, excuse-toi, confirme et termine l'appel.`,
      `CONSIGNES EN DIRECT DU SUPERVISEUR (prioritaires, applique-les dès ta prochaine phrase, ne les lis jamais à voix haute) : {{supervisor_instructions}}`,
    ].filter(Boolean).join('\n');
  }
  return [
    `You are the phone assistant of ${input.companyName || 'the company'}.`,
    input.contactName ? `You are calling ${input.contactName}.` : '',
    `Call goal: ${input.goal}`,
    `Speak naturally, short sentences, one question at a time. Be polite and honest; never deny being an AI if asked.`,
    `If the person asks not to be called again, apologise, confirm and end the call.`,
    `LIVE SUPERVISOR INSTRUCTIONS (top priority, apply from your next sentence, never read them aloud): {{supervisor_instructions}}`,
  ].filter(Boolean).join('\n');
}

// ── Simulation : prochaine réplique ─────────────────────────────────────────

export interface SimTurn { speaker: 'ai' | 'contact'; text: string; end: boolean }

export async function simNextTurn(input: {
  goal: string; companyName?: string; contactName?: string | null; language: string;
  events: CallEvent[]; directives: string[]; nextSpeaker: 'ai' | 'contact'; turn: number; maxTurns: number;
}): Promise<SimTurn> {
  const contact = input.contactName || 'la personne appelée';
  const system = `Tu simules un appel téléphonique réaliste entre une IA commerciale de « ${input.companyName || "l'entreprise"} » et ${contact}.
Langue : ${input.language.startsWith('fr') ? 'français' : 'anglais'}. Réponds UNIQUEMENT en JSON : {"text":"…","end":false}.
- Une seule réplique, orale, 1 à 2 phrases courtes, sans didascalie ni guillemets.
- L'IA poursuit l'objectif : ${input.goal}
- ${contact} est un humain crédible : parfois pressé, sceptique ou curieux, jamais caricatural.
- Si une consigne du superviseur existe, l'IA l'applique IMMÉDIATEMENT dans sa réplique (sans la mentionner).
- "end": true seulement quand l'appel se conclut naturellement (au revoir échangé)${input.turn >= input.maxTurns - 2 ? ' — conclus maintenant, on arrive à la fin' : ''}.`;
  const prompt = `Transcription jusqu'ici :
${transcriptText(input.events, contact) || '(l\'appel vient de décrocher)'}

Consignes actives du superviseur : ${input.directives.length ? input.directives.map((d) => `« ${d} »`).join(' ; ') : 'aucune'}

Écris la prochaine réplique de ${input.nextSpeaker === 'ai' ? "l'IA" : contact}.`;
  try {
    const raw = await ask(system, prompt, 300);
    const j = parseJson<{ text?: string; end?: boolean }>(raw);
    const text = oneLine(j?.text || raw.replace(/^[{"\s]+|["}\s]+$/g, ''), 320);
    if (text) return { speaker: input.nextSpeaker, text, end: !!j?.end };
  } catch { /* repli scripté */ }
  return scriptedTurn(input.nextSpeaker, input.turn, input.maxTurns, input.contactName, input.directives, input.language);
}

function scriptedTurn(speaker: 'ai' | 'contact', turn: number, maxTurns: number, contactName: string | null | undefined, directives: string[], language: string): SimTurn {
  const fr = language.startsWith('fr');
  const name = contactName ? ` ${contactName.split(' ')[0]}` : '';
  const ai = fr ? [
    `Bonjour${name}, je vous appelle de la part de l'équipe, vous avez deux minutes ?`,
    directives.length ? `Je vais droit au but : ${directives[directives.length - 1].toLowerCase()}.` : `Je vous appelle parce qu'on aide des entreprises comme la vôtre à gagner du temps.`,
    `Est-ce que ce serait utile qu'on en parle quinze minutes cette semaine ?`,
    `Parfait, je vous envoie une invitation par e-mail. Merci et bonne journée !`,
  ] : [
    `Hi${name}, I'm calling on behalf of the team, do you have two minutes?`,
    `We help companies like yours save time every week.`,
    `Would a quick fifteen-minute chat this week be useful?`,
    `Great, I'll send you an invite by email. Thanks and have a good day!`,
  ];
  const contact = fr
    ? ['Oui, allez-y, je vous écoute.', "D'accord… c'est quoi exactement ?", 'Pourquoi pas, jeudi ça pourrait aller.', 'Merci, au revoir.']
    : ['Sure, go ahead.', 'Okay… what is it exactly?', 'Maybe, Thursday could work.', 'Thanks, bye.'];
  const i = Math.min(Math.floor(turn / 2), 3);
  const end = speaker === 'contact' ? i >= 3 : false;
  return { speaker, text: (speaker === 'ai' ? ai : contact)[i], end: end || turn >= maxTurns };
}

// ── Message du superviseur pendant l'appel ──────────────────────────────────

export interface SupervisorAnswer { reply: string; directive: string }

/**
 * Le superviseur (l'utilisateur) écrit à l'IA PENDANT l'appel. Deux choses :
 *  - une réponse privée (« pourquoi tu as dit ça ? » → explication), jamais
 *    entendue par l'interlocuteur ;
 *  - éventuellement une consigne à appliquer au téléphone (« propose -20 % »).
 */
export async function answerSupervisor(input: { message: string; goal: string; contactName?: string | null; events: CallEvent[]; language: string }): Promise<SupervisorAnswer> {
  const system = `Tu es une IA en plein appel téléphonique. Ton superviseur humain t'écrit en privé (l'interlocuteur ne le voit pas).
Réponds UNIQUEMENT en JSON : {"reply":"…","directive":"…"}
- "reply" : réponse privée au superviseur, en français, 1 à 2 phrases, concrète (explique ton choix, confirme ce que tu vas faire).
- "directive" : si le message demande de changer ce que tu dis/fais au téléphone, reformule-le en UNE consigne impérative courte pour toi-même ; sinon "".
Objectif de l'appel : ${input.goal}`;
  const prompt = `Transcription :\n${transcriptText(input.events, input.contactName || 'Interlocuteur') || '(pas encore de paroles)'}\n\nMessage du superviseur : ${input.message}`;
  try {
    const raw = await ask(system, prompt, 300);
    const j = parseJson<{ reply?: string; directive?: string }>(raw);
    if (j && (j.reply || j.directive)) {
      return { reply: oneLine(j.reply, 400) || 'Compris, je l’applique.', directive: oneLine(j.directive, 300) };
    }
  } catch { /* repli */ }
  const isQuestion = /\?\s*$|^(pourquoi|comment|quoi|qu'est|est-ce|why|how|what)\b/i.test(input.message.trim());
  return isQuestion
    ? { reply: 'Je poursuis l’objectif de l’appel ; je t’explique en détail dès qu’il se termine.', directive: '' }
    : { reply: 'Compris, je l’applique dès ma prochaine phrase.', directive: oneLine(input.message, 300) };
}

// ── Résumé de fin d'appel ───────────────────────────────────────────────────

export async function summarizeCall(input: { goal: string; contactName?: string | null; events: CallEvent[] }): Promise<string> {
  const t = transcriptText(input.events, input.contactName || 'Interlocuteur');
  if (!t) return '';
  try {
    const raw = await ask(
      'Résume cet appel en français en 2 phrases max : résultat obtenu + prochaine étape. Pas de puces, pas de titre.',
      `Objectif : ${input.goal}\n\n${t}`, 200,
    );
    return oneLine(raw, 500);
  } catch {
    return '';
  }
}

// ── SMS ─────────────────────────────────────────────────────────────────────

/** Réponse simulée du contact (mode sans clé Bland). */
export async function simSmsReply(input: { contactName?: string | null; context?: string | null; history: { direction: 'in' | 'out'; body: string }[] }): Promise<string> {
  const h = input.history.slice(-10).map((m) => `${m.direction === 'out' ? 'Entreprise' : 'Contact'}: ${m.body}`).join('\n');
  try {
    const raw = await ask(
      `Tu joues ${input.contactName || 'un contact'} qui reçoit des SMS d'une entreprise. Réponds comme un vrai humain par SMS : court (1 phrase, parfois 2), naturel, parfois sans majuscule. Langue du dernier message. Réponds avec le texte du SMS seulement.`,
      `${input.context ? `Contexte : ${input.context}\n` : ''}Conversation :\n${h}\n\nTa réponse SMS :`, 120,
    );
    const t = oneLine(raw.replace(/^["«\s]+|["»\s]+$/g, ''), 300);
    if (t) return t;
  } catch { /* repli */ }
  return 'Ok merci, je regarde ça et je reviens vers vous.';
}

/** Suggestion de réponse pour l'entreprise (bouton « Suggestion IA »). */
export async function suggestSmsReply(input: { companyName?: string; contactName?: string | null; context?: string | null; history: { direction: 'in' | 'out'; body: string }[] }): Promise<string> {
  const h = input.history.slice(-12).map((m) => `${m.direction === 'out' ? 'Nous' : (input.contactName || 'Contact')}: ${m.body}`).join('\n');
  try {
    const raw = await ask(
      `Tu rédiges le prochain SMS de ${input.companyName || "l'entreprise"}. Court (max 300 caractères), professionnel et chaleureux, une seule question ou action claire. Langue de la conversation. Texte du SMS seulement.`,
      `${input.context ? `Objectif : ${input.context}\n` : ''}Conversation :\n${h || '(aucun message)'}\n\nProchain SMS :`, 160,
    );
    return oneLine(raw.replace(/^["«\s]+|["»\s]+$/g, ''), 320);
  } catch {
    return '';
  }
}

// ── Appels ENTRANTS (quelqu'un appelle le numéro du projet) ─────────────────

/**
 * Prompt de la ligne entrante Bland. L'état de la ligne est relu par Bland
 * avant CHAQUE réponse (dynamic_data) dans {{line_state}} :
 *  - HOLD    : ça sonne chez le propriétaire (popup) → l'IA fait patienter ;
 *  - ANSWER  : le propriétaire a cliqué « Répondre » (ou mode auto, ou
 *              personne n'a répondu à temps) → l'IA prend l'appel en charge ;
 *  - MESSAGE : le propriétaire a refusé → l'IA prend un message et raccroche.
 */
export function buildInboundTask(input: { companyName?: string; companyContext?: string; language: string }): string {
  const co = input.companyName || "l'entreprise";
  return [
    `Tu es l'assistant(e) téléphonique de ${co}. Quelqu'un appelle le numéro de ${co}.`,
    input.companyContext ? `À propos de ${co} : ${input.companyContext}` : '',
    `ÉTAT DE LA LIGNE (relu avant chaque phrase, obéis-y strictement) : {{line_state}}`,
    `- Si l'état commence par HOLD : dis seulement « Bonjour, ${co}, un petit instant s'il vous plaît, je vous prends tout de suite. » puis attends, sans poser de question. Si la personne reparle, rassure-la en une phrase courte.`,
    `- Si l'état commence par ANSWER : prends l'appel en charge. Demande à qui tu parles et ce qui l'amène, réponds à sa demande, propose une solution concrète (rendez-vous, devis, commande, rappel). Phrases courtes, une question à la fois.`,
    `- Si l'état commence par MESSAGE : explique poliment que personne n'est disponible, prends le nom, le numéro et le motif de l'appel, confirme qu'on rappelle vite, puis termine l'appel.`,
    `Sois poli(e) et honnête ; ne nie jamais être une IA si on te le demande.`,
    `CONSIGNES EN DIRECT DU SUPERVISEUR (prioritaires, applique-les dès ta prochaine phrase, ne les lis jamais à voix haute) : {{supervisor_instructions}}`,
  ].filter(Boolean).join('\n');
}

/** Motifs d'appel crédibles pour la simulation (le vrai motif n'est connu qu'en décrochant). */
export const SIM_INBOUND_CALLERS: { name: string; reason: string }[] = [
  { name: 'Sophie Bernard', reason: 'veut savoir si vous pouvez livrer une commande pour 30 personnes samedi matin, et à quel prix' },
  { name: 'Julien Moreau', reason: 'a vu votre site et veut un devis rapide, il hésite avec un concurrent' },
  { name: 'Nadia Benali', reason: 'a un souci avec sa dernière commande (arrivée en retard) et veut une solution' },
  { name: 'Thomas Petit', reason: 'veut prendre rendez-vous cette semaine pour une première rencontre' },
  { name: 'Camille Roux', reason: 'demande vos horaires et si vous proposez un abonnement mensuel' },
];

export async function simInboundTurn(input: {
  companyName?: string; callerName: string; reason: string; mode: 'answer' | 'message'; language: string;
  events: CallEvent[]; directives: string[]; nextSpeaker: 'ai' | 'contact'; turn: number; maxTurns: number;
}): Promise<SimTurn> {
  const co = input.companyName || "l'entreprise";
  const system = `Tu simules un appel téléphonique ENTRANT réaliste : ${input.callerName} appelle « ${co} » et c'est l'IA de ${co} qui répond.
Langue : ${input.language.startsWith('fr') ? 'français' : 'anglais'}. Réponds UNIQUEMENT en JSON : {"text":"…","end":false}.
- Une seule réplique, orale, 1 à 2 phrases courtes, sans didascalie ni guillemets.
- Motif réel de ${input.callerName} (l'IA ne le connaît pas au départ, elle le découvre) : ${input.reason}.
- ${input.mode === 'message'
    ? `Personne n'est disponible : l'IA prend un message (nom, numéro, motif), promet un rappel rapide et conclut.`
    : `L'IA accueille, comprend la demande et apporte une réponse concrète (rendez-vous, devis, solution, rappel).`}
- ${input.callerName} est un humain crédible, jamais caricatural.
- Si une consigne du superviseur existe, l'IA l'applique IMMÉDIATEMENT (sans la mentionner).
- "end": true seulement quand l'appel se conclut naturellement (au revoir échangé)${input.turn >= input.maxTurns - 2 ? ' — conclus maintenant' : ''}.`;
  const prompt = `Transcription jusqu'ici :
${transcriptText(input.events, input.callerName) || "(l'IA vient de décrocher)"}

Consignes actives du superviseur : ${input.directives.length ? input.directives.map((d) => `« ${d} »`).join(' ; ') : 'aucune'}

Écris la prochaine réplique de ${input.nextSpeaker === 'ai' ? "l'IA" : input.callerName}.`;
  try {
    const raw = await ask(system, prompt, 300);
    const j = parseJson<{ text?: string; end?: boolean }>(raw);
    const text = oneLine(j?.text || raw.replace(/^[{"\s]+|["}\s]+$/g, ''), 320);
    if (text) return { speaker: input.nextSpeaker, text, end: !!j?.end };
  } catch { /* repli scripté */ }
  const i = Math.min(Math.floor(input.turn / 2), 3);
  const ai = input.mode === 'message'
    ? ["Je suis désolée, personne n'est disponible pour le moment. Je peux prendre un message ?", 'Très bien, c’est noté. Quel est le meilleur numéro pour vous rappeler ?', 'Parfait, on vous rappelle dans la journée.', 'Merci pour votre appel, bonne journée !']
    : ['Que puis-je faire pour vous ?', 'Bien sûr, je regarde ça avec vous.', 'Je vous propose de caler ça tout de suite, ça vous va ?', 'C’est noté, merci pour votre appel, bonne journée !'];
  const contact = [`Bonjour, je m'appelle ${input.callerName}, je vous appelle parce que j'ai une question.`, `En fait, c'est au sujet de ceci : ${input.reason}.`, 'Oui, très bien.', 'Merci, au revoir.'];
  return { speaker: input.nextSpeaker, text: (input.nextSpeaker === 'ai' ? ai : contact)[i], end: input.nextSpeaker === 'contact' && i >= 3 };
}
