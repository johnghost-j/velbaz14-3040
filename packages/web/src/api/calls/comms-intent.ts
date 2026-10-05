// ─── « Appelle X » / « envoie un SMS à Y » : détection + filet anti-refus ────
//
// [2026-10-01] Bug : « appel moi » dans un projet sans site construit partait
// dans le flux découverte (aucun protocole [CALL]/[SMS] dans le prompt) et le
// modèle Lite répondait « I can't make actual calls or send real SMS… ».
// Ce module donne une définition partagée de l'intention d'appel / SMS (pour
// forcer le prompt projet), détecte les refus du modèle et fabrique la réponse
// de secours. Fonctions PURES (aucun accès DB/réseau) → testables.

type Msg = { role: string; content: string };

function fold(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`´]/g, "'")
    .trim();
}

// Usages de « appel » qui ne sont PAS un coup de téléphone.
const NOT_PHONE =
  /\b(?:s'appel\w*|m'appel\w*|t'appel\w*|nous appelons|vous appelez|appel(?:s)? (?:d'offres?|a (?:l'action|projets?|candidatures?|dons?))|appel(?:s|er|le)? (?:a )?(?:l'|une? |la |les )?(?:api|fonction|endpoint|webhook|methode|route)|call to action|cta|callback|function call|api call|tool call)\b/g;

const CALL_VERB =
  /\b(appel\w*|appell\w*|telephon\w*|coup de (?:fil|telephone|phone)|call|calls|calling|phone him|phone her|phone me|ring me|ring him|ring her)\b/;

const SMS_WORD = /\b(sms|textos?|text message|texte-lui|texte lui|text him|text her|text me)\b/;
const SEND_VERB = /\b(envoi\w*|envoy\w*|ecri\w*|send|write)\b/;

const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?0?\d\)?[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){3,5}/g;

/** Numéros de téléphone plausibles (≥ 9 chiffres) présents dans un texte. */
export function findPhones(text: string): string[] {
  const out: string[] = [];
  for (const m of (text || '').match(PHONE_RE) || []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15) out.push(m.trim());
  }
  return out;
}

/** 06 11 22 33 44 → +33611223344 ; +44 7… gardé tel quel (sans espaces). */
export function toE164(raw: string): string | null {
  const s = (raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (/^0[1-9]\d{8}$/.test(digits)) return `+33${digits.slice(1)}`;
  if (/^33[1-9]\d{8}$/.test(digits)) return `+${digits}`;
  return null;
}

export type CommsKind = 'call' | 'sms';

/** L'utilisateur demande d'APPELER ou d'envoyer un SMS (pas « s'appelle », « appel d'offres »…). */
export function commsIntentKind(message: string): CommsKind | null {
  // « un site appelé Velbaz » : participe + nom propre → pas un appel.
  const cleaned = (message || '').replace(/\bappel(?:é|e)e?s?\s+["«“]?\p{Lu}/gu, ' ');
  const m = fold(cleaned).replace(NOT_PHONE, ' ');
  if (!m || m.length > 2000) return null;
  const hasPhone = findPhones(message).length > 0;
  if (SMS_WORD.test(m)) return 'sms';
  if (CALL_VERB.test(m)) return 'call';
  // « rappelle-moi » = souvent « fais-moi penser à » : appel seulement avec un numéro.
  if (/\brappel\w*/.test(m) && hasPhone) return 'call';
  // « envoie un message au 06… » → SMS
  if (SEND_VERB.test(m) && /\bmessage\b/.test(m) && hasPhone) return 'sms';
  return null;
}

export function isCommsIntent(message: string): boolean {
  return commsIntentKind(message) !== null;
}

/**
 * Tour d'appel/SMS sur la conversation : la demande elle-même, OU la suite
 * immédiate (l'utilisateur donne le numéro / le but après qu'on le lui a demandé).
 */
export function isCommsTurn(message: string, history: Msg[] = []): boolean {
  if (isCommsIntent(message)) return true;
  // Demande d'appel/SMS encore EN ATTENTE : une demande récente de
  // l'utilisateur sans carte [CALL_VIEW]/[SMS_VIEW] émise depuis. Les tours
  // suivants (« 0469186482 », « +32 », « c'est pour le devis ») en font partie.
  const recent = history.slice(-8);
  let idx = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'user' && isCommsIntent(recent[i].content)) { idx = i; break; }
  }
  if (idx < 0) return false;
  const after = recent.slice(idx + 1);
  if (after.some(m => m.role === 'assistant' && /\[(CALL_VIEW|SMS_VIEW)\]/.test(m.content || ''))) return false;
  const lastAsst = [...after].reverse().find(m => m.role === 'assistant')?.content || '';
  const digits = (message.match(/\d/g) || []).length;
  const asked = /\?\s*$|num[ée]ro|number|indicatif|country code|objectif|goal|texte du sms|que (?:je )?lui (?:dis|écris)/i.test(lastAsst.trim());
  return digits >= 2 || (asked && message.trim().length <= 300);
}

/** Le modèle prétend ne pas pouvoir appeler / envoyer de SMS. */
export function isCommsRefusal(reply: string): boolean {
  const r = fold(reply);
  if (!r) return false;
  const en = /\b(?:can ?not|can't|cannot|unable to|not able to|no way to|don't have (?:the ability|access|any way)|do not have (?:the ability|access)|i'm not able)\b[^.\n]{0,60}\b(?:calls?|phone|sms|texts?|text messages?|dial)\b/;
  const fr = /\b(?:je ne (?:peux|pourrai|suis) pas|je n'ai pas (?:acces|la possibilite|la capacite|les moyens)|impossible (?:pour moi )?d[e']|je ne dispose pas)\b[^.\n]{0,60}\b(?:appel\w*|telephon\w*|sms|textos?|composer)\b/;
  const demo = /\b(?:simulated demo|demo interface|simulation|interface de demo|demo simulee)\b[^.\n]{0,80}\b(?:calls?|sms|appels?)\b|\b(?:phone systems|sms apis?|telephony)\b/;
  return en.test(r) || fr.test(r) || demo.test(r);
}

/**
 * Le modèle ANNONCE qu'il appelle / envoie (« je lance l'appel », « j'envoie
 * le SMS ») : sans bloc [CALL]/[SMS] dans la réponse, rien ne se passe.
 */
export function claimsCommsLaunch(reply: string): boolean {
  const r = fold(reply);
  if (!r) return false;
  return /\b(?:je (?:lance|passe|demarre|declenche) (?:l'|un |ton |cet |ce )?appel|je (?:t'|l'|les |vous )?appelle\b|j'appelle|appel (?:en cours|lance)|j'envoie (?:le |ce |un |ton |les )?(?:sms|texto|message)|sms (?:envoye|en cours d'envoi)|calling (?:you|him|her|them|now)|starting the call|i'?m calling|i'?ll call|sending (?:the |your )?(?:sms|text))/.test(r);
}

/**
 * Le modèle repose encore une question alors qu'il a DÉJÀ demandé au moins
 * une fois depuis la demande d'appel et qu'un numéro sans ambiguïté est connu :
 * on arrête l'interrogatoire, l'appel part (objectif = demande de l'utilisateur).
 */
export function commsOverAsked(message: string, history: Msg[], reply: string): boolean {
  if (/\[(CALL|SMS)\]/.test(reply)) return false;
  const recent = [...history.slice(-8), { role: 'user', content: message }];
  let idx = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'user' && isCommsIntent(recent[i].content)) { idx = i; break; }
  }
  if (idx < 0 || commsIntentKind(recent[idx].content) !== 'call') return false;
  const after = recent.slice(idx + 1);
  if (!after.some(m => m.role === 'assistant')) return false;
  if (after.some(m => m.role === 'assistant' && /\[(CALL_VIEW|SMS_VIEW)\]/.test(m.content || ''))) return false;
  const phone = recent.slice(idx).filter(m => m.role === 'user').map(m => findPhones(m.content)[0]).filter(Boolean).pop();
  if (!phone || !(/^\s*(?:\+|00)/.test(phone) || /^0[67]\d{8}$/.test(phone.replace(/\D/g, '')))) return false;
  return /\?/.test(reply);
}

function looksFrench(text: string): boolean {
  const t = fold(text);
  if (/\b(the|please|call|can you|my|him|her)\b/.test(t) && !/\b(le|la|les|moi|lui|au|stp|svp|appel\w*)\b/.test(t)) return false;
  return true; // Velbaz : français par défaut
}

/**
 * Réponse de secours quand le modèle a refusé : si la demande est un appel avec
 * un numéro clair → on émet le bloc [CALL] (l'utilisateur a dit « appelle »
 * et donné le numéro : règle 1 du protocole respectée). Sinon on demande ce
 * qui manque, dans la langue de l'utilisateur. Jamais de refus.
 */
export function commsFallbackReply(message: string, history: Msg[] = [], companyName?: string): string {
  const recentUser = history.filter(m => m.role === 'user').slice(-3).map(m => m.content);
  const kind = commsIntentKind(message) ?? [...recentUser].reverse().map(commsIntentKind).find(Boolean) ?? 'call';
  const fr = looksFrench([...recentUser, message].join(' '));
  const phoneRaw = findPhones(message)[0] ?? [...recentUser].reverse().map(t => findPhones(t)[0]).find(Boolean);
  // N'appelle de lui-même que sur un numéro SANS ambiguïté : international
  // (+32…, 0032…) ou mobile français 06/07 (convention du protocole). Un
  // « 0469… » peut être belge ou français : on demande l'indicatif plutôt que
  // de risquer d'appeler un inconnu.
  const unambiguous = !!phoneRaw && (/^\s*(?:\+|00)/.test(phoneRaw) || /^0[67]\d{8}$/.test(phoneRaw.replace(/\D/g, '')));
  const to = phoneRaw && unambiguous ? toE164(phoneRaw) : null;
  if (phoneRaw && !unambiguous) {
    return fr
      ? `Pour le ${phoneRaw.trim()}, donne-moi l'indicatif du pays (ex. +33 France, +32 Belgique, +41 Suisse) et je lance ${kind === 'sms' ? "l'envoi" : "l'appel"}.`
      : `For ${phoneRaw.trim()}, give me the country code (e.g. +33, +32, +44) and I'll start ${kind === 'sms' ? 'sending' : 'the call'}.`;
  }
  const self = /\b(moi|me)\b/i.test(fold(message)) && !/\b(lui|him|her)\b/i.test(fold(message));

  if (kind === 'call' && to) {
    // Tous les messages de l'utilisateur depuis sa demande d'appel (le but est
    // souvent donné en plusieurs fois : « appel moi » / « +33… » / « pour tester »).
    const turns = [...recentUser, message];
    let from = -1;
    for (let i = turns.length - 1; i >= 0; i--) if (isCommsIntent(turns[i])) { from = i; break; }
    const request = turns.slice(Math.max(0, from)).join(' / ');
    const selfCall = turns.slice(Math.max(0, from)).some(t => /\b(moi|me)\b/i.test(fold(t)) && !/\b(lui|him|her)\b/i.test(fold(t)));
    const who = selfCall ? (fr ? "Tu appelles le propriétaire du projet lui-même (il a demandé qu'on l'appelle). " : 'You are calling the project owner himself (he asked to be called). ') : '';
    const goal = fr
      ? `${who}Appel passé pour le compte de ${companyName || 'notre entreprise'}. Demande de l'utilisateur : « ${request.slice(0, 400)} ». Présente-toi, explique pourquoi tu appelles et obtiens une réponse claire.`
      : `${who}Call made on behalf of ${companyName || 'our company'}. User's request: "${request.slice(0, 400)}". Introduce yourself, explain why you're calling and get a clear answer.`;
    const intro = fr ? "Je lance l'appel :" : "Starting the call:";
    return `${intro}\n\n[CALL]${JSON.stringify({ to, goal, language: fr ? 'fr' : 'en' })}[/CALL]`;
  }
  if (kind === 'sms') {
    // Texte exact fourni entre guillemets / après « : » → on l'envoie.
    const quoted = message.match(/[«“"]\s*([^«»“”"]{3,320}?)\s*[»”"]/)?.[1]
      ?? message.match(/(?:sms|texto|message)[^:\n]{0,80}:\s*(.{3,320})$/i)?.[1];
    if (to && quoted) {
      const intro = fr ? "J'envoie le SMS :" : 'Sending the text:';
      return `${intro}\n\n[SMS]${JSON.stringify({ to, message: quoted.trim(), goal: fr ? `SMS pour le compte de ${companyName || 'notre entreprise'}` : `Text on behalf of ${companyName || 'our company'}` })}[/SMS]`;
    }
    if (to) return fr ? `Je peux envoyer ce SMS au ${phoneRaw}. Qu'est-ce que je lui écris exactement ?` : `I can text ${phoneRaw}. What exactly should the message say?`;
    return fr ? 'Je peux envoyer ce SMS. Donne-moi le numéro (06… ou +33…) et le texte à envoyer.' : 'I can send that text. Give me the number (with country code) and the message to send.';
  }
  if (self) {
    return fr
      ? "Je peux t'appeler. À quel numéro (06… ou +33…) ? Et dis-moi en une phrase de quoi l'appel doit parler."
      : 'I can call you. What number should I call (with country code)? And tell me in one sentence what the call is about.';
  }
  return fr
    ? "Je peux passer cet appel. Donne-moi le numéro (06… ou +33…), le nom de la personne et ce que l'appel doit obtenir."
    : 'I can make that call. Give me the number (with country code), the person\'s name and what the call should achieve.';
}
