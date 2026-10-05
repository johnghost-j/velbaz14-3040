// ─── Sujet de l'entreprise : verrou de NIVEAU (marque ≠ agence de marques) ───
// [2026-09-18] Bug « méta-confusion » : l'utilisateur demande « crée-moi une
// marque de vêtements » et l'IA construit UNE ENTREPRISE QUI CRÉE DES MARQUES
// DE VÊTEMENTS (une agence) — un cran d'abstraction au-dessus de la demande.
//
// Cause racine réelle : ce qui part au build (`company.idea`) n'est pas la
// phrase de l'utilisateur mais TOUT LE TRANSCRIPT de la conversation, lignes
// « AI: ... » incluses (cf. `triggerBuild` dans web/pages/chat.tsx). Or l'IA
// écrit dans ces lignes des phrases du type « je vais créer ta marque de
// vêtements », « je m'occupe de lancer la marque pour toi ». Les ~50 prompts en
// aval (nom, industrie, description, plan de pages, produits, marketing, SEO,
// images…) lisent tous `company.idea` : ils voient donc un texte où l'acteur
// principal est un prestataire qui fabrique des marques pour quelqu'un. Un LLM
// en déduit très naturellement « l'entreprise = un studio qui crée des marques ».
//
// Correctif systémique, en amont de TOUT le reste (donc valable pour les ~50
// prompts d'un coup, sans les toucher un par un) :
//   1. on retire les tours de parole de l'IA du texte stocké (`stripAiTurns`) ;
//   2. on classe le NIVEAU de l'offre (`detectOfferLevel`) : l'utilisateur veut
//      SA propre activité (first_party) ou un prestataire qui sert les autres
//      (service_provider) ;
//   3. on préfixe l'idée d'un bloc [SUJET — VERROUILLÉ] qui énonce noir sur
//      blanc ce que l'entreprise EST et ce qu'elle N'EST PAS.
// Le bloc est écrit en base (`companies.idea`), donc hérité partout.

import { findChosenIdea, focusProjectTranscript, isNonSubjectSegment } from './project-transcript';

export type OfferLevel = 'first_party' | 'service_provider';

export interface IdeaSubject {
  /** Texte de l'utilisateur seul (transcript nettoyé des lignes « AI: »). */
  userText: string;
  /** Niveau de l'offre : sa propre activité, ou un prestataire pour les autres. */
  level: OfferLevel;
  /** Ce que l'entreprise EST, en une phrase courte (« une marque de vêtements »). */
  subject: string;
  /** Langue détectée du bloc de verrou. */
  lang: 'fr' | 'en';
  /** Le bloc [SUJET — VERROUILLÉ] prêt à être injecté. */
  lock: string;
  /** `lock` + `userText` : la valeur à stocker dans companies.idea. */
  idea: string;
}

export const SUBJECT_LOCK_START_FR = '[SUJET — VERROUILLÉ, NE PAS RÉINTERPRÉTER]';
export const SUBJECT_LOCK_START_EN = '[SUBJECT — LOCKED, DO NOT REINTERPRET]';
const LOCK_END = '[/SUJET]';

// ─── 1. Nettoyage du transcript ──────────────────────────────────────────────
// Garde uniquement ce que l'UTILISATEUR a écrit (idée + réponses au
// questionnaire) et les blocs neutres ajoutés côté client (ex : plan validé).
// Les tours « AI: » sont retirés EN ENTIER (lignes de continuation incluses) :
// c'est là que vivent les « je vais créer ta marque », source de la confusion.
const ROLE_RE = /^\s*(User|Utilisateur|AI|Assistant|Velbaz)\s*:/i;
const AI_ROLE_RE = /^\s*(AI|Assistant|Velbaz)\s*:/i;

