// [2026-10-01] Mode auto : « il met le prompt dans le chat, répond, mais ne
// travaille pas vraiment ». Cause : le planificateur créait surtout des tâches
// de RÉFLEXION (« confirmer que… », « définir un objectif… », adjust_strategy,
// analyze_metrics) ou des posts pour des réseaux non connectés. L'exécution se
// limitait alors à un paragraphe d'IA, sans aucun livrable.
//
// Ce module (pur, testé) décide ce que le mode auto peut RÉELLEMENT faire
// aujourd'hui, le dit au planificateur, et remet d'aplomb les tâches qu'il
// propose : chaque tâche doit produire un résultat concret et visible.

export type PlannedTask = {
  type?: string;
  agent?: string;
  title?: string;
  description?: string;
  priority?: number;
  slot?: string;
  hour?: number | null;
  platform?: string;
  [k: string]: unknown;
};

export type AutopilotCaps = {
  /** Site généré éditable (pipeline d'édition du chat). */
  hasSite: boolean;
  /** Réseaux sociaux connectés ET disponibles. */
  connectedPlatforms: string[];
  /** Envoi d'e-mail possible (au propriétaire uniquement en automatique). */
  canEmailOwner: boolean;
};

/** Tâches de réflexion pure : jamais plus d'une par lot, et elle doit déboucher sur des actions. */
export const THINKING_TYPES = new Set(['adjust_strategy', 'analyze_metrics']);
const KNOWN_TYPES = new Set([
  'create_post', 'edit_website', 'analyze_metrics', 'engage_comment', 'create_article',
  'adjust_strategy', 'send_email', 'schedule_appointment', 'improve_app',
]);

/** Types que le mode auto sait exécuter pour de vrai avec ces ressources. */
export function executableTypes(caps: AutopilotCaps): string[] {
  const t: string[] = [];
  if (caps.hasSite) t.push('edit_website', 'improve_app');
  t.push('create_article');
  t.push('create_post');
  if (caps.canEmailOwner) t.push('send_email');
  t.push('schedule_appointment', 'analyze_metrics', 'adjust_strategy');
  return t;
}

/** Bloc injecté dans le prompt du planificateur. */
export function capabilitiesBrief(caps: AutopilotCaps): string {
  const lines: string[] = ['WHAT YOU CAN REALLY DO TODAY (every task MUST use one of these and produce a concrete, visible result):'];
  if (caps.hasSite) {
    lines.push('- edit_website / improve_app → REALLY edits the live website (new section, new page, landing page, SEO texts, FAQ, testimonials, offer banner, product copy…). This is your strongest lever: use it.');
  } else {
    lines.push('- There is NO editable website yet: do NOT plan edit_website / improve_app.');
  }
  lines.push(caps.hasSite
    ? '- create_article → writes a full SEO article AND publishes it on the website (blog page). Real traffic lever.'
    : '- create_article → writes a full SEO article saved in the documents.');
  lines.push(caps.connectedPlatforms.length
    ? `- create_post → REALLY publishes on: ${caps.connectedPlatforms.join(', ')} (set "platform" to one of them).`
    : '- create_post → NO social network is connected: the post is only saved as a ready-to-publish draft. Plan at most ONE.');
  if (caps.canEmailOwner) lines.push('- send_email → sends an email to the OWNER only (report, checklist, outreach drafts). Emails to third parties are saved as drafts, never sent.');
  lines.push('- analyze_metrics / adjust_strategy → ONLY if it ends with concrete next actions; at most ONE per batch.');
  lines.push('');
  lines.push('FORBIDDEN: tasks that are only thinking/confirming/defining ("confirm that…", "define the goal…", "freeze…", "decide…", "review…"). Turn them into an ACTION with a deliverable (e.g. "Add a launch offer banner on the home page", "Publish an article: 10 ways to …").');
  lines.push('Write each title as an imperative instruction to execute, and put the precise content to produce in the description.');
  return lines.join('\n');
}

/**
 * Remet d'aplomb les tâches proposées par l'IA :
 * - type inconnu / non exécutable → converti vers l'action réelle la plus proche ;
 * - engage_comment (non branché) → supprimé ;
 * - post sur un réseau non connecté → bascule sur un réseau connecté, sinon 1 brouillon max ;
 * - réflexion pure → 1 maximum par lot.
 */
