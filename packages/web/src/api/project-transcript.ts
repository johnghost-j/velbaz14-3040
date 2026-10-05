// ─── Transcript du chat → seule la conversation qui concerne LE PROJET ───────
// [2026-10-02] Bug « entreprise de mails » : dans une même conversation,
// l'utilisateur demande d'abord à l'IA de lui envoyer un mail, de l'appeler et
// de lui envoyer un SMS, PUIS lui demande des idées de business, choisit
// « 1 » (Studio de Mode Circulaire) et lance le build. Résultat : un projet
// « MailFlow » — une boutique d'envoi de mails / appels / SMS.
//
// Trois causes, corrigées ici :
//   1. `triggerBuild` (web/pages/chat.tsx) envoie TOUT le transcript comme idée,
//      y compris les échanges d'actions (mail, appel, SMS, image, PDF), qui
//      n'ont rien à voir avec le projet. Le 1ᵉʳ message concret étant
//      « envoie moi un mail », c'est lui qui devenait le sujet verrouillé.
//   2. La réponse au choix d'idée arrive sous la forme « <question> ?: 1 ».
//      `stripAiTurns` supprime ensuite la liste des idées (tour IA) : « 1 » ne
//      voulait plus rien dire et l'idée choisie était perdue.
//   3. Les messages « méta » (« propose moi des idées », « décide toi-même et
//      lance », « es-tu prêt à créer mon entreprise ? ») étaient pris pour des
//      descriptions d'activité.
//
// Fonctions PURES (aucun accès réseau/DB) : utilisées côté serveur par
// `normalizeIdea` ET côté client par `triggerBuild`, pour que plan de pages,
// brief et méta reçoivent tous la même idée nettoyée.

import { detectActionRequest } from './agents/action-intent';
import { commsIntentKind } from './calls/comms-intent';

export const CHOSEN_IDEA_TAG = '[IDÉE CHOISIE]';

type Role = 'user' | 'ai' | 'block' | 'pre';
interface Turn { role: Role; lines: string[] }

const ROLE_LINE_RE = /^\s*(User|Utilisateur|AI|Assistant|Velbaz)\s*:\s?/i;
const AI_ROLE_RE = /^\s*(AI|Assistant|Velbaz)\s*:/i;
// Marqueurs internes que l'IA écrit DANS sa réponse : ils appartiennent au tour
// IA, ce ne sont pas des blocs ajoutés par le client.
const AI_MARKER_RE = /^\s*\[\/?(QUESTIONS_ASKED|QUESTIONS|CALL_VIEW|SMS_VIEW|CALL|SMS|BUILD_COMPANY|IMAGE\w*|EMAIL\w*|MAIL\w*|PDF\w*|DOC\w*|FILE\w*|ACTION\w*|TOOL\w*|PRODUCT\w*|PREVIEW\w*|CARD\w*|WIDGET\w*)[\]:|]/i;
// Bloc ajouté par le client (« [PLAN VALIDÉ] … », « [IDÉE CHOISIE] … ») :
// toujours conservé, jamais rattaché à un échange d'action.
const CLIENT_BLOCK_RE = /^\s*\[(?!\/)[A-ZÀ-Ý0-9_][^\]\n]{1,80}\]/;

// ─── Intentions ──────────────────────────────────────────────────────────────
const PROJECT_WORD = String.raw`(?:entr\w{0,3}p\w*|soci[ée]t[ée]|business|busines|bizness|boutique|e-?shop|shop|store|magasin|marque|brand|label|startup|start-?up|bo[iî]te|projet|project|site|website|app|appli|application|restaurant|salon|atelier|e-?commerce|commerce|activit[ée])`;
const PROJECT_VERB = String.raw`(?:cr[ée]{1,2}\w*|lanc\w*|mont\w*|ouvr\w*|fai[st]?|faire|build|create|make|launch|start|open|construi\w*|d[ée]marr\w*|d[ée]velopp\w*)`;
// Fin de mot qui tient compte des accents (\b échoue après « é »).
const EOW = String.raw`(?![\wà-ÿ])`;
const PROJECT_VERB_CTX_RE = new RegExp(String.raw`\b${PROJECT_VERB}${EOW}[^.?!\n]{0,60}\b${PROJECT_WORD}${EOW}`, 'i');
const WANT_PROJECT_RE = new RegExp(String.raw`\b(?:je\s+ve\w*|j[\s'’]?veux|j[\s'’]aimerai\w*|je\s+voudrai\w*|je\s+souhaite|i\s+want|i\s+wanna|i[\s'’]d\s+like)\b[^.?!\n]{0,30}\b(?:ma|mon|une?|my|a|an)\s+(?:propre\s+|own\s+)?${PROJECT_WORD}${EOW}`, 'i');
// « propose moi des idées », « donne-moi des idées de business », « any ideas? »
const IDEA_REQUEST_RE = new RegExp(String.raw`\b(?:propos\w*|donn\w*|sugg[ée]r\w*|suggest\w*|trouv\w*|give|brainstorm\w*|aide[sz]?[- ]moi|help\s+me)\b[^.?!\n]{0,40}\b(?:id[ée]{1,2}s?|ideas?|pistes?|concepts?)${EOW}|\bid[ée]{1,2}s?\s+(?:de|d['’])\s*${PROJECT_WORD}${EOW}|\b(?:business|startup)\s+ideas?\b|^\s*(?:des\s+)?(?:id[ée]{1,2}s?|ideas?)\s*\??\s*$`, 'i');