export function stripAiTurns(raw: string): string {
  const text = String(raw || '');
  if (!text.trim()) return '';
  const lines = text.split('\n');
  if (!lines.some(l => ROLE_RE.test(l))) return text.trim();

  const kept: string[] = [];
  let dropping = false;
  // Blocs balisés ajoutés côté client (ex : « [PLAN VALIDÉ] … ») : toujours
  // conservés, et ils referment le tour de parole IA en cours.
  const TAG_RE = /^\s*\[\/?[A-Z0-9_ÉÈÀÙÇÊÎÔÛ][A-Z0-9_ÉÈÀÙÇÊÎÔÛ \-]*\]/;
  for (const line of lines) {
    if (TAG_RE.test(line)) {
      dropping = false;
      kept.push(line);
      continue;
    }
    if (ROLE_RE.test(line)) {
      dropping = AI_ROLE_RE.test(line);
      if (!dropping) kept.push(line.replace(ROLE_RE, '').trim());
      continue;
    }
    // Ligne de continuation : appartient au tour de parole courant.
    if (!dropping) kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── 2. Sujet + niveau de l'offre ────────────────────────────────────────────
// Les demandes réelles sont souvent tapées vite et mal ("crer une mark de
// vetement", "fait moi une marque") : chaque verbe est donc borné par \b et
// couvre ses fautes courantes, sinon la capture partait au milieu du mot
// (« crer » → sujet « r une mark de vetement »).
const CREATE_VERB_RE = new RegExp(
  '\\b(?:' +
    'cr[ée]{1,2}[rzt]?|cr[ée]{1,2}e[rzt]?|' +
    'fais|fait|fai|faire|fabriqu(?:e|er)|lance(?:r)?|mont(?:e|er)|ouvr(?:e|ir)|' +
    'construi(?:s|re|t)|d[ée]velopp(?:e|er)|build|create|make|launch|start|open|design' +
  ')\\b' +
  '\\s*(?:-?\\s*(?:moi|me|nous|us)\\b\\s*)?' +
  '(?:\\b(?:une|un|des|mon|ma|mes|notre|nos|my|our|an|a|the)\\b\\s*)?' +
  '([^.,;:!?\\n]{3,90})',
  'i',
);

const WANT_RE = new RegExp(
  '(?:je\\s+ve(?:ux|ut|u)|j[\'’]?veux|j[\'’]aimerai?s?|je\\s+souhaite|je\\s+voudrai?s?|' +
  'j[\'’\\s]?ai\\s+besoin\\s+(?:d[\'’\\s]?)?|' +
  'i\\s+wanna|i\\s+want|i[\'’]d\\s+like|i\\s+need|we\\s+want)\\s*' +
  '(?:\\b(?:cr[ée]{1,2}[rz]?|lancer|monter|ouvrir|faire|build|create|launch|start|open|make)\\b\\s*)?' +
  '(?:\\b(?:une|un|des|mon|ma|mes|my|our|an|a|the)\\b\\s*)?' +
  '([^.,;:!?\\n]{3,90})',
  'i',
);

// Formulations qui désignent SANS AMBIGUÏTÉ un prestataire travaillant POUR
// D'AUTRES. Volontairement étroites : « une marque de vêtements au design
// minimaliste » ne doit PAS basculer en agence à cause du mot « design ».
const PROVIDER_RE = new RegExp(
  '(' +
    'agence|agency|cabinet|consulting|consultance|prestataire|freelance|' +
    'studio\\s+(?:de|qui|which|that)|' +
    'pour\\s+(?:d[\'’]autres|les\\s+autres|des\\s+clients|mes\\s+clients|nos\\s+clients|les\\s+entreprises|des\\s+entreprises|les\\s+marques|d[\'’]autres\\s+marques|les\\s+cr[ée]ateurs|des\\s+cr[ée]ateurs)|' +
    'for\\s+(?:other|others|businesses|companies|brands|clients|creators)|' +
    'qui\\s+(?:aide|aident|accompagne|accompagnent|permet\\s+aux?|permettent\\s+aux?)\\s+(?:les\\s+|des\\s+|aux\\s+)?(?:entreprises|marques|cr[ée]ateurs|gens|utilisateurs|clients|autres)|' +
    'help(?:s)?\\s+(?:other\\s+)?(?:businesses|brands|companies|people|creators|users)|' +
    'white\\s*label|marque\\s+blanche|sous-?traitance' +
  ')',
  'i',
);

// Formulations de PROPRIÉTÉ : l'utilisateur parle de SA propre activité. Elles
// l'emportent sur PROVIDER_RE (« je veux MA marque de vêtements pour les
// entreprises » = une marque qui vend aux entreprises, pas une agence).
const FIRST_PARTY_RE = new RegExp(
  '(' +
    '(?:cr[ée]{1,2}(?:e|er|é|es)?|lance|lancer|monte|monter|ouvre|ouvrir|fais|faire|build|create|launch|start|open)' +
    '\\s*-?\\s*(?:moi|me|nous|us)\\b|' +
    '\\b(?:ma|mon|mes|notre|nos)\\s+(?:propre\\s+|nouvelle\\s+|nouveau\\s+)?' +
      '(?:marque|boutique|shop|magasin|entreprise|entr\\w{0,3}p\\w*|soci[ée]t[ée]|business|label|atelier|maison|restaurant|salon|studio|salle|cabinet)|' +
    '\\bmy\\s+(?:own\\s+)?(?:brand|shop|store|business|company|label|studio|restaurant|gym|salon)|' +
    'pour\\s+(?:moi|mon\\s+compte|nous)\\b' +
  ')',
  'i',
);

// ─── 2 bis. Réponses au questionnaire : « Question ? : réponse » ─────────────
// [2026-09-25] Bug « boutique choisie → entreprise qui crée des entreprises » :
// quand l'utilisateur dit seulement « crée-moi une entreprise », on lui propose
// 5 idées et son choix revient dans le transcript sous la forme compilée côté
// client « <question de l'IA> : <option choisie> » — donc sur une LIGNE
// UTILISATEUR. Deux dégâts en cascade :
//   a) `extractSubjectPhrase` aplatissait tout le texte (`\s+` → ' '), donc la
//      frontière de ligne disparaissait et la capture débordait d'une ligne sur
//      l'autre : sujet = « entreprise Quelle entreprise veux-tu créer » ;
//   b) le sujet était pris sur la 1ʳᵉ phrase (« crée-moi une entreprise »),
//      c.-à-d. un PLACEHOLDER générique, alors que l'idée réelle (« Boutique en
//      ligne de produits artisanaux locaux ») arrivait à la ligne suivante.
// Résultat : le verrou disait « l'entreprise EST : entreprise / quelle
// entreprise veux-tu créer » → les ~50 prompts en aval construisaient une
// entreprise QUI CRÉE DES ENTREPRISES, pas la boutique choisie.
//
// Correctifs : segmentation ligne à ligne (+ séparateur « | » utilisé par la
// compilation des réponses), retrait du préfixe question, et sujet générique
// ignoré tant qu'un segment concret existe plus loin.
const ANSWER_SEP_RE = /\n+|\s\|\s/;
const QUESTION_PREFIX_RE = /^[^?\n]{0,220}\?\s*:\s*(\S[\s\S]*)$/;

/** « Quelle entreprise veux-tu créer ?: Boutique … » → « Boutique … ». */
export function stripQuestionPrefix(segment: string): string {
  const s = String(segment || '').trim();
  const m = s.match(QUESTION_PREFIX_RE);
  return (m ? m[1] : s).trim();
}

/**
 * Texte utilisateur débarrassé des questions de l'IA recopiées dans ses
 * réponses. Utilisé pour le SUJET et le NIVEAU : une question comme « Tu vends
 * pour des clients ? » ne doit pas faire basculer l'entreprise en prestataire.
 */
export function stripEchoedQuestions(userText: string): string {
  return String(userText || '')
    .split(/\n/)
    .map(line =>
      line
        .split(/\s\|\s/)
        .map(seg => stripQuestionPrefix(seg))
        .filter(Boolean)
        .join(' | '),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Placeholders : l'utilisateur demande « une entreprise », « un site », « un
// business » sans rien dire de ce que c'est. Ce n'est PAS un sujet : c'est la
// demande de départ, avant le choix de l'idée. On ne s'en sert qu'en dernier
// recours, si aucun segment concret n'existe.
const GENERIC_SUBJECT_RE =
  /^(?:(?:nouvelle?|nouveau|petite?|propre|first|new|small|own)\s+)?(?:entreprise|entreprises|entreprize|entrepise|entr[a-zé]{0,3}p[a-zé]{0,6}|soci[ée]t[ée]|business|businesses|company|companies|startup|start-?up|bo[iî]te|boite|affaire|affaires|projet|project|site|site\s*web|website|web\s*site|page|page\s*web|webpage|landing(?:\s*page)?|app|appli|application|truc|chose|machin|activit[ée]|id[ée]e|idea|marque|brand|label|shop|boutique|store|magasin)\s*$/i;

/** Vrai si la phrase ne dit rien de l'activité (« entreprise », « site »…). */
export function isGenericSubject(phrase: string): boolean {
  const p = String(phrase || '')
    .replace(/[.!?…]+$/, '')
    .trim();
  if (!p) return true;
  return GENERIC_SUBJECT_RE.test(p);
}

function cleanSubjectPhrase(raw: string): string {
  let phrase = String(raw || '').trim();
  phrase = phrase
    // Clause de nommage (« qui s'appelle Noïr »), fautes de frappe incluses
    // (« qui sapelle », « ki sappelle ») : elle nomme la marque, elle ne dit
    // pas ce que l'entreprise EST.
    .replace(/\s*\b(?:qui\s+|ki\s+|that\s+|which\s+)?(?:s[\'’ ]?appell?e|sapell?e|se\s+nomme|appel[ée]e?|nomm[ée]e?|is\s+called|called|named)\b.*$/i, '')
    .replace(/^(?:une|un|des|le|la|les|mon|ma|mes|my|our|an|a|the)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (phrase.length > 90) phrase = phrase.slice(0, 90).replace(/\s+\S*$/, '');
  return phrase;
}

// Réponses META du sélecteur d'idées : l'option « J'ai déjà mon idée — je la
// décris », les « je ne sais pas / surprends-moi ». Elles ne disent RIEN de
// l'activité : les prendre pour sujet donnerait une entreprise nommée
// « j'ai déjà mon idée ».
const META_ANSWER_RE =
  /^(?:j[\s'’]?ai\s+(?:d[ée]j[àa]\s+)?(?:mon|une)\s+id[ée]e|i\s+already\s+have\s+my\s+idea|(?:let\s+me\s+|i(?:'|’)?ll\s+)?describ|je\s+la\s+d[ée]cris|je\s+d[ée]cris|je\s+(?:ne\s+)?sais\s+pas|jsp\b|aucune\s+id[ée]e|peu\s+importe|au\s+choix|comme\s+tu\s+veux|surpren(?:d|ds)-?moi|surprise\s+me|you\s+(?:choose|decide)|i\s+do\s*n[o']?t\s+know|dunno|no\s+idea|whatever|any(?:thing|\s+one))/i;

/** Candidats de sujet, segment par segment, dans l'ordre du transcript. */
function subjectCandidates(userText: string): string[] {
  const out: string[] = [];
  const segments = String(userText || '')
    .replace(/[👋🚀✨🎉💡🔥]/gu, ' ')
    .split(ANSWER_SEP_RE);
  for (const rawSeg of segments) {
    const seg = rawSeg.replace(/\s+/g, ' ').trim();
    if (!seg) continue;
    // Blocs balisés ([PLAN VALIDÉ], [CONTEXTE-QUESTIONS]…) : jamais un sujet.
    if (/^\[/.test(seg)) continue;
    const answer = stripQuestionPrefix(seg);
    if (!answer) continue;
    if (META_ANSWER_RE.test(answer)) continue;
    // Demande d'action (« envoie moi un mail »), demande d'idées, « décide
    // toi-même », « es-tu prêt ? » : rien de tout ça ne décrit l'activité.
    if (isNonSubjectSegment(answer)) continue;
    const m = answer.match(CREATE_VERB_RE) || answer.match(WANT_RE);
    const phrase = cleanSubjectPhrase(m?.[1] || answer);
    if (phrase) out.push(phrase);
  }
  return out;
}

/**
 * Ce que l'entreprise EST. Le 1ᵉʳ segment CONCRET de l'utilisateur gagne : une
 * demande générique (« crée-moi une entreprise ») est sautée au profit de
 * l'idée réellement choisie plus loin (« Boutique en ligne de … »).
 */
export function extractSubjectPhrase(userText: string): string {
  const candidates = subjectCandidates(userText);
  if (!candidates.length) return '';
  return candidates.find(c => !isGenericSubject(c)) || candidates[0];
}

/**
 * Niveau de l'offre. Par défaut `first_party` : « crée-moi X » veut dire « je
 * veux MON X », jamais « je veux une boîte qui fabrique des X pour les autres ».
 * Seules des formulations explicites de prestation basculent en
 * `service_provider`.
 */
export function detectOfferLevel(userText: string): OfferLevel {
  // Les questions de l'IA recopiées dans les réponses de l'utilisateur
  // (« Tu vends pour des clients ? : oui ») ne doivent pas décider du niveau :
  // seul compte ce que l'utilisateur a réellement écrit.
  const t = stripEchoedQuestions(String(userText || ''));
  if (!t.trim()) return 'first_party';
  if (FIRST_PARTY_RE.test(t) && !/\b(agence|agency|cabinet|consulting)\b/i.test(t)) return 'first_party';
  if (PROVIDER_RE.test(t)) return 'service_provider';
  return 'first_party';
}

function detectLang(text: string): 'fr' | 'en' {
  const t = String(text || '').toLowerCase();
  const fr = (t.match(/\b(je|tu|une|des|marque|vêtement|vetement|boutique|pour|avec|mon|ma|mes|moi|veux|veut|veu|fais|fait|créer|creer|crer|cree|crée|souhaite|entreprise|site)\b/g) || []).length;
  const en = (t.match(/\b(i|the|a|an|brand|clothing|shop|want|create|build|with|for|my)\b/g) || []).length;
  // Défaut EN : on ne met un verrou FR que si le français est clairement
  // majoritaire (un texte en néerlandais/espagnol ne doit pas hériter d'un bloc
  // français qui ferait basculer la détection de langue du site).
  return fr > en ? 'fr' : 'en';
}

// ─── 3. Bloc de verrou ───────────────────────────────────────────────────────
export function buildSubjectLock(
  subject: string,
  level: OfferLevel,
  lang: 'fr' | 'en' = 'fr',
): string {
  const s = (subject || (lang === 'fr' ? 'l’activité décrite par l’utilisateur' : 'the business described by the user')).trim();
  if (lang === 'en') {
    const body = level === 'service_provider'
      ? [
          `The business to build IS: "${s}" — a SERVICE PROVIDER working FOR other people or companies. Its customers are those clients.`,
          `Do NOT turn it into the end product its clients sell.`,
        ]
      : [
          `The business to build IS: "${s}", operated by the user for THEIR OWN account, selling directly to its own end customers.`,
          `It is NOT an agency, studio, consultancy, service, marketplace, SaaS, dashboard or tool that creates, manages or sells "${s}" FOR other people or other companies.`,
          `Never move one level up in abstraction: "create me ${s}" means the user owns ${s} — not a business that produces ${s} for third parties.`,
          `Every page, product, image and line of copy must speak as ${s} itself and address ITS end customers.`,
        ];
    return [SUBJECT_LOCK_START_EN, ...body.map(l => `- ${l}`), LOCK_END].join('\n');
  }
  const body = level === 'service_provider'
    ? [
        `L'entreprise à construire EST : « ${s} » — un PRESTATAIRE qui travaille POUR d'autres personnes ou d'autres entreprises. Ses clients sont ces donneurs d'ordre.`,
        `Ne la transforme PAS en le produit final que ses clients revendent.`,
      ]
    : [
        `L'entreprise à construire EST : « ${s} », exploitée par l'utilisateur POUR SON PROPRE COMPTE, qui vend directement à ses clients finaux.`,
        `Elle N'EST PAS une agence, un studio, un cabinet, un service, une place de marché, un SaaS, un tableau de bord ni un outil qui crée, gère ou vend « ${s} » POUR d'autres personnes ou d'autres entreprises.`,
        `Ne monte JAMAIS d'un cran d'abstraction : « crée-moi ${s} » veut dire que l'utilisateur POSSÈDE ${s} — pas une boîte qui fabrique ${s} pour des tiers.`,
        `Toutes les pages, produits, images et textes doivent parler au nom de ${s} et s'adresser à SES clients finaux.`,
      ];
  return [SUBJECT_LOCK_START_FR, ...body.map(l => `- ${l}`), LOCK_END].join('\n');
}

// ─── 3 bis. Questions du questionnaire ───────────────────────────────────────
// `stripAiTurns` jette TOUT ce que l'IA a dit — y compris les questions du
// questionnaire de découverte. Or les réponses de l'utilisateur y renvoient par
// numéro (« 1. streetwear  2. 25-45€  3. Instagram ») : sans les questions,
// elles deviennent illisibles pour les prompts en aval. On récupère donc les
// seules lignes INTERROGATIVES de l'IA, dans un bloc clairement étiqueté
// « contexte », placé APRÈS le texte utilisateur et explicitement non-définissant.
// Les phrases déclaratives de l'IA (« je vais créer ta marque pour toi »),
// cause racine du bug méta, restent supprimées.
export const QUESTIONS_START = '[CONTEXTE-QUESTIONS]';
const QUESTIONS_END = '[/CONTEXTE-QUESTIONS]';
const MAX_QUESTIONS = 12;

export function extractAiQuestions(raw: string): string[] {
  const text = String(raw || '');
  if (!text.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let inAi = false;
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (line.includes(QUESTIONS_START)) { inBlock = true; continue; }
    if (line.includes(QUESTIONS_END)) { inBlock = false; continue; }
    if (!inBlock && ROLE_RE.test(line)) { inAi = AI_ROLE_RE.test(line); }
    if (!inBlock && !inAi) continue;
    const clean = line
      .replace(ROLE_RE, '')
      .replace(/^[\s>*\-–—•·]+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/[*_`#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Seules les interrogations : c'est le contexte utile des réponses.
    if (!clean.includes('?') || clean.length < 8 || clean.length > 240) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

function buildQuestionsBlock(questions: string[], lang: 'fr' | 'en'): string {
  if (!questions.length) return '';
  const note = lang === 'fr'
    ? 'Questions posées par l’assistant, uniquement pour interpréter les réponses ci-dessus. Elles ne définissent NI l’entreprise NI son niveau (voir [SUJET — VERROUILLÉ]).'
    : 'Questions the assistant asked, only to interpret the answers above. They define NEITHER the business NOR its level (see [SUBJECT — LOCKED]).';
  return [QUESTIONS_START, note, ...questions.map(q => `- ${q}`), QUESTIONS_END].join('\n');
}

/** Retire les blocs injectés (verrou + contexte questions) — idempotence. */
export function stripSubjectLock(raw: string): string {
  return String(raw || '')
    .replace(/\[SUJET — VERROUILLÉ[^\]]*\][\s\S]*?\[\/SUJET\]\s*/g, '')
    .replace(/\[SUBJECT — LOCKED[^\]]*\][\s\S]*?\[\/SUJET\]\s*/g, '')
    .replace(/\[CONTEXTE-QUESTIONS\][\s\S]*?\[\/CONTEXTE-QUESTIONS\]\s*/g, '')
    .trim();
}

export function hasSubjectLock(raw: string): boolean {
  const t = String(raw || '');
  return t.includes(SUBJECT_LOCK_START_FR) || t.includes(SUBJECT_LOCK_START_EN);
}

const MAX_IDEA_CHARS = 8000;

/**
 * Normalise une idée (message simple OU transcript complet) en une idée
 * canonique : bloc [SUJET — VERROUILLÉ] + texte de l'utilisateur seul.
 * Idempotent : ré-appliquer la fonction ne réempile pas les blocs.
 */
export function normalizeIdea(raw: string): IdeaSubject {
  // [2026-10-02] D'abord : ne garder que la conversation qui concerne LE
  // PROJET (les échanges « envoie-moi un mail / appelle-moi / SMS » sont
  // retirés) et remplacer « Laquelle t'inspire ?: 1 » par l'idée choisie —
  // AVANT `stripAiTurns`, qui supprime la liste d'idées proposée par l'IA.
  const input = focusProjectTranscript(String(raw || '')).text;
  // Les questions sont lues AVANT le nettoyage (elles vivent dans les tours IA
  // ou dans un bloc [CONTEXTE-QUESTIONS] déjà présent) → idempotent.
  const questions = extractAiQuestions(input);
  const base = stripSubjectLock(input);
  let userText = stripAiTurns(base);
  if (!userText.trim()) userText = base.trim();
  if (userText.length > MAX_IDEA_CHARS) userText = userText.slice(0, MAX_IDEA_CHARS);
  // Sujet / niveau / langue : calculés sur le TEXTE UTILISATEUR SEUL — jamais
  // sur les questions de l'IA, sinon la méta-confusion rentrerait par là.
  const { subject, level } = resolveSubject(userText);
  const lang = detectLang(userText);
  const lock = buildSubjectLock(subject, level, lang);
  const idea = [lock, userText, buildQuestionsBlock(questions, lang)]
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return { userText, level, subject, lang, lock, idea };
}

const MAX_CHOSEN_SUBJECT = 140;

/**
 * Sujet + niveau. Une idée CHOISIE dans une liste proposée par l'IA
 * (« [IDÉE CHOISIE] … ») l'emporte sur tout ce qui précède ; seule une
 * description concrète écrite APRÈS par l'utilisateur la remplace.
 */
export function resolveSubject(userText: string): { subject: string; level: OfferLevel } {
  const chosen = findChosenIdea(userText);
  if (chosen) {
    const after = userText.slice(chosen.index).split('\n').slice(1).join('\n');
    const later = subjectCandidates(after).find(c => !isGenericSubject(c));
    if (later) return { subject: later, level: detectOfferLevel(after) };
    let subject = chosen.description ? `${chosen.title} — ${chosen.description}` : chosen.title;
    if (subject.length > MAX_CHOSEN_SUBJECT) {
      subject = subject.slice(0, MAX_CHOSEN_SUBJECT).replace(/[\s,;:—-]+\S*$/, '');
    }
    // Le niveau se lit sur la DESCRIPTION de l'option (« une boutique en ligne
    // qui… ») : un titre comme « Studio de Mode Circulaire » est un nom de
    // marque, pas un prestataire qui travaille pour d'autres.
    return { subject, level: detectOfferLevel(chosen.description || chosen.title) };
  }
  return { subject: extractSubjectPhrase(userText), level: detectOfferLevel(userText) };
}

/**
 * Garde défensif : renvoie l'idée verrouillée, en la normalisant seulement si
 * elle ne l'est pas déjà. À appeler partout où une idée est LUE depuis la base
 * (anciens projets, chemins d'écriture non couverts).
 */
export function ensureSubjectLock(raw: string): string {
  const t = String(raw || '');
  if (!t.trim()) return t;
  if (hasSubjectLock(t)) return t;
  return normalizeIdea(t).idea;
}