export function normalizePlannedTasks(tasks: unknown, caps: AutopilotCaps): PlannedTask[] {
  const list = Array.isArray(tasks) ? tasks.filter((t) => t && typeof t === 'object') as PlannedTask[] : [];
  const out: PlannedTask[] = [];
  let thinking = 0;
  let drafts = 0;
  const connected = caps.connectedPlatforms.map((p) => p.toLowerCase());
  for (const raw of list) {
    const t: PlannedTask = { ...raw };
    let type = String(t.type || '').trim();
    if (!KNOWN_TYPES.has(type)) type = caps.hasSite ? 'edit_website' : 'create_article';
    if (type === 'engage_comment') continue;

    if ((type === 'edit_website' || type === 'improve_app') && !caps.hasSite) type = 'create_article';
    if (type === 'send_email' && !caps.canEmailOwner) continue;

    if (type === 'create_post') {
      const p = String(t.platform || '').toLowerCase();
      if (connected.length) {
        if (!connected.includes(p)) t.platform = connected[0];
      } else {
        if (drafts >= 1) {
          if (!caps.hasSite) continue;
          type = 'create_article';
        } else {
          drafts++;
          t.platform = p || 'instagram';
          t.draftOnly = true;
        }
      }
    }

    if (THINKING_TYPES.has(type)) {
      thinking++;
      if (thinking > 1) continue;
    }

    t.type = type;
    t.agent = agentFor(type, t.agent);
    out.push(t);
  }
  return out.slice(0, 6);
}

function agentFor(type: string, current?: string): string {
  const ok = ['content', 'marketing', 'analytics', 'strategist'];
  if (current && ok.includes(current)) return current;
  if (type === 'create_post' || type === 'send_email') return 'marketing';
  if (type === 'analyze_metrics') return 'analytics';
  if (type === 'adjust_strategy' || type === 'schedule_appointment') return 'strategist';
  return 'content';
}

/**
 * Instruction d'édition pour publier un article sur le site (pipeline du chat).
 * Le contenu est fourni intégralement : l'éditeur ne doit pas le résumer.
 */
/** Slug URL stable à partir d'un titre (accents retirés). */
export function articleSlug(title: string): string {
  const s = String(title || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (s.length <= 70) return s || 'article';
  const cut = s.slice(0, 70);
  const i = cut.lastIndexOf('-');
  return (i > 20 ? cut.slice(0, i) : cut).replace(/-+$/g, '') || 'article';
}

/** Corps de l'article prêt pour la page : sans le titre H1 répété ni les séparateurs « --- ». */
export function articleBody(content: string): string {
  return String(content || '')
    .replace(/^\s*#\s+[^\n]*\n+/, '')
    .split('\n').filter((l) => !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function articlePublishInstruction(
  article: { title: string; content: string; metaDescription?: string | null },
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const body = articleBody(article.content).slice(0, 9000);
  const slug = articleSlug(article.title);
  return [
    `Publie cet article de blog sur le site.`,
    `MODÈLE DE DONNÉES OBLIGATOIRE (une seule source de vérité) :`,
    `- Tous les articles vivent dans un tableau statique exporté depuis src/lib/blog.ts : export const posts = [{ slug, title, date, excerpt, metaDescription, content }] (content = le markdown complet).`,
    `- N'utilise AUCUNE API, aucun data.list / fetch / base de données pour le blog.`,
    `- src/pages/Blog.tsx (route /blog) liste les articles en lisant ce tableau (les plus récents en premier), chaque carte fait un lien vers /blog/<slug>.`,
    `- src/pages/BlogPost.tsx (route /blog/:slug) cherche l'article dans CE MÊME tableau par slug, affiche titre, date, texte complet rendu proprement (titres, paragraphes, listes) et un appel à l'action vers les produits. Le markdown (##, **gras**, listes) doit être RENDU en vrais titres/paragraphes/listes : aucun symbole markdown brut visible. Si le slug est inconnu : message « Article introuvable » + lien retour /blog.`,
    `- Si src/lib/blog.ts existe déjà : AJOUTE ce nouvel article au tableau et GARDE les anciens. Si Blog.tsx ou BlogPost.tsx lisent ailleurs (API, liste codée en dur), corrige-les pour lire src/lib/blog.ts.`,
    `- S'il n'y a pas encore de lien « Blog » dans la navigation ou le pied de page, ajoute-le.`,
    `- Style identique au reste du site.`,
    `- Reprends le texte TEL QUEL (ne le résume pas, ne le raccourcis pas).`,
    '',
    `SLUG : ${slug}`,
    `DATE : ${today}`,
    `TITRE : ${String(article.title || '').slice(0, 200)}`,
    article.metaDescription ? `MÉTA DESCRIPTION : ${String(article.metaDescription).slice(0, 200)}` : null,
    '',
    'TEXTE (markdown) :',
    body,
  ].filter((l): l is string => l !== null).join('\n');
}

/** Actions de suivi proposées par une tâche de réflexion → tâches exécutables. */
export function followUpTasks(raw: unknown, caps: AutopilotCaps, max = 2): PlannedTask[] {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = normalizePlannedTasks(list, caps).filter((t) => !THINKING_TYPES.has(String(t.type)));
  return cleaned.slice(0, max);
}
