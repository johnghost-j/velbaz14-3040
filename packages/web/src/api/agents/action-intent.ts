// ─── Détection d'une demande d'ACTION (email, image, PDF) ────────────────────
// Bug corrigé (2026-10-02) : « envoie-moi un mail à mon compte » passait par la
// conversation simple, SANS outils → « je ne peux pas envoyer d'email ». Ces
// demandes sont désormais reconnues avant le routage (découverte, agents,
// spécialistes) et vont directement à la boucle d'outils qui sait le faire.
//
// Conservateur : une demande de CRÉATION de site/app (« crée un site avec une
// photo ») reste au builder ; le logo garde son flux dédié.

export type ActionKind = 'email' | 'image' | 'document';

const BUILD_CONTEXT_RE = /\b(site|website|app|application|appli|landing|boutique|e-?shop|entreprise|company|startup|page d'accueil|homepage)\b/i;
const BUILD_VERB_RE = /\b(cr[ée]{1,2}[a-z]*|construi[a-z]*|build|make|fais|fait|faire|d[ée]veloppe[a-z]*|g[ée]n[èe]re[a-z]*|lance[a-z]*)\b/i;

const EMAIL_RE = new RegExp([
  // « envoie-moi un mail », « send me an email », « écris un email à … »
  "(?<![a-zà-ÿ])(envoi[a-z]*|envoy[a-z]*|renvoi[a-z]*|send|sends|shoot|drop|[ée]cri[a-z]*|write|r[ée]dige[a-z]*|forward|transf[èe]r[a-z]*)\\b[^.?!\\n]{0,60}\\b(e-?mails?|mails?|courriels?|mels?)\\b",
  // « mail-moi », « email me », « maile-moi »
  "\\b(e-?mail|mail|maile)[- ]?(moi|me)\\b",
  // « un mail à mon compte / à moi / à x@y.z »
  "\\b(e-?mails?|mails?|courriels?)\\b[^.?!\\n]{0,40}\\b(à|a|to|pour|sur)\\s+(moi|me|myself|mon compte|ma bo[îi]te|mon adresse|[\\w.+-]+@[\\w-]+\\.)",
  // « par mail » + verbe d'envoi : « envoie-le-moi par mail »
  "\\b(envoi[a-z]*|send)\\b[^.?!\\n]{0,40}\\bpar (e-?mail|mail|courriel)\\b",
].join('|'), 'i');

const IMAGE_RE = /\b(g[ée]n[èe]r[a-z]*|cr[ée]{1,2}[a-z]*|fais|fait|faire|dessin[a-z]*|imagin[a-z]*|make|generate|draw|create|produi[a-z]*|montre[a-z]*-moi)\b[^.?!\n]{0,30}\b(images?|illustrations?|photos?|visuels?|dessins?|pictures?|wallpapers?|fonds? d'[ée]cran|affiches?|posters?|banni[èe]res?|artworks?)\b/i;

const PDF_RE = /\b(g[ée]n[èe]r[a-z]*|cr[ée]{1,2}[a-z]*|fais|fait|faire|r[ée]dig[a-z]*|make|create|generate|write|export[a-z]*|pr[ée]pare[a-z]*)\b[^.?!\n]{0,50}\b(pdf)\b/i;

/** Type d'action demandée, ou null pour une demande ordinaire. */
export function detectActionRequest(message: string, opts: { inProject?: boolean } = {}): ActionKind | null {
  const m = String(message || '').trim();
  if (!m || m.length > 2000) return null;
  const isBuild = BUILD_VERB_RE.test(m) && BUILD_CONTEXT_RE.test(m);
  // Rapport de bug (« mon site n'envoie pas les mails ») : une question, pas un ordre.
  const bugReport = /\b(n'|ne\s+(s')?)(envoi|envoy|part|arriv|marche|fonctionne)[a-z]*\s+(pas|plus|jamais)\b|\b(bug|probl[èe]me|erreur|spam)\b/i.test(m);
  if (EMAIL_RE.test(m) && !bugReport && !/\b(formulaire|newsletter|form)\b/i.test(m)) {
    // « crée un site qui envoie des mails » = build, pas un envoi maintenant.
    if (!(isBuild && !/\b(moi|me|mon compte)\b/i.test(m))) return 'email';
  }
  if (IMAGE_RE.test(m) && !isBuild && !/\blogo\b/i.test(m)) return 'image';
  if (opts.inProject && PDF_RE.test(m) && !isBuild) return 'document';
  return null;
}

/** L'IA a-t-elle refusé une action qu'elle sait faire ? (filet anti-refus) */
export function isActionRefusal(reply: string, kind: ActionKind): boolean {
  const r = String(reply || '');
  const cant = /(je ne (peux|suis) pas|je n'ai pas (la possibilit[ée]|acc[èe]s|les moyens)|impossible pour moi|pas en mesure|i (can(no|')t|am unable|don't have (the ability|access))|unable to|not able to)/i;
  if (!cant.test(r)) return false;
  const obj = kind === 'email'
    ? /(e-?mails?|mails?|courriels?)/i
    : kind === 'image' ? /(images?|photos?|illustrations?|visuels?|dessins?|pictures?)/i : /(pdf|documents?|fichiers?)/i;
  return obj.test(r);
}

/** Outils dont l'appel prouve que l'action a été tentée pour de vrai. */
export const ACTION_TOOL: Record<ActionKind, string> = {
  email: 'send_email',
  image: 'generate_image',
  document: 'create_document',
};

/** Rappel ajouté au prompt quand le modèle a refusé une action qu'il sait faire. */
export function actionNudge(kind: ActionKind): string {
  const what = kind === 'email' ? 'envoyer cet email' : kind === 'image' ? 'générer cette image' : 'créer ce document';
  return `\n\nRAPPEL IMPÉRATIF : tu as RÉELLEMENT l'outil ${ACTION_TOOL[kind]} pour ${what}. ` +
    `Ne réponds pas que tu ne peux pas : appelle ${ACTION_TOOL[kind]} maintenant, puis rapporte exactement son résultat ` +
    `(succès ou erreur). N'annonce jamais un succès que l'outil n'a pas confirmé.`;
}

interface CallLike { tool: string; ok: boolean; summary: string }

/**
 * Compte rendu factuel quand le modèle s'est arrêté sans rédiger après une
 * action réelle. Construit UNIQUEMENT à partir du journal des outils.
 */
export function reportFromCalls(calls: CallLike[], lang: 'fr' | 'en' = 'fr'): string {
  const lines: string[] = [];
  for (const c of calls) {
    if (!(c.tool in TOOL_LABELS)) continue;
    const [fr, en] = TOOL_LABELS[c.tool];
    const label = lang === 'fr' ? fr : en;
    if (c.ok && c.tool === 'generate_image' && /^https?:\/\//.test(c.summary)) {
      lines.push(`${label} : ${lang === 'fr' ? 'terminé' : 'done'}.\n\n[IMG:${c.summary}]`);
    } else if (c.ok && c.tool === 'create_document' && c.summary.includes('|')) {
      lines.push(`${label} : ${lang === 'fr' ? 'enregistré' : 'saved'}.\n\n[FILE:${c.summary}]`);
    } else {
      lines.push(`${label} : ${c.ok ? (lang === 'fr' ? 'fait' : 'done') : (lang === 'fr' ? 'échec' : 'failed')} (${c.summary}).`);
    }
  }
  return lines.join('\n\n');
}

const TOOL_LABELS: Record<string, [string, string]> = {
  send_email: ['Email', 'Email'],
  generate_image: ['Image', 'Image'],
  create_document: ['Document', 'Document'],
};

/** Le modèle annonce-t-il l'action comme faite ? (sans appel d'outil = faux succès) */
export function claimsActionDone(reply: string, kind: ActionKind): boolean {
  const r = String(reply || '');
  if (kind === 'email') return /\b(e-?mail|mail|courriel)s?\b[^.!?\n]{0,40}(envoy[ée]|\bparti|\bsent\b|\bdelivered\b)|\bje (t'|vous )?ai (bien )?envoy[ée]|\bi(['’]ve| have)? sent\b/i.test(r);
  if (kind === 'image') return /\[IMG:/i.test(r) || /\b(voici|here is|here's)\b[^.!?\n]{0,30}\b(image|illustration|visuel|picture)\b/i.test(r);
  return /\[FILE:/i.test(r) || /\b(document|pdf)\b[^.!?\n]{0,40}\b(cr[ée]{2}|pr[êe]t|enregistr[ée]|ready|created|saved)\b/i.test(r);
}

/** Message honnête quand l'action n'a pas pu être lancée du tout. */
export function actionUnavailableMessage(kind: ActionKind, lang: 'fr' | 'en'): string {
  if (lang === 'en') {
    const none = kind === 'email' ? 'No email was sent' : kind === 'image' ? 'No image was generated' : 'No document was created';
    return `I couldn't run that action: the AI service didn't respond. ${none}. Please try again in a moment.`;
  }
  const none = kind === 'email' ? "Aucun email n'a été envoyé" : kind === 'image' ? "Aucune image n'a été générée" : "Aucun document n'a été créé";
  return `Je n'ai pas pu exécuter l'action : le service IA n'a pas répondu. ${none}. Réessaie dans un instant.`;
}

/** Rappel des actions réelles, injecté dans les prompts de conversation. */
export const ACTION_CAPABILITIES_TEXT =
  "- Actions RÉELLES depuis le chat : envoyer un vrai email (par défaut à l'adresse du compte de l'utilisateur), " +
  "générer de vraies images, créer des documents téléchargeables en PDF, chercher sur le web, exécuter du code. " +
  "Ne dis JAMAIS « je ne peux pas envoyer d'email / générer d'image / créer de document » : ces actions existent. " +
  "N'annonce jamais qu'une action est faite si elle ne l'a pas été.";

/**
 * L'IA demande-t-elle une information ? Une question (« ? ») ou une demande
 * à l'impératif sans point d'interrogation : « il me faut son adresse email.
 * Donne-la moi » (mesuré le 2026-10-02 — sans « ? », la réponse de
 * l'utilisateur partait au classifieur et l'IA inventait « ✅ Email envoyé »).
 */
const ASKS_INFO_RE = /\?|\b(il me (faut|manque)|j'ai besoin d|j'aurais besoin d|donne[sz]?[- ](moi|la|le|les|nous)|envoie[sz]?[- ]moi (son|ton|l'|leur|ta|tes|ses)|indique[sz]?[- ](moi|nous)|pr[ée]cise[sz]?[- ]?(moi)?|dis[- ]moi|communique[sz]?[- ]moi|peux[- ]tu me (donner|dire|pr[ée]ciser|communiquer|indiquer)|merci de (me )?(donner|pr[ée]ciser|indiquer|communiquer)|quelle (est )?(son|ton|l')? ?adresse|i need|please (provide|share|send|tell|give)|let me know|tell me|give me|what('s| is) (the|their|his|her|your)\b)/i;

export function asksForInfo(text: string): boolean {
  return ASKS_INFO_RE.test(String(text || ''));
}

/**
 * Suite d'une demande d'action : l'IA a posé une question (« quelle adresse ? »,
 * « quel sujet ? ») et l'utilisateur répond (« son adresse c'est x@y.be »).
 * Sans ça, la réponse — qui ne contient aucun mot d'action — partait au
 * classifieur, qui la prenait pour un ordre de BUILD (mesuré le 2026-10-02).
 */
export function followUpActionKind(
  history: Array<{ role?: string; content?: string | null }>,
  message: string,
  opts: { inProject?: boolean } = {},
): ActionKind | null {
  const m = String(message || '').trim();
  if (!m || m.length > 500) return null;
  if (BUILD_VERB_RE.test(m) && BUILD_CONTEXT_RE.test(m)) return null;
  const h = Array.isArray(history) ? history : [];
  let ai = -1, ui = -1;
  for (let i = h.length - 1; i >= 0; i--) {
    if (ai < 0 && h[i]?.role === 'assistant') ai = i;
    if (h[i]?.role === 'user') { ui = i; break; }
  }
  // Ordre attendu : … demande utilisateur, PUIS question de l'IA, puis ce message.
  if (ui < 0 || ai < ui) return null;
  const asked = String(h[ai]?.content || '');
  if (!asksForInfo(asked)) return null;
  const kind = detectActionRequest(String(h[ui]?.content || ''), opts);
  // L'action a déjà été faite (« Email envoyé ! Autre chose ? ») : la suite
  // est une nouvelle conversation, pas une reprise — sinon risque de doublon.
  if (!kind || claimsActionDone(asked, kind)) return null;
  return kind;
}

/**
 * Un email demandé par l'utilisateur n'a-t-il pas encore été envoyé ? Vrai si
 * ce message le demande, ou si l'un des 3 derniers messages utilisateur l'a
 * demandé SANS qu'aucune réponse ultérieure ne l'ait déjà annoncé envoyé
 * (sinon « merci » → « l'email est bien parti » rejouerait l'envoi : doublon).
 */
export function emailStillPending(
  history: Array<{ role?: string; content?: string | null }>,
  message: string,
  inProject: boolean,
): boolean {
  if (detectActionRequest(message, { inProject }) === 'email') return true;
  const userIdx = history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).slice(-3);
  for (let k = userIdx.length - 1; k >= 0; k--) {
    const i = userIdx[k];
    if (detectActionRequest(String(history[i].content || ''), { inProject }) !== 'email') continue;
    return !history.slice(i + 1).some((m) => m.role === 'assistant' && claimsActionDone(String(m.content || ''), 'email'));
  }
  return false;
}
