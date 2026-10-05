/**
 * ─── « Envoie un message sur les réseaux » : détection + plan d'envoi ────────
 *
 * [2026-09-16] Bug constaté en test : un message comme « envoie un message :
 * bonne journée à tous » n'arrivait JAMAIS au prompt projet (celui qui contient
 * le protocole [SOCIAL_SEND]). Il était intercepté en amont par :
 *   · isAppEditRequest()          → « poste/crée un post » = verbe d'édition → streamAppEdit ;
 *   · detectAgentRequest()        → « réseaux sociaux » → agent marketing ;
 *   · maybeHandleDynamicSpecialist() → expert dynamique inventé à la volée ;
 *   · classifyTeamNeed()          → équipe d'agents.
 * Résultat : l'IA répondait « je ne suis pas configurée pour envoyer des
 * messages » alors que la capacité existe. Ce module donne UNE définition
 * partagée de l'intention d'envoi social pour court-circuiter ces routages,
 * plus un plan déterministe (plateformes + texte) utilisé comme filet de
 * sécurité quand le modèle oublie d'émettre le bloc [SOCIAL_SEND].
 *
 * Fonctions PURES (aucun accès DB/réseau) → testables et sans coût.
 */

export const SOCIAL_PLATFORM_IDS = ['twitter', 'discord', 'reddit', 'instagram'] as const;
export type SocialPlatformId = (typeof SOCIAL_PLATFORM_IDS)[number];

export const SOCIAL_PLATFORM_LABELS: Record<string, string> = {
  twitter: 'X (Twitter)',
  discord: 'Discord',
  reddit: 'Reddit',
  instagram: 'Instagram',
};

/** « X, Discord ou Instagram » — liste lisible des plateformes disponibles. */
export function platformListLabel(available: readonly string[], fr: boolean): string {
  const names = available.map(p => (p === 'twitter' ? 'X' : SOCIAL_PLATFORM_LABELS[p] || p));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${fr ? 'ou' : 'or'} ${names[names.length - 1]}`;
}

/** Enlève les accents / normalise les apostrophes (« publié » ≡ « publie »). */
function fold(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`´]/g, "'")
    .trim();
}

// Verbes d'envoi/publication (tolérants aux conjugaisons et aux fautes).
const SEND_VERB =
  /\b(envoi\w*|envoy\w*|post\w*|publi\w*|partag\w*|tweet\w*|twitt\w*|balance|diffus\w*|send|share|publish)\b/;

// Cible « contenu social » : un message/post/tweet… ou une plateforme nommée.
const SEND_TARGET =
  /\b(message|messages|post|posts|publication|publications|tweet|tweets|story|stories|annonce|storie)\b/;

const PLATFORM_MENTION =
  /\b(twitter|tweet\w*|discord|reddit|subreddit|instagram|insta|ig|reseaux? sociaux|reseau social|social media|socials)\b/;

// « sur X », « sur x.com » : le « x » seul est trop courant pour être détecté
// sans la préposition.
const X_MENTION = /\b(?:sur|on|via|dans)\s+(?:x|x\.com|@x)\b/;

// Canaux qui ne sont PAS des réseaux sociaux : jamais un [SOCIAL_SEND], même
// si une plateforme est citée à côté.
const OTHER_CHANNEL = /\b(e?-?mails?|courriels?|newsletter|sms|whatsapp)\b/;