/** Demande d'action ponctuelle (mail, appel, SMS, image, PDF) — pas le projet. */
export function isActionRequest(text: string): boolean {
  const t = String(text || '');
  return !!(detectActionRequest(t, { inProject: true }) || commsIntentKind(t));
}

/** Demande d'idées de business (« propose-moi des idées »). */
export function isIdeaRequest(text: string): boolean {
  return IDEA_REQUEST_RE.test(String(text || ''));
}

/** Le message parle de créer / lancer LE projet (ou demande des idées pour). */
export function isProjectIntent(text: string): boolean {
  const t = String(text || '');
  if (!t.trim() || isActionRequest(t)) return false;
  return PROJECT_VERB_CTX_RE.test(t) || WANT_PROJECT_RE.test(t) || isIdeaRequest(t);
}

// Messages qui pilotent le flux mais ne décrivent PAS l'activité.
const SKIP_ANSWER_RE = /\b(?:skip these questions|decide for yourself|don'?t ask me again|launch directly|d[ée]cide[sz]?\s+(?:toi[- ]m[êe]me|pour moi|[àa] ma place)|lance[sz]?[- ](?:toi|le|tout|directement)|vas-?y|go\s*!?\s*$)/i;
const READY_QUESTION_RE = /\b(?:es|est|êtes|etes)[- ]?(?:tu|vous)?\s+pr[êe]t|\bare\s+you\s+ready\b|\bpr[êe]t\s+(?:pour|à|a)\b/i;

/**
 * Segment qui ne peut PAS être le sujet de l'entreprise : demande d'action,
 * demande d'idées, consigne « décide toi-même », question « es-tu prêt ? ».
 */
export function isNonSubjectSegment(segment: string): boolean {
  const s = String(segment || '').trim();
  if (!s) return true;
  return isActionRequest(s) || isIdeaRequest(s) || SKIP_ANSWER_RE.test(s) || READY_QUESTION_RE.test(s);
}

// ─── Choix d'une option numérotée ────────────────────────────────────────────
const ORDINALS: Array<[RegExp, number]> = [
  [/^(?:premi[eè]re?|first|1st|1[eè]re?|1er)$/i, 1],
  [/^(?:deuxi[eè]me|seconde?|second|2nd|2[eè]me|2e)$/i, 2],
  [/^(?:troisi[eè]me|third|3rd|3[eè]me|3e)$/i, 3],
  [/^(?:quatri[eè]me|fourth|4th|4[eè]me|4e)$/i, 4],
  [/^(?:cinqui[eè]me|fifth|5th|5[eè]me|5e)$/i, 5],
  [/^(?:sixi[eè]me|sixth|6th|6[eè]me|6e)$/i, 6],
];

/**
 * « 1 », « la 2 », « option 3 », « la première », « je prends la 2 » → numéro.
 * `-1` = « la dernière ». `null` si la réponse n'est pas un simple choix.
 */
export function parseChoiceNumber(answer: string): number | null {
  let a = String(answer || '')
    .toLowerCase()
    .replace(/[*_`"«»“”]/g, '')
    .replace(/[.!?…]+\s*$/g, '')
    .trim();
  if (!a || a.length > 60) return null;
  a = a
    .replace(/^(?:je\s+(?:prends?|choisi[st]?|veux|pr[ée]f[èe]re|pars?\s+sur)|j[\s'’]?(?:aime|prends|choisis)|on\s+(?:prend|part\s+sur)|i\s+(?:choose|pick|take|want|like|prefer)|let'?s\s+go\s+(?:with|for))\s+/, '')
    .replace(/^(?:avec\s+|with\s+|sur\s+)/, '')
    .replace(/^(?:la|le|l['’]|the|celle|celui|number|num[ée]ro|n°|no\.?|#)\s*/, '')
    .replace(/^(?:option|opt|piste|id[ée]e|idea|choix|choice|proposition)\s*(?:n°|no\.?|#)?\s*/, '')
    .replace(/\s+(?:option|piste|id[ée]e|idea|choix|svp|stp|please|merci|stp\s*!?)$/, '')
    .trim();
  const num = a.match(/^(\d{1,2})(?:\s*(?:[èe]re|re|er|[èe]me|eme|e|st|nd|rd|th))?$/);
  if (num) return parseInt(num[1], 10) || null;
  if (/^(?:derni[eè]re?|last(?:\s+one)?)$/.test(a)) return -1;
  for (const [re, n] of ORDINALS) if (re.test(a)) return n;
  return null;
}

export interface ListOption { title: string; description: string }

function cleanMd(s: string): string {
  return s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

/** Liste numérotée (« 1. **Titre** : description ») d'un message de l'IA. */
export function extractNumberedOptions(text: string): ListOption[] {
  const out: ListOption[] = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:[-*•]\s*)?(?:(\d{1,2})[.)]|(\d)️?⃣)\s+(.+)$/);
    if (!m) continue;
    const n = parseInt(m[1] || m[2], 10);
    const body = m[3].trim();
    let title = '';
    let description = '';
    const bold = body.match(/^\*\*(.+?)\*\*\s*(?:[:\-–—]\s*)?(.*)$/);
    if (bold) {
      title = cleanMd(bold[1]).replace(/\s*:$/, '');
      description = cleanMd(bold[2]);
    } else {
      const plain = cleanMd(body);
      const sep = plain.match(/^(.{1,90}?)\s+(?:[:–—]|-)\s+(.+)$/) || plain.match(/^(.{1,90}?)\s*:\s+(.+)$/);
      title = sep ? sep[1].trim() : plain;
      description = sep ? sep[2].trim() : '';
    }
    if (!title) continue;
    // La numérotation recommence (2ᵉ liste) : on garde la dernière liste.
    if (n === 1) out.length = 0;
    out[n - 1] = { title, description };
  }
  return out.filter(Boolean);
}

/** Texte de l'option, sur une ligne : « Titre — description ». */
export function formatChosenIdea(o: ListOption): string {
  return `${CHOSEN_IDEA_TAG} ${o.title}${o.description ? ` — ${o.description}` : ''}`;
}

/** Dernière idée choisie dans un texte (« [IDÉE CHOISIE] Titre — description »). */
export function findChosenIdea(text: string): ListOption & { index: number } | null {
  const re = /^\s*\[IDÉE CHOISIE\]\s*(.+)$/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || '')))) last = m;
  if (!last) return null;
  const body = last[1].trim();
  const i = body.indexOf(' — ');
  return {
    title: (i > 0 ? body.slice(0, i) : body).trim(),
    description: i > 0 ? body.slice(i + 3).trim() : '',
    index: last.index,
  };
}

// ─── Parsing du transcript ───────────────────────────────────────────────────
function parseTurns(raw: string): Turn[] | null {
  const lines = String(raw || '').split('\n');
  if (!lines.some(l => ROLE_LINE_RE.test(l))) return null;
  const turns: Turn[] = [];
  let cur: Turn = { role: 'pre', lines: [] };
  for (const line of lines) {
    const role = line.match(ROLE_LINE_RE);
    if (role) {
      turns.push(cur);
      cur = { role: AI_ROLE_RE.test(line) ? 'ai' : 'user', lines: [line.replace(ROLE_LINE_RE, '')] };
      continue;
    }
    // Un bloc client se colle APRÈS une ligne vide quand il suit un tour IA
    // (« AI: ok\n\n[PLAN VALIDÉ] … ») ; sans ligne vide, c'est l'IA qui écrit.
    const prevBlank = !cur.lines.length || !cur.lines[cur.lines.length - 1].trim();
    if (CLIENT_BLOCK_RE.test(line) && !AI_MARKER_RE.test(line) && cur.role !== 'block'
      && (cur.role !== 'ai' || prevBlank)) {
      turns.push(cur);
      cur = { role: 'block', lines: [line] };
      continue;
    }
    cur.lines.push(line);
  }
  turns.push(cur);
  return turns.filter(t => t.lines.some(l => l.trim()));
}

/** Questions d'un bloc [QUESTIONS][{"q":…}][/QUESTIONS] en texte lisible. */
function questionsFromBlock(line: string): string[] {
  const m = line.match(/\[QUESTIONS\]([\s\S]*?)\[\/QUESTIONS\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return [];
    return arr.map((q: any) => String(q?.q || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Tour IA nettoyé : marqueurs internes retirés, questions [QUESTIONS] lisibles. */
function cleanAiLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (/\[QUESTIONS\]/.test(line)) { out.push(...questionsFromBlock(line)); continue; }
    if (AI_MARKER_RE.test(line)) continue;
    out.push(line.replace(/\[(CALL_VIEW|SMS_VIEW)\][\s\S]*?\[\/\1\]/g, '').trimEnd());
  }
  return out;
}

const ANSWER_SEP = /\s\|\s/;
const Q_PREFIX_RE = /^([^?\n]{0,220}\?\s*:\s*)(\S[\s\S]*)$/;

/** Réponse « Q ?: 1 » → ligne [IDÉE CHOISIE] si l'IA venait de proposer une liste. */
function resolveChoiceLines(lines: string[], options: ListOption[]): { lines: string[]; chosen: ListOption | null } {
  if (!options.length) return { lines, chosen: null };
  let chosen: ListOption | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const kept: string[] = [];
    for (const seg of line.split(ANSWER_SEP)) {
      const q = seg.trim().match(Q_PREFIX_RE);
      const answer = q ? q[2] : seg.trim();
      const n = parseChoiceNumber(answer);
      const opt = n === -1 ? options[options.length - 1] : n ? options[n - 1] : undefined;
      if (opt) { chosen = opt; continue; }
      kept.push(seg);
    }
    if (kept.length) out.push(kept.join(' | '));
  }
  if (chosen) out.push(formatChosenIdea(chosen));
  return { lines: out, chosen };
}

export interface FocusedTranscript {
  /** Transcript « User: / AI: » limité au projet (ou le texte d'origine). */
  text: string;
  /** Idée choisie dans une liste proposée par l'IA, s'il y en a une. */
  chosen: ListOption | null;
  /** Nombre de tours retirés parce qu'ils concernaient une action ponctuelle. */
  droppedActionTurns: number;
}

/**
 * Ne garde du transcript que ce qui concerne le PROJET :
 *  - retire chaque échange d'action ponctuelle (la demande, les questions de
 *    l'IA, les réponses de l'utilisateur, la confirmation) jusqu'au prochain
 *    message qui reparle du projet ;
 *  - remplace « Laquelle t'inspire ?: 1 » par l'option réellement choisie ;
 *  - retire les marqueurs internes de l'IA ([CALL_VIEW], [QUESTIONS_ASKED]…).
 * Un texte qui n'est pas un transcript est renvoyé tel quel. Idempotent.
 */
export function focusProjectTranscript(raw: string): FocusedTranscript {
  const input = String(raw || '');
  const turns = parseTurns(input);
  if (!turns) return { text: input.trim(), chosen: null, droppedActionTurns: 0 };

  type Topic = 'none' | 'project' | 'action';
  let topic: Topic = 'none';
  let dropped = 0;
  let chosen: ListOption | null = null;
  let lastAiOptions: ListOption[] = [];
  const kept: Turn[] = [];

  for (const t of turns) {
    if (t.role === 'pre' || t.role === 'block') { kept.push(t); continue; }
    const body = t.lines.join('\n');
    if (t.role === 'user') {
      if (isActionRequest(body)) topic = 'action';
      else if (isProjectIntent(body)) topic = 'project';
      // Sinon : suite de l'échange en cours (numéro, texte du SMS, « tu l'as
      // envoyé ? », réponse à une question du projet…).
      if (topic === 'action') { dropped++; continue; }
      const r = resolveChoiceLines(t.lines, lastAiOptions);
      if (r.chosen) chosen = r.chosen;
      kept.push({ role: 'user', lines: r.lines });
      continue;
    }
    // Tour IA : même sujet que le message utilisateur auquel il répond.
    if (topic === 'action') { dropped++; continue; }
    const opts = extractNumberedOptions(body);
    if (opts.length >= 2) lastAiOptions = opts;
    kept.push({ role: 'ai', lines: cleanAiLines(t.lines) });
  }

  // Conversation faite UNIQUEMENT d'actions : rien à quoi se raccrocher, on ne
  // fabrique pas une idée vide — le texte d'origine reste la seule source.
  if (!kept.some(t => t.role === 'user' && t.lines.some(l => l.trim()))) {
    return { text: input.trim(), chosen: null, droppedActionTurns: 0 };
  }

  const text = kept
    .map(t => {
      const lines = t.lines.filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
      if (!lines.length) return '';
      if (t.role === 'user') return `User: ${lines.join('\n')}`.trimEnd();
      if (t.role === 'ai') return `AI: ${lines.join('\n')}`.trimEnd();
      return lines.join('\n').trimEnd();
    })
    .filter(s => s.replace(/^(User|AI):\s*/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, chosen, droppedActionTurns: dropped };
}