// Sans plateforme citée, ces contextes parlent du PROJET (déploiement, fichier,
// page…) et pas d'un post social : « publie le site », « envoie le fichier ».
const NOT_SOCIAL =
  /\b(facture|devis|cv|fichier|fichiers|pdf|piece jointe|attachment|deploy\w*|deploie\w*|en production|le site|mon site|du site|l'app|mon app|application|la page|une page|le code|domaine)\b/;

/**
 * Vrai quand l'utilisateur demande d'ENVOYER/PUBLIER un contenu sur un réseau
 * social (X, Discord, Reddit, Instagram) — avec ou sans plateforme précisée.
 */
export function isSocialSendIntent(message: string): boolean {
  const m = fold(message);
  if (!m || m.length > 2000) return false;
  if (!SEND_VERB.test(m)) return false;
  if (OTHER_CHANNEL.test(m)) return false;
  if (PLATFORM_MENTION.test(m) || X_MENTION.test(m)) return true;
  return SEND_TARGET.test(m) && !NOT_SOCIAL.test(m);
}

/** Plateformes nommées explicitement dans un texte (ordre d'apparition). */
export function detectPlatformsInMessage(message: string): SocialPlatformId[] {
  const m = fold(message);
  const found: SocialPlatformId[] = [];
  const add = (p: SocialPlatformId) => { if (!found.includes(p)) found.push(p); };
  const hits: Array<[number, SocialPlatformId]> = [];
  const push = (re: RegExp, p: SocialPlatformId) => {
    const idx = m.search(re);
    if (idx >= 0) hits.push([idx, p]);
  };
  push(/\b(twitter|tweet\w*|twitt\w*)\b/, 'twitter');
  push(X_MENTION, 'twitter');
  push(/\b(discord)\b/, 'discord');
  push(/\b(reddit|subreddit)\b/, 'reddit');
  push(/\b(instagram|insta|ig)\b/, 'instagram');
  hits.sort((a, b) => a[0] - b[0]).forEach(([, p]) => add(p));
  return found;
}

/** « toutes », « les deux », « partout »… = envoyer sur tous les comptes liés. */
export function wantsAllPlatforms(message: string): boolean {
  const m = fold(message);
  return /\b(tou(?:s|tes)(?: les(?: deux| trois)?)?|les deux|les 2|partout|everywhere|all of them|both)\b/.test(m);
}

/**
 * Le message est-il une RÉPONSE au formulaire de désambiguïsation ?
 * Le front compile les réponses en « Question : réponse | Question : réponse ».
 */
export function isPlatformAnswer(message: string): boolean {
  const m = fold(message);
  return /:/.test(m) && /(quelle? plateforme|which platform|sur quel reseau)/.test(m);
}

/**
 * « Je passe » : l'utilisateur a cliqué sur Skip dans le questionnaire, ou dit
 * explicitement de décider à sa place.
 *
 * [2026-09-16] Bug signalé : question « quel message veux-tu publier ? »
 * SKIPPÉE → la même question revenait au tour suivant. Un skip est une
 * DÉCISION (« décide pour moi ») : il ne doit JAMAIS relancer la question.
 */
export function isSkipAnswer(message: string): boolean {
  const m = fold(message);
  if (!m) return false;
  if (/(skip these questions|decide for yourself|don't ask me again|ne me (re)?demande (plus|pas)|je passe|passe (la|cette) question|decide (pour moi|toi[- ]?meme)|a toi de (voir|choisir|decider)|comme tu veux|peu importe|ce que tu veux|au choix|choisis (pour moi|toi))/.test(m)) return true;
  return /^(skip|passe|passer|next|suivant)\b/.test(m);
}

/** Questions d'envoi social que NOUS posons (voir plus bas). */
const SOCIAL_QUESTION_MARK =
  /(sur quelle plateforme veux-tu|which platform should i send|quel message veux-tu publier|what message should i publish)/;

/**
 * Marqueur déterministe ajouté en base (et PAS affiché) quand le tour
 * précédent a posé une question d'envoi social — y compris une question
 * formulée par le modèle lui-même. C'est la source de vérité : le texte des
 * questions, lui, varie à chaque génération.
 */
export const SOCIAL_ASK_MARKER = '[SOCIAL_ASK]';

/**
 * Question d'envoi social formulée librement par le modèle : « sur quel réseau
 * veux-tu l'envoyer (Twitter/X, Discord…) et quel texte exact dois-je
 * publier ? ». Constaté en test navigateur : cette prose est promue en
 * formulaire AVANT notre filet de sécurité, donc aucun de nos libellés fixes
 * n'apparaît dans le message enregistré. On reconnaît donc la combinaison
 * « interrogation + plateforme/texte + verbe de publication ».
 */
// Volontairement exigeant : il faut une PLATEFORME sociale ET un verbe de
// publication dans la même phrase. Un « quel texte veux-tu pour le bouton ? »
// suivi d'un « peu importe » ne doit jamais déclencher un envoi social.
const SOCIAL_QUESTION_LOOSE =
  /(plateforme|platform|reseau social|reseaux|network|twitter|\bx\b|discord|reddit|instagram|linkedin)[\s\S]{0,140}(publier|publie|poster|poste|envoyer|envoie|tweeter|publish|post|send)|(publier|poster|envoyer|publish|post|send)[\s\S]{0,140}(plateforme|platform|reseau social|reseaux|twitter|discord|reddit|instagram|linkedin)/;

/** Une question d'envoi social a-t-elle déjà été posée juste avant ? */
export function wasSocialQuestionAsked(assistantMessages: string[]): boolean {
  return (assistantMessages || []).some(raw => {
    const s = String(raw || '');
    if (s.includes(SOCIAL_ASK_MARKER)) return true;
    const m = fold(s);
    if (SOCIAL_QUESTION_MARK.test(m)) return true;
    // Une question a-t-elle vraiment été posée dans ce message ?
    const asked = s.includes('[QUESTIONS') || m.includes('?');
    return asked && SOCIAL_QUESTION_LOOSE.test(m);
  });
}

/**
 * Ce tour de conversation concerne-t-il un envoi social ?
 * Vrai pour une demande directe, MAIS AUSSI pour une réponse (ou un skip) qui
 * suit immédiatement une de nos questions d'envoi — sinon un « skip » sortait
 * du flux d'envoi et la question était reposée.
 */
export function isSocialSendTurn(
  message: string,
  history: Array<{ role?: string; content?: string | null }>,
): boolean {
  if (isSocialSendIntent(message)) return true;
  if (!isSkipAnswer(message) && !isPlatformAnswer(message)) return false;
  return wasSocialQuestionAsked(lastAssistantMessages(history));
}

/** Les 2 derniers messages de l'assistant (contexte immédiat). */
export function lastAssistantMessages(
  history: Array<{ role?: string; content?: string | null }>,
): string[] {
  return (Array.isArray(history) ? history : [])
    .filter(h => h?.role === 'assistant')
    .slice(-2)
    .map(h => String(h?.content || ''));
}

/**
 * Texte EXACT à publier, extrait de la demande utilisateur.
 * Renvoie null quand l'utilisateur n'a donné qu'un sujet (à rédiger par l'IA).
 */
export function extractSendText(message: string): string | null {
  const raw = (message || '').trim();
  if (!raw) return null;

  // 1) Texte entre guillemets (français, anglais, simples).
  const quoted = [...raw.matchAll(/[«"“”]([^«»"“”]{2,400})[»"“”]|'([^']{4,400})'/g)]
    .map(mm => (mm[1] || mm[2] || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];
  if (quoted) return quoted;

  // 2) Après un marqueur de citation : « qui dit : … », « disant … », « : … ».
  const after = raw.match(
    /(?:qui\s+dit|qui\s+disait|disant|dis\s+leur|dis\s+lui|ceci\s*:|le\s+texte\s*:|message\s*suivant\s*:|that\s+says|saying|with\s+the\s+text)\s*:?\s*([\s\S]{2,400})$/i,
  );
  if (after?.[1]) return after[1].trim().replace(/^["'«“]|["'»”]$/g, '').trim();

  // 3) Tout ce qui suit le premier « : » (« envoie un message : bonjour »).
  const colon = raw.match(/^[^:\n]{3,80}:\s*([\s\S]{2,400})$/);
  if (colon?.[1]) {
    const t = colon[1].trim();
    // Une réponse de formulaire (« … plateforme : X ») n'est pas un texte à publier.
    if (!isPlatformAnswer(raw) && t.length >= 2) return t.replace(/^["'«“]|["'»”]$/g, '').trim();
  }
  return null;
}

export interface SocialSendPlan {
  /** Plateformes retenues ; vide = on ne sait pas (il faut demander). */
  platforms: SocialPlatformId[];
  /** Texte exact à publier ; null = à rédiger par le modèle. */
  text: string | null;
  /** Vrai quand la plateforme est indécidable → poser la question. */
  ambiguous: boolean;
  /** Comptes liés proposables dans la question. */
  connected: string[];
  /**
   * Vrai quand aucun texte n'est donné MAIS qu'il ne faut PAS le demander
   * (skip, « décide pour moi », ou question déjà posée) : le pipeline de
   * contenu rédige le message lui-même.
   */
  writeItself: boolean;
}

/**
 * Plan d'envoi déterministe.
 * @param message            dernier message utilisateur
 * @param priorUserMessages  messages utilisateur précédents (du + récent au + ancien)
 * @param connected          plateformes actuellement connectées (ids internes)
 */
export function planSocialSend(
  message: string,
  priorUserMessages: string[],
  connected: string[],
  opts?: { alreadyAsked?: boolean; available?: readonly string[] },
): SocialSendPlan {
  // `available` : plateformes qui existent en ce moment (Reddit est retiré
  // sans ses clés API). Une plateforme absente n'est jamais choisie.
  const avail = (opts?.available ?? SOCIAL_PLATFORM_IDS) as readonly string[];
  const isAvail = (p: string) => avail.includes(p);
  const linked = connected.filter(p => (SOCIAL_PLATFORM_IDS as readonly string[]).includes(p) && isAvail(p)) as SocialPlatformId[];
  const answering = isPlatformAnswer(message);
  // « Décide pour moi » : skip explicite, ou question déjà posée une fois. On
  // tranche alors tout seul — reposer la question est interdit.
  const decideForMe = isSkipAnswer(message) || !!opts?.alreadyAsked;

  let platforms = detectPlatformsInMessage(message).filter(isAvail);
  // « toutes / les deux / partout » ne compte que dans une RÉPONSE au
  // formulaire ou un message très court : sinon « bonne journée à tous »
  // serait lu comme « envoie sur toutes les plateformes ».
  const allIntent = (answering || message.trim().length <= 32) && wantsAllPlatforms(message);
  if (!platforms.length && allIntent && linked.length) platforms = linked;
  if (!platforms.length && !answering) {
    // Plateforme mentionnée au tour précédent (« sur Discord » puis « vas-y »).
    for (const prev of priorUserMessages) {
      const p = detectPlatformsInMessage(prev).filter(isAvail);
      if (p.length) { platforms = p; break; }
    }
  }
  if (!platforms.length && linked.length === 1) platforms = linked;
  // Plateforme skippée / déjà demandée → tous les comptes liés.
  if (!platforms.length && decideForMe && linked.length) platforms = linked;

  // Texte : le message courant sauf s'il s'agit d'une réponse de formulaire
  // (le contenu à publier est alors dans un message précédent).
  let text = answering ? null : extractSendText(message);
  if (!text) {
    for (const prev of priorUserMessages) {
      if (!isSocialSendIntent(prev)) continue;
      const t = extractSendText(prev);
      if (t) { text = t; break; }
    }
  }

  return {
    platforms,
    text,
    ambiguous: platforms.length === 0,
    connected: linked,
    writeItself: !text && decideForMe,
  };
}

/**
 * Bloc que le front rend en carte d'envoi (components/SocialSendCard.tsx).
 * `id` : signature unique de l'envoi. Sans elle, deux envois « texte rédigé
 * par l'IA » (texte vide) partageaient la même mémo localStorage et le second
 * réaffichait le résultat du premier au lieu de publier.
 */
export function socialSendBlock(platforms: string[], text: string, id?: string): string {
  return `[SOCIAL_SEND]${JSON.stringify(id ? { platforms, text, id } : { platforms, text })}[/SOCIAL_SEND]`;
}

/**
 * Retire de la PROSE les phrases qui annoncent un résultat d'envoi (« message
 * envoyé », « l'envoi a échoué, je réessaie », « c'est publié »).
 *
 * Seule la carte d'envoi connaît le vrai résultat : constaté en test, le
 * modèle écrivait « On dirait que l'envoi sur Discord a échoué. Je réessaie. »
 * AU-DESSUS d'une carte qui n'avait même pas encore publié. On ne coupe que
 * les phrases fautives — le reste du message (avis, conseils) est conservé.
 */
export function stripSendStatusClaims(prose: string): string {
  const STATUS_CLAIM =
    /(message|post|publication|tweet|envoi)[^.!?…]{0,40}(envoy[ée]|parti|publi[ée]|[ée]chou[ée]|pass[ée] (?:pas|bien))|(?:[ée]chec|[ée]chou[ée])[^.!?…]{0,40}(envoi|publication)|je (r[ée])?essaie (?:tout de suite|[àa] nouveau|encore)|c'est (?:envoy[ée]|publi[ée]|parti)|(?:message|post) (?:sent|published|failed)|sending failed|i'?ll retry/i;
  return (prose || '')
    .split('\n')
    .map(line => {
      if (!line.trim() || /\[(SOCIAL_SEND|QUESTIONS)/.test(line)) return line;
      const kept = line
        // Découpe en phrases en gardant leur ponctuation.
        .split(/(?<=[.!?…])\s+/)
        .filter(sentence => !STATUS_CLAIM.test(sentence))
        .join(' ')
        .trim();
      return kept;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Question « quel texte publier ? » quand la demande n'en contient aucun. */
export function socialTextQuestion(fr: boolean): string {
  return JSON.stringify({
    q: fr ? 'Quel message veux-tu publier ?' : 'What message should I publish?',
    kind: 'text',
    allowCustom: true,
    options: [],
  });
}

/** Formulaire de désambiguïsation (format [QUESTIONS] du chat). */
export function socialPlatformQuestionObj(
  connected: string[],
  fr: boolean,
  available: readonly string[] = SOCIAL_PLATFORM_IDS,
): string {
  const linked = connected.filter(p => available.includes(p));
  const choices = (linked.length >= 2 ? linked : SOCIAL_PLATFORM_IDS.filter(p => available.includes(p))) as string[];
  const options = choices.map(id => ({ id, label: SOCIAL_PLATFORM_LABELS[id] || id }));
  if (choices.length > 1) options.push({ id: 'all', label: fr ? 'Toutes' : 'All of them' });
  const q = fr
    ? "Sur quelle plateforme veux-tu que j'envoie ce message ?"
    : 'Which platform should I send this message on?';
  return JSON.stringify({ q, kind: 'single', options, allowCustom: false });
}

export function socialPlatformQuestion(connected: string[], fr: boolean, available?: readonly string[]): string {
  return questionsBlock([socialPlatformQuestionObj(connected, fr, available)]);
}

/** Emballe des objets question déjà sérialisés dans un bloc [QUESTIONS]. */
export function questionsBlock(objs: string[]): string {
  return `[QUESTIONS][${objs.join(',')}][/QUESTIONS]`;
}
