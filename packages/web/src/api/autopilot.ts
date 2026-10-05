/**
 * VELBAZ AUTOPILOT ENGINE
 * 
 * 4 AI agents running a company 24/7:
 * - Strategist: morning plan, revenue analysis, decides what to do
 * - Content: creates posts, articles, images
 * - Marketing: posts on social, engages with audience
 * - Analytics: tracks stats, detects anomalies
 * 
 * Work cycle:
 * 1. Morning plan (~8am) — Strategist analyzes and plans the day
 * 2. Hourly tick — check if tasks need execution
 * 3. Event-reactive — respond to new data
 * 4. Can WAIT — not every tick produces action
 */

import { db } from './database/index';
import { eq, and, desc, asc, gte, lte, isNull, or, sql, count, inArray } from 'drizzle-orm';
import { dbRetry } from './db-retry';
import { runWithVelbazModeForCompany } from './agent/velbaz2-flag';
import * as schema from './database/schema';
import { v4 as uuidv4 } from 'uuid';
import { runContentPipeline } from './social/pipeline';
import { isPlatformEnabled } from './social/platforms';
import { sendEmail, isEmailConfigured } from './email-provider';
import { loadSiteSender } from './email-sender-load';
import { materializeDueEvents, type CalendarCategory } from './ai-calendar';
import { runWithAiContext, newRunId } from './ai-usage/context';
import { getSiteAnalytics, analyticsBrief, biggestLeak } from './analytics/store';
import { getCompanyPnl } from './revenue/ledger';
import {
  capabilitiesBrief, normalizePlannedTasks, articlePublishInstruction, followUpTasks,
  type AutopilotCaps, type PlannedTask,
} from './autopilot-actions';
import {
  DEFAULT_TIMEZONE, atLocal, clampToWorkWindow, formatLocalWhen, isValidTimeZone, planTaskTimes,
  safeTimeZone, slotOf, timeForChosenDate, timeForSlot, zonedParts, type TimeSlot as ScheduleTimeSlot,
  compareTasksByTime, resequenceTimes,
} from './autopilot-schedule';

// Mappe une catégorie du calendrier interne vers un type de tâche autopilot.
const CALENDAR_CAT_TO_TASK: Record<CalendarCategory, { type: string; agent: AgentName }> = {
  marketing: { type: 'create_post', agent: 'marketing' },
  task: { type: 'adjust_strategy', agent: 'strategist' },
  reminder: { type: 'send_email', agent: 'marketing' },
  update: { type: 'edit_website', agent: 'content' },
  deadline: { type: 'adjust_strategy', agent: 'strategist' },
  client_meeting: { type: 'schedule_appointment', agent: 'strategist' },
};

// Fabrique une tâche autopilot À PARTIR d'un événement du calendrier interne
// (utilisée par materializeDueEvents quand la date d'un événement est arrivée).
async function createTaskFromCalendar(
  companyId: string,
  when: Date,
  title: string,
  description: string,
  category: CalendarCategory,
): Promise<string> {
  const map = CALENDAR_CAT_TO_TASK[category] || CALENDAR_CAT_TO_TASK.task;
  const today = new Date().toISOString().split('T')[0];
  const plan = await db.select().from(schema.autopilotPlans)
    .where(and(eq(schema.autopilotPlans.companyId, companyId), eq(schema.autopilotPlans.date, today))).get();
  return createTask(companyId, plan?.id || null, {
    type: map.type,
    title,
    description,
    agent: map.agent,
    priority: category === 'deadline' || category === 'client_meeting' ? 2 : 5,
    scheduledFor: when,
    hasExactTime: when.getHours() !== 0 || when.getMinutes() !== 0,
    input: { fromCalendar: true, category },
  });
}

// ─── Mesure du monde réel ───────────────────────────────────────────────────

/**
 * Bloc de contexte factuel injecté dans les prompts des agents décisionnaires.
 *
 * [2026-09-17] Avant ça, les agents ne voyaient QUE l'engagement social
 * (likes, replies) — jamais si quelqu'un visite réellement le site publié, ni
 * où le tunnel fuit, ni si la société gagne de l'argent. Le Strategist devait
 * remplir un champ `revenueAnalysis.blocker` (traffic/conversion/product) en
 * n'ayant strictement aucune donnée de trafic ni de P&L : il inventait donc sa
 * réponse à chaque plan du matin. Ce brief est mesuré, jamais estimé.
 *
 * Tolérant aux pannes : une lecture qui échoue ne doit jamais empêcher un plan
 * d'être créé, donc chaque source est isolée et dégrade en texte explicite.
 */
export async function realWorldBrief(companyId: string): Promise<string> {
  const [site, pnl] = await Promise.all([
    getSiteAnalytics(companyId, 30).catch(() => null),
    getCompanyPnl(companyId, 30).catch(() => null),
  ]);
  const leak = site ? biggestLeak(site) : null;

  return `
SITE RÉEL (30 derniers jours, mesuré, pas estimé) :
${site ? analyticsBrief(site) : 'Analytics du site indisponibles (erreur de lecture) — ne pas conclure sur le trafic.'}
${leak ? `FUITE PRINCIPALE DU TUNNEL : ${leak.step} — ${leak.advice}` : site ? 'Tunnel sans fuite évidente sur la période.' : ''}
${pnl ? `P&L 30 j : ${pnl.revenue.toFixed(2)} € encaissés, coûts fournisseurs ${pnl.supplierCost.toFixed(2)} €, coût IA ${pnl.aiCostUsd.toFixed(2)} $, pub ${pnl.adsSpent.toFixed(2)} € → profit ${pnl.profit.toFixed(2)} € (marge ${(pnl.margin * 100).toFixed(1)} %). MRR ${pnl.mrr.toFixed(2)} €.` : 'P&L indisponible.'}

Règle de priorité : le trafic et le tunnel du site passent AVANT l'engagement social. Si le site ne reçoit personne, la seule recommandation valable est l'acquisition.`;
}

// ─── Types ──────────────────────────────────────────────────────────────────

type AgentName = 'strategist' | 'content' | 'marketing' | 'analytics';

interface AgentContext {
  company: typeof schema.companies.$inferSelect;
  config: typeof schema.autopilotConfig.$inferSelect;
  plan: typeof schema.autopilotPlans.$inferSelect | null;
  userId: string;
}

interface TaskAction {
  type: string;
  title: string;
  description: string;
  agent: AgentName;
  priority?: number;
  scheduledFor?: Date;
  input?: any;
  dependsOn?: string;
  timeSlot?: TimeSlot;
  hasExactTime?: boolean;
}

// ─── Time slots (matin / midi / soir) ───────────────────────────────────────
// Toute la logique d'horaires vit dans autopilot-schedule.ts (module pur, testé).
// Les créneaux sont calculés dans le FUSEAU DE L'UTILISATEUR (le serveur tourne
// en UTC : avant, une tâche de 18 h à Paris tombait dans « midi »).
export type TimeSlot = ScheduleTimeSlot;

// Fuseau de l'utilisateur, mémorisé dans autopilot_config.agent_config (JSON)
// à partir de ce qu'envoie le navigateur (activation, panneau des tâches).
function configTimeZone(config: { agentConfig?: string | null } | null | undefined): string {
  if (!config?.agentConfig) return DEFAULT_TIMEZONE;
  try { return safeTimeZone(JSON.parse(config.agentConfig)?.timezone); } catch { return DEFAULT_TIMEZONE; }
}

async function companyTimeZone(companyId: string): Promise<string> {
  const config = await db.select().from(schema.autopilotConfig)
    .where(eq(schema.autopilotConfig.companyId, companyId)).get().catch(() => null);
  return configTimeZone(config);
}

/** Enregistre le fuseau du navigateur (seulement s'il change). */
export async function rememberAutopilotTimezone(companyId: string, tz: unknown): Promise<void> {
  if (!isValidTimeZone(tz)) return;
  const config = await db.select().from(schema.autopilotConfig)
    .where(eq(schema.autopilotConfig.companyId, companyId)).get().catch(() => null);
  if (!config) return;
  let cfg: any = {};
  try { cfg = config.agentConfig ? JSON.parse(config.agentConfig) || {} : {}; } catch { cfg = {}; }
  if (cfg.timezone === tz) return;
  cfg.timezone = tz;
  await db.update(schema.autopilotConfig).set({ agentConfig: JSON.stringify(cfg) })
    .where(eq(schema.autopilotConfig.companyId, companyId));
}

// Dates des tâches déjà prévues (pour espacer les nouvelles au lieu de les empiler).
async function takenTimes(companyId: string): Promise<Date[]> {
  const rows = await db.select({ s: schema.autopilotTasks.scheduledFor }).from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      or(eq(schema.autopilotTasks.status, 'pending'), eq(schema.autopilotTasks.status, 'waiting_approval')),
    ));
  return rows.map(r => r.s).filter((d): d is Date => d instanceof Date && !isNaN(d.getTime()));
}

// Contexte horaire donné à l'IA : sans lui elle planifiait « 8 h » à 18 h.
function timeContextForAI(now: Date, tz: string): string {
  const p = zonedParts(now, tz);
  const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const current = slotOf(now, tz);
  const all: TimeSlot[] = ['morning', 'noon', 'evening'];
  const remaining = p.hour < 6 ? all : all.filter(s =>
    (s === 'morning' && current === 'morning') || (s === 'noon' && current !== 'evening') || s === 'evening');
  return `CURRENT TIME: it is ${hm} (${tz}) for the user. Slots are in the user's local time: morning 06-12, noon 12-18, evening 18-24.
- "hour" must be a LOCAL hour (${tz}) LATER than ${hm}; never plan anything in the past.
- Only these slots are still ahead today: ${remaining.join(', ')}. Put tasks there (or leave "hour" out and the system will place them).
- Write every title and description in the language of the company description (French by default), never mix languages.`;
}

// Planifie les tâches renvoyées par l'IA : jamais dans le passé, espacées,
// dans la plage de travail, créneau déduit de la date finale.
async function scheduleGeneratedTasks(ctx: AgentContext, tasks: any[]) {
  const tz = configTimeZone(ctx.config);
  const taken = await takenTimes(ctx.company.id);
  return planTaskTimes(
    tasks.map(t => ({ slot: t?.slot, hour: typeof t?.hour === 'number' ? t.hour : null })),
    { now: new Date(), tz, workStartHour: ctx.config.workStartHour, workEndHour: ctx.config.workEndHour, taken },
  );
}

// Ce que le mode auto peut RÉELLEMENT faire pour cette entreprise (site
// éditable, réseaux connectés, e-mail au propriétaire) : le planificateur ne
// propose que des tâches qui produisent un vrai résultat.
async function autopilotCaps(ctx: AgentContext): Promise<AutopilotCaps> {
  const [pages, conns, owner] = await Promise.all([
    db.select({ pageType: schema.websitePages.pageType }).from(schema.websitePages)
      .where(eq(schema.websitePages.companyId, ctx.company.id)).limit(60).all().catch(() => [] as any[]),
    db.select().from(schema.socialConnections)
      .where(eq(schema.socialConnections.companyId, ctx.company.id)).all().catch(() => [] as any[]),
    db.select({ email: schema.users.email }).from(schema.users)
      .where(eq(schema.users.id, ctx.company.userId)).get().catch(() => null),
  ]);
  return {
    hasSite: !!_chat && pages.some((r: any) => r?.pageType === 'app-spa'),
    connectedPlatforms: [...new Set(conns.filter((c: any) => c.isActive && isPlatformEnabled(c.platform)).map((c: any) => String(c.platform)))],
    canEmailOwner: isEmailConfigured() && !!owner?.email,
  };
}

/** Crée en base un lot de tâches déjà normalisées (horaires calculés, jamais dans le passé). */
async function createPlannedTasks(ctx: AgentContext, planId: string | null, tasks: PlannedTask[]): Promise<string[]> {
  const times = await scheduleGeneratedTasks(ctx, tasks);
  const ids: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    ids.push(await createTask(ctx.company.id, planId, {
      type: String(task.type || 'edit_website'),
      title: String(task.title || 'Tâche'),
      description: String(task.description || ''),
      agent: (task.agent as AgentName) || 'content',
      priority: typeof task.priority === 'number' ? task.priority : 5,
      scheduledFor: times[i].scheduledFor,
      timeSlot: times[i].timeSlot,
      hasExactTime: times[i].hasExactTime,
      input: task,
    }));
  }
  return ids;
}

// ─── Import callAI from main (we'll use a shared reference) ──────────────

// These get set by initAutopilot() from index.ts
let _callAI: (model: string, systemPrompt: string, userMessage: string, maxTokens?: number) => Promise<string>;
let _deductTokens: (userId: string, action: string, customCost?: number) => Promise<{ ok: boolean; balance: number; error?: string }>;
let _pickModel: (task?: string) => string;

/**
 * Pont vers le CHAT du projet (fourni par index.ts) : quand une tâche arrive à
 * son heure, son prompt précis est posté dans le chat et l'IA y travaille
 * vraiment (édition réelle du site pour edit_website / improve_app).
 */
export interface AutopilotChatBridge {
  /** Un travail (édition, build, réponse) tourne déjà dans ce chat. */
  isChatBusy(sessionId: string): boolean;
  /** Édition RÉELLE du site via le même pipeline que le chat. Persiste elle-même la réponse. */
  runSiteEdit(companyId: string, prompt: string): Promise<{ status: 'done' | 'no_site' | 'error'; summary?: string; error?: string }>;
  /** Run « en cours » visible dans le chat (animation + étapes). */
  beginRun(sessionId: string): { step(label: string): void; end(): void };
}

// [2026-10-01] Les dépendances vivent sur globalThis : index.ts n'appelle
// initAutopilot() qu'une fois par process (garde anti-hot-reload), donc un
// module autopilot rechargé gardait _callAI === undefined et chaque tick
// plantait en silence (« quand l'heure arrive, ça ne marche pas »).
const G = globalThis as any;
let _chat: AutopilotChatBridge | null = null;
{
  const saved = G.__velbaz_autopilot_deps;
  if (saved) {
    _callAI = saved.callAI; _deductTokens = saved.deductTokens; _pickModel = saved.pickModel;
    _chat = saved.chat || null;
  }
}

export function initAutopilot(deps: {
  callAI: typeof _callAI;
  deductTokens: typeof _deductTokens;
  pickModel: typeof _pickModel;
  chat?: AutopilotChatBridge;
}) {
  G.__velbaz_autopilot_deps = deps;
  _callAI = deps.callAI;
  _deductTokens = deps.deductTokens;
  _pickModel = deps.pickModel;
  _chat = deps.chat || null;
  console.log('[Autopilot] Engine initialized');
}

// ─── Chat du projet (sessionId = companyId) ─────────────────────────────────

async function postChat(companyId: string, role: 'user' | 'assistant', content: string): Promise<void> {
  await dbRetry(() => db.insert(schema.chatMessages).values({
    id: uuidv4(), sessionId: companyId, role, content, model: 'autopilot', createdAt: new Date(),
  })).catch((e: any) => console.error('[Autopilot] chat post failed:', e?.message));
}

const EDIT_TYPES = new Set(['edit_website', 'improve_app']);

/** Prompt PRÉCIS de la tâche, tel qu'il est envoyé à l'IA (et affiché dans le chat). */
export function taskInstruction(task: { title: string; description?: string | null }): string {
  const title = String(task.title || '').trim();
  const desc = String(task.description || '').trim();
  return desc && desc.toLowerCase() !== title.toLowerCase() ? `${title}\n\n${desc}` : title;
}

function taskChatPrompt(task: typeof schema.autopilotTasks.$inferSelect, tz: string): string {
  const when = task.scheduledFor ? formatLocalWhen(new Date(task.scheduledFor), new Date(), tz) : 'maintenant';
  return `🤖 **Mode auto — tâche de ${when}**\n\n${taskInstruction(task)}`;
}

function bullets(items: unknown, max = 5): string {
  if (!Array.isArray(items)) return '';
  return items.filter(x => typeof x === 'string' && x.trim()).slice(0, max).map(x => `- ${x}`).join('\n');
}

/** Réponse lisible postée dans le chat une fois la tâche faite (jamais du JSON brut). */
export function taskResultMessage(task: { type: string; title: string; status: string; error?: string | null }, output: any): string {
  const o = output && typeof output === 'object' ? output : {};
  if (task.status === 'failed') {
    return `⚠️ **Tâche non aboutie :** ${task.title}\n\n${String(task.error || o.error || 'erreur inconnue').slice(0, 400)}`;
  }
  if (o.skipped) return `⏭️ **Tâche ignorée :** ${task.title}\n\n${String(o.reason || 'rien à faire pour le moment')}`;
  const parts: string[] = [];
  switch (task.type) {
    case 'create_post':
      if (o.drafted) {
        parts.push(`📝 **Post ${o.platform || ''} rédigé** — enregistré en brouillon prêt à publier.`.replace('  ', ' '));
        if (o.content) parts.push(`> ${String(o.content).slice(0, 700).replace(/\n/g, '\n> ')}${Array.isArray(o.hashtags) && o.hashtags.length ? `\n>\n> ${o.hashtags.map((h: string) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}` : ''}`);
        if (o.reason) parts.push(String(o.reason));
      } else {
        parts.push(o.posted ? `✅ **Post publié sur ${o.platform}.**${o.url ? ` ${o.url}` : ''}` : `✅ ${task.title}`);
      }
      break;
    case 'send_email':
      if (o.sent) parts.push(`📧 **Email envoyé** à ${o.to} — « ${o.subject || ''} »`);
      else parts.push(`📝 **Brouillon d'email prêt** (non envoyé)${o.to ? ` pour ${o.to}` : ''} — « ${o.subject || ''} ».${o.reason ? `\n\n${o.reason}` : ''}`);
      break;
    case 'create_article':
      parts.push(o.onSite
        ? `📰 **Article publié sur ton site :** « ${o.title || task.title} »${o.words ? ` (${o.words} mots)` : ''} — visible dans la page Blog de l'aperçu, et gardé dans tes documents.`
        : `📝 **Article rédigé :** « ${o.title || task.title} »${o.words ? ` (${o.words} mots)` : ''} — enregistré dans tes documents.`);
      if (o.siteNote) parts.push(String(o.siteNote));
      break;
    case 'schedule_appointment':
      parts.push(`📅 **Rendez-vous noté :** ${task.title}`);
      break;
    case 'analyze_metrics':
      parts.push(`📊 **Analyse terminée.** ${o.summary || ''}`.trim());
      if (bullets(o.recommendations)) parts.push(`**Recommandations :**\n${bullets(o.recommendations)}`);
      if (bullets(o.followUps)) parts.push(`**J'ai ajouté ces actions à ton planning :**\n${bullets(o.followUps)}`);
      break;
    case 'adjust_strategy':
      parts.push(`🧭 **Stratégie revue.** ${o.assessment || ''}`.trim());
      if (bullets(o.adjustments)) parts.push(`**Ajustements :**\n${bullets(o.adjustments)}`);
      if (bullets(o.followUps)) parts.push(`**J'ai ajouté ces actions à ton planning :**\n${bullets(o.followUps)}`);
      break;
    case 'edit_website':
    case 'improve_app':
      parts.push(`💡 **Proposition prête** (le site n'a pas été modifié) : ${o.change || (Array.isArray(o.changes) ? o.changes.join(' ; ') : '') || task.title}`);
      if (o.reason) parts.push(String(o.reason));
      break;
    default:
      parts.push(`✅ **Fait :** ${task.title}`);
  }
  return parts.join('\n\n');
}

// ─── Agent System Prompts ──────────────────────────────────────────────────

const AGENT_PROMPTS: Record<AgentName, string> = {
  strategist: `You are the STRATEGIST agent of Velbaz Autopilot. You are the CEO brain of this AI team.

Your job:
- Every morning, analyze the company's current state and create a daily plan
- Decide WHAT to do, WHEN, and WHY
- Diagnose revenue problems: Is it traffic? Conversion? Product-market fit? Pricing?
- Prioritize ruthlessly — focus on what moves the needle
- Coordinate the other agents (Content, Marketing, Analytics)

You think in terms of business outcomes:
- Revenue growth, customer acquisition, brand awareness
- You understand funnels: Awareness → Interest → Desire → Action
- You track what worked and what didn't

IMPORTANT RULES:
- Be specific. Not "create content" but "create a Twitter thread about [specific topic] because [reason]"
- Include timing: when should each task happen
- Consider dependencies: content must be created before it can be posted
- If things are going well, don't change strategy — double down
- If things aren't working, diagnose WHY and pivot

Output format: Always respond in valid JSON.`,

  content: `You are the CONTENT agent of Velbaz Autopilot. You are the creative brain.

Your job:
- Create compelling posts, articles, captions, and content ideas
- Match the brand voice and style
- Write for specific platforms (Twitter is short/punchy, LinkedIn is professional, Instagram is visual)
- Generate image descriptions when visual content is needed
- Create content that drives engagement and conversions

IMPORTANT RULES:
- Every piece of content must have a clear purpose (awareness, engagement, conversion)
- Use hooks that grab attention in the first line
- Include calls to action when appropriate
- Adapt tone to the platform
- Reference current trends when relevant

Output format: Always respond in valid JSON.`,

  marketing: `You are the MARKETING agent of Velbaz Autopilot. You are the distribution brain.

Your job:
- Decide the best time and platform to post content
- Execute posting across connected social platforms
- Monitor engagement and respond to comments
- Optimize posting schedule based on what gets the most engagement
- Grow the audience strategically

IMPORTANT RULES:
- Don't spam — quality over quantity
- Best times vary by platform (research and adapt)
- Engage authentically with comments — don't be robotic
- Track what content types perform best on each platform
- If a post is doing well, amplify it

Output format: Always respond in valid JSON.`,

  analytics: `You are the ANALYTICS agent of Velbaz Autopilot. You are the data brain.

Your job:
- Track key metrics: followers, engagement rate, website traffic, conversion
- Detect anomalies: sudden drops or spikes
- Identify trends: what content types work best, best posting times
- Report insights to the Strategist for decision-making
- Monitor competitor activity when possible

IMPORTANT RULES:
- Focus on actionable insights, not vanity metrics
- "Likes went up 20%" is useless. "Twitter threads get 3x more engagement than single tweets" is actionable
- Flag critical issues immediately (account suspended, massive traffic drop, etc.)
- Track week-over-week and month-over-month trends
- Correlate actions with outcomes

Output format: Always respond in valid JSON.`,
};

// ─── Logging ────────────────────────────────────────────────────────────────

async function logAction(
  companyId: string,
  agent: AgentName | 'system',
  action: string,
  message: string,
  details?: any,
  taskId?: string,
  tokensUsed?: number,
  level: 'info' | 'warning' | 'error' | 'success' = 'info'
) {
  await db.insert(schema.autopilotLogs).values({
    id: uuidv4(),
    companyId,
    taskId: taskId || null,
    agent,
    action,
    message,
    details: details ? JSON.stringify(details) : null,
    tokensUsed: tokensUsed || 0,
    level,
  });
}

async function createInsight(
  companyId: string,
  category: string,
  title: string,
  description: string,
  severity: 'critical' | 'warning' | 'info' | 'positive' = 'info',
  recommendation?: string
) {
  await db.insert(schema.autopilotInsights).values({
    id: uuidv4(),
    companyId,
    category,
    title,
    description,
    severity,
    recommendation: recommendation || null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  });
}

// ─── Task Management ────────────────────────────────────────────────────────

async function createTask(companyId: string, planId: string | null, task: TaskAction): Promise<string> {
  const id = uuidv4();
  
  // Check if approval mode is on
  const config = await db.select().from(schema.autopilotConfig)
    .where(eq(schema.autopilotConfig.companyId, companyId)).get();
  
  const requiresApproval = config?.approvalMode && 
    ['edit_website', 'create_post', 'engage_comment', 'adjust_strategy'].includes(task.type);

  // Créneau = TOUJOURS celui de la date finale (fuseau de l'utilisateur).
  // Avant, le créneau venait de l'IA (« morning ») même quand la tâche était
  // datée de 18 h → la carte s'affichait dans le mauvais créneau.
  const tz = configTimeZone(config);
  const timeSlot: TimeSlot = task.scheduledFor
    ? slotOf(task.scheduledFor, tz)
    : (task.timeSlot || slotOf(new Date(), tz));

  // slotOrder = end of the target slot (new tasks go to the bottom of their slot)
  const slotRows = await db.select({ so: schema.autopilotTasks.slotOrder })
    .from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.timeSlot, timeSlot),
    ));
  const nextOrder = slotRows.reduce((m, r) => Math.max(m, (r.so ?? 0) + 1), 0);

  await db.insert(schema.autopilotTasks).values({
    id,
    companyId,
    planId,
    agent: task.agent,
    type: task.type,
    title: task.title,
    description: task.description,
    input: task.input ? JSON.stringify(task.input) : null,
    priority: task.priority || 5,
    scheduledFor: task.scheduledFor || null,
    timeSlot,
    slotOrder: nextOrder,
    hasExactTime: task.hasExactTime || false,
    requiresApproval: requiresApproval || false,
    status: requiresApproval ? 'waiting_approval' : 'pending',
    dependsOn: task.dependsOn || null,
  });

  if (requiresApproval) {
    await logAction(companyId, task.agent, 'task_needs_approval', 
      `Task "${task.title}" needs your approval`, { taskId: id, type: task.type });
  }

  return id;
}

async function getNextTask(companyId: string): Promise<typeof schema.autopilotTasks.$inferSelect | null> {
  const now = new Date();
  
  // La tâche DUE la plus ancienne d'abord (l'heure prévue fait foi), puis la
  // priorité. Avant : tri par priorité seule → les tâches partaient dans le
  // désordre, et une seule dépendance non terminée bloquait toute la file.
  const due = await db.select().from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.status, 'pending'),
      or(
        isNull(schema.autopilotTasks.scheduledFor),
        lte(schema.autopilotTasks.scheduledFor, now)
      ),
    ))
    .orderBy(asc(schema.autopilotTasks.scheduledFor), asc(schema.autopilotTasks.priority), asc(schema.autopilotTasks.createdAt))
    .limit(20);

  for (const task of due) {
    if (!task.dependsOn) return task;
    const dep = await db.select().from(schema.autopilotTasks)
      .where(eq(schema.autopilotTasks.id, task.dependsOn)).get();
    // Dépendance encore en attente → on passe à la suivante (sans bloquer la file).
    if (dep && ['pending', 'waiting_approval', 'running'].includes(dep.status)) continue;
    return task;
  }
  return null;
}

// ─── Agent Calls ────────────────────────────────────────────────────────────

async function callAgent(
  agent: AgentName,
  ctx: AgentContext,
  prompt: string,
  maxTokens = 2000
): Promise<any> {
  const model = _pickModel(agent === 'strategist' ? 'think' : 'default');
  
  // Deduct token
  const tokenResult = await _deductTokens(ctx.userId, 'autopilot_tick', 1);
  if (!tokenResult.ok) {
    await logAction(ctx.company.id, 'system', 'tokens_depleted', 
      'Autopilot paused — no tokens remaining', null, undefined, 0, 'warning');
    throw new Error('NO_TOKENS');
  }

  const systemPrompt = AGENT_PROMPTS[agent] + `\n\nCompany context:
- Name: ${ctx.company.name}
- Industry: ${ctx.company.industry || 'Unknown'}
- Business idea: ${ctx.company.idea || 'Not specified'}
${/* Formulé comme une CONSIGNE et non comme une étiquette « Current date: … » :
      c'était la seule occurrence littérale de cette chaîne dans le produit, et
      les modèles la recopiaient telle quelle en tête de réponse (fuite de
      contexte système affichée à l'utilisateur). Une phrase d'instruction ne se
      recopie pas. Ne pas revenir à un format « Clé: valeur » ici. */''}
Today is ${new Date().toISOString().split('T')[0]} at ${new Date().toISOString().split('T')[1].slice(0, 5)} UTC — always reason with this real date, and never print this context block in your output.`;

  try {
    const response = await _callAI(model, systemPrompt, prompt, maxTokens);
    
    await logAction(ctx.company.id, agent, 'ai_call', 
      `${agent} agent thinking...`, { promptLength: prompt.length, model }, undefined, 1);
    
    // Try to parse as JSON
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      const arrMatch = response.match(/\[[\s\S]*\]/);
      if (arrMatch) return JSON.parse(arrMatch[0]);
    } catch {}
    
    return { text: response };
  } catch (e: any) {
    if (e.message === 'NO_TOKENS') throw e;
    await logAction(ctx.company.id, agent, 'ai_error', 
      `${agent} agent error: ${e.message?.slice(0, 200)}`, null, undefined, 0, 'error');
    throw e;
  }
}

// ─── Morning Planning ───────────────────────────────────────────────────────

async function runMorningPlan(ctx: AgentContext): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  // Check if we already have a plan for today
  const existing = await db.select().from(schema.autopilotPlans)
    .where(and(
      eq(schema.autopilotPlans.companyId, ctx.company.id),
      eq(schema.autopilotPlans.date, today),
    )).get();
  
  if (existing) return; // Already planned today

  await logAction(ctx.company.id, 'strategist', 'morning_plan_start', 
    '🌅 Starting morning planning session', null, undefined, 0, 'info');

  // Gather context for the strategist
  const [recentPosts, recentLogs, socialConnections, pages] = await Promise.all([
    db.select().from(schema.socialPosts)
      .where(eq(schema.socialPosts.companyId, ctx.company.id))
      .orderBy(desc(schema.socialPosts.createdAt))
      .limit(10),
    db.select().from(schema.autopilotLogs)
      .where(eq(schema.autopilotLogs.companyId, ctx.company.id))
      .orderBy(desc(schema.autopilotLogs.createdAt))
      .limit(20),
    db.select().from(schema.socialConnections)
      .where(eq(schema.socialConnections.companyId, ctx.company.id)),
    db.select({ slug: schema.websitePages.slug, title: schema.websitePages.title })
      .from(schema.websitePages)
      .where(eq(schema.websitePages.companyId, ctx.company.id)),
  ]);

  // Check yesterday's plan performance
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const yesterdayPlan = await db.select().from(schema.autopilotPlans)
    .where(and(
      eq(schema.autopilotPlans.companyId, ctx.company.id),
      eq(schema.autopilotPlans.date, yesterday),
    )).get();

  const connectedPlatforms = socialConnections
    .filter(c => c.isActive && isPlatformEnabled(c.platform))
    .map(c => c.platform);

  const realWorld = await realWorldBrief(ctx.company.id);
  const caps = await autopilotCaps(ctx);

  const tzPlan = configTimeZone(ctx.config);
  const prompt = `Time to plan the REST OF TODAY for ${ctx.company.name} (the plan may start at any time of day — the autopilot was just switched on or a new day began).
${timeContextForAI(new Date(), tzPlan)}
${realWorld}

COMPANY STATUS:
- Business: ${ctx.company.idea || 'No description'}
- Industry: ${ctx.company.industry || 'Unknown'}
- Connected social platforms: ${connectedPlatforms.length > 0 ? connectedPlatforms.join(', ') : 'NONE — recommend connecting platforms first'}
- Website pages: ${pages.length > 0 ? pages.map(p => p.title || p.slug).join(', ') : 'No website yet'}

RECENT POSTS (last 10):
${recentPosts.length > 0 ? recentPosts.map(p => 
  `- [${p.platform}] ${p.content?.slice(0, 100)} (status: ${p.status}, engagement: ${p.engagements || 0} engagements, ${p.replies || 0} replies, ${p.impressions || 0} impressions)`
).join('\n') : 'No posts yet — this is a fresh start!'}

${yesterdayPlan ? `YESTERDAY'S PLAN:
- Goals: ${yesterdayPlan.goals}
- Completed: ${yesterdayPlan.completedTasks}/${yesterdayPlan.totalTasks} tasks
- Status: ${yesterdayPlan.status}` : 'No previous plan — this is day 1!'}

RECENT ACTIVITY:
${recentLogs.slice(0, 10).map(l => `- [${l.agent}] ${l.message}`).join('\n') || 'No previous activity'}

Create today's plan. Respond with JSON:
{
  "summary": "Brief human-readable summary of today's plan",
  "goals": ["goal1", "goal2", "goal3"],
  "revenueAnalysis": {
    "currentState": "assessment of where the business stands",
    "blocker": "main thing preventing revenue (traffic/conversion/product/none)",
    "recommendation": "what to fix"
  },
  "tasks": [
    {
      "type": "create_post|edit_website|analyze_metrics|engage_comment|create_article|adjust_strategy|send_email|schedule_appointment|improve_app",
      "agent": "content|marketing|analytics|strategist",
      "title": "specific task title",
      "description": "what exactly to do and why",
      "priority": 1-10,
      "slot": "morning|noon|evening (only a slot that is still ahead today)",
      "hour": 0-23 (optional — exact LOCAL hour, later than the current time)
    }
  ],
  "waitUntil": "optional — if we should skip some hours and wait for data"
}

IMPORTANT: Spread tasks over the part of the day that is still ahead (3 to 6 tasks). Never schedule a task in the past.

${capabilitiesBrief(caps)}`;

  try {
    const plan = await callAgent('strategist', ctx, prompt, 3000);
    
    // Save the plan
    const planId = uuidv4();
    // Chaque tâche doit produire un vrai livrable (cf. autopilot-actions.ts).
    const tasks = normalizePlannedTasks(plan.tasks, caps);
    
    await db.insert(schema.autopilotPlans).values({
      id: planId,
      companyId: ctx.company.id,
      date: today,
      summary: plan.summary || 'Daily plan created',
      goals: JSON.stringify(plan.goals || []),
      strategy: JSON.stringify({ waitUntil: plan.waitUntil }),
      revenueAnalysis: plan.revenueAnalysis ? JSON.stringify(plan.revenueAnalysis) : null,
      totalTasks: tasks.length,
    });

    // Create tasks from the plan — horaires calculés (jamais dans le passé).
    await createPlannedTasks(ctx, planId, tasks);

    // Create revenue insight if analysis found a blocker
    if (plan.revenueAnalysis?.blocker && plan.revenueAnalysis.blocker !== 'none') {
      await createInsight(
        ctx.company.id,
        'revenue',
        `Revenue blocker: ${plan.revenueAnalysis.blocker}`,
        plan.revenueAnalysis.currentState || 'Analysis in progress',
        'warning',
        plan.revenueAnalysis.recommendation
      );
    }

    // Update config
    await db.update(schema.autopilotConfig).set({
      lastMorningPlanAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.autopilotConfig.companyId, ctx.company.id));

    await logAction(ctx.company.id, 'strategist', 'morning_plan_complete',
      `📋 Daily plan ready: ${plan.summary || 'Plan created'}. ${tasks.length} tasks scheduled.`,
      { planId, goals: plan.goals, taskCount: tasks.length }, undefined, 0, 'success');

  } catch (e: any) {
    if (e.message === 'NO_TOKENS') return;
    await logAction(ctx.company.id, 'strategist', 'morning_plan_failed',
      `Morning planning failed: ${e.message?.slice(0, 200)}`, null, undefined, 0, 'error');
  }
}

// ─── Reflect & generate new tasks (when all slots empty / all done) ─────────
async function reflectAndGenerate(ctx: AgentContext): Promise<number> {
  // Count active (visible) tasks — if there are still some, no need to reflect
  const active = await db.select({ c: count() }).from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, ctx.company.id),
      or(
        eq(schema.autopilotTasks.status, 'pending'),
        eq(schema.autopilotTasks.status, 'waiting_approval'),
        eq(schema.autopilotTasks.status, 'running'),
      ),
    )).get();
  if ((active?.c || 0) > 0) return 0;

  await logAction(ctx.company.id, 'strategist', 'reflect_start',
    '🤔 Réflexion : toutes les tâches sont terminées, génération de nouvelles tâches…', null, undefined, 0, 'info');

  const recentLogs = await db.select().from(schema.autopilotLogs)
    .where(eq(schema.autopilotLogs.companyId, ctx.company.id))
    .orderBy(desc(schema.autopilotLogs.createdAt)).limit(15);

  const realWorld = await realWorldBrief(ctx.company.id);
  const caps = await autopilotCaps(ctx);

  const prompt = `All current tasks for ${ctx.company.name} are done. Reflect on what to do next and create a fresh batch of tasks.
${realWorld}

Company: ${ctx.company.idea || ctx.company.name}
Industry: ${ctx.company.industry || 'Unknown'}

RECENT ACTIVITY:
${recentLogs.map(l => `- [${l.agent}] ${l.message}`).join('\n') || 'No previous activity'}

${timeContextForAI(new Date(), configTimeZone(ctx.config))}

Create 3 to 6 new tasks spread over the part of the day that is still ahead.

${capabilitiesBrief(caps)}

Respond with JSON:
{
  "tasks": [
    {
      "type": "create_post|edit_website|analyze_metrics|engage_comment|create_article|adjust_strategy|send_email|schedule_appointment|improve_app",
      "agent": "content|marketing|analytics|strategist",
      "title": "specific task title",
      "description": "what exactly to do and why",
      "priority": 1-10,
      "slot": "morning|noon|evening (only a slot still ahead today)",
      "hour": 0-23 (optional exact LOCAL hour, later than the current time)
    }
  ]
}`;

  try {
    const result = await callAgent('strategist', ctx, prompt, 3000);
    const tasks = normalizePlannedTasks(result.tasks, caps);
    const today = new Date().toISOString().split('T')[0];
    const plan = await db.select().from(schema.autopilotPlans)
      .where(and(eq(schema.autopilotPlans.companyId, ctx.company.id), eq(schema.autopilotPlans.date, today))).get();

    await createPlannedTasks(ctx, plan?.id || null, tasks);
    await logAction(ctx.company.id, 'strategist', 'reflect_complete',
      `✨ ${tasks.length} nouvelles tâches générées.`, { count: tasks.length }, undefined, 0, 'success');
    return tasks.length;
  } catch (e: any) {
    if (e.message === 'NO_TOKENS') return 0;
    await logAction(ctx.company.id, 'strategist', 'reflect_failed',
      `Réflexion échouée: ${e.message?.slice(0, 200)}`, null, undefined, 0, 'error');
    return 0;
  }
}

// Public wrapper for the API "reflect now" endpoint (appelé par le panneau quand il est vide).
// [2026-10-01] Passe par le VERROU de l'entreprise : avant, le panneau lançait
// une réflexion en même temps que le plan du matin de l'activation → deux lots
// de tâches (11 tâches, doublons). Mode auto coupé → rien. Pas encore de plan
// aujourd'hui → c'est le plan du matin qui crée les tâches (une seule fois).
export async function triggerReflect(companyId: string): Promise<{ created: number; busy?: boolean }> {
  if (busyCompanies.has(companyId)) return { created: 0, busy: true };
  busyCompanies.add(companyId);
  try {
    return await runWithAiContext({ feature: "autopilot", companyId, runId: newRunId() }, async () => {
      const company = await db.select().from(schema.companies)
        .where(eq(schema.companies.id, companyId)).get();
      if (!company) return { created: 0 };
      const config = await db.select().from(schema.autopilotConfig)
        .where(eq(schema.autopilotConfig.companyId, companyId)).get();
      if (!config?.enabled) return { created: 0 };
      if (!_callAI || !_pickModel || !_deductTokens) return { created: 0 };
      const ctx: AgentContext = { company, config, plan: null, userId: company.userId };
      const today = new Date().toISOString().split('T')[0];
      const todayPlan = await db.select({ id: schema.autopilotPlans.id }).from(schema.autopilotPlans)
        .where(and(eq(schema.autopilotPlans.companyId, companyId), eq(schema.autopilotPlans.date, today))).get();
      const countActive = async () => (await db.select({ c: count() }).from(schema.autopilotTasks)
        .where(and(
          eq(schema.autopilotTasks.companyId, companyId),
          or(eq(schema.autopilotTasks.status, 'pending'), eq(schema.autopilotTasks.status, 'waiting_approval'), eq(schema.autopilotTasks.status, 'running')),
        )).get())?.c || 0;
      if (!todayPlan) {
        const before = await countActive();
        lastPlanAttempt.set(companyId, Date.now());
        await rescheduleOverdue(companyId).catch(() => 0);
        await runMorningPlan(ctx);
        return { created: Math.max(0, (await countActive()) - before) };
      }
      const lastTry = lastReflectAttempt.get(companyId) || 0;
      if (Date.now() - lastTry < 60_000) return { created: 0 };
      lastReflectAttempt.set(companyId, Date.now());
      return { created: await reflectAndGenerate(ctx) };
    });
  } finally {
    busyCompanies.delete(companyId);
  }
}

// ─── Task Executors ─────────────────────────────────────────────────────────

async function executeTask(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<void> {
  // Mark as running
  await db.update(schema.autopilotTasks).set({ 
    status: 'running', startedAt: new Date() 
  }).where(eq(schema.autopilotTasks.id, task.id));

  await logAction(ctx.company.id, task.agent as AgentName, 'task_start',
    `⚡ Running: ${task.title}`, { taskId: task.id, type: task.type }, task.id);

  try {
    let output: any;

    switch (task.type) {
      case 'create_post':
        output = await executeCreatePost(task, ctx);
        break;
      case 'edit_website':
        output = await executeEditWebsite(task, ctx);
        break;
      case 'analyze_metrics':
        output = await executeAnalyzeMetrics(task, ctx);
        break;
      case 'engage_comment':
        output = await executeEngageComment(task, ctx);
        break;
      case 'create_article':
        output = await executeCreateArticle(task, ctx);
        break;
      case 'adjust_strategy':
        output = await executeAdjustStrategy(task, ctx);
        break;
      case 'send_email':
        output = await executeSendEmail(task, ctx);
        break;
      case 'schedule_appointment':
        output = await executeScheduleAppointment(task, ctx);
        break;
      case 'improve_app':
        output = await executeImproveApp(task, ctx);
        break;
      default:
        output = { skipped: true, reason: `Unknown task type: ${task.type}` };
    }

    // [2026-09-13] Un exécuteur qui ne lève pas d'exception n'a pas forcément
    // réussi : `executeCreatePost` renvoie `posted: false` quand la plateforme
    // a refusé le post. On affichait quand même « ✅ Completed », donc l'IA
    // annonçait un envoi qui n'avait jamais eu lieu. Le résultat est désormais
    // lu avant de conclure.
    const declaredFailure =
      output && typeof output === 'object' &&
      (output.posted === false || output.published === false || Boolean(output.error));
    const declaredSkip = Boolean(output && typeof output === 'object' && output.skipped);
    const failureReason = output?.error || output?.reason || 'la plateforme n\'a pas confirmé';

    await db.update(schema.autopilotTasks).set({
      status: declaredFailure ? 'failed' : 'completed',
      output: JSON.stringify(output),
      error: declaredFailure ? String(failureReason).slice(0, 500) : null,
      completedAt: new Date(),
    }).where(eq(schema.autopilotTasks.id, task.id));

    // Update plan task count — une tâche ratée ne compte pas comme faite.
    if (task.planId && !declaredFailure) {
      await db.update(schema.autopilotPlans).set({
        completedTasks: sql`completed_tasks + 1`,
      }).where(eq(schema.autopilotPlans.id, task.planId));
    }

    if (declaredFailure) {
      await logAction(ctx.company.id, task.agent as AgentName, 'task_failed',
        `❌ Échec : ${task.title} — ${String(failureReason).slice(0, 200)}`,
        { taskId: task.id, output }, task.id, 0, 'error');
    } else if (declaredSkip) {
      await logAction(ctx.company.id, task.agent as AgentName, 'task_complete',
        `⏭️ Ignoré : ${task.title} — ${String(output.reason || 'rien à faire').slice(0, 200)}`,
        { taskId: task.id, output }, task.id, 0, 'success');
    } else {
      await logAction(ctx.company.id, task.agent as AgentName, 'task_complete',
        `✅ Completed: ${task.title}`, { taskId: task.id, output }, task.id, 0, 'success');
    }

  } catch (e: any) {
    if (e.message === 'NO_TOKENS') {
      // Retour en attente, reportée d'1 h (sinon relancée à chaque passage).
      await db.update(schema.autopilotTasks).set({ status: 'pending', scheduledFor: new Date(Date.now() + 60 * 60 * 1000) })
        .where(eq(schema.autopilotTasks.id, task.id));
      return;
    }

    await db.update(schema.autopilotTasks).set({
      status: 'failed',
      error: e.message?.slice(0, 500),
      completedAt: new Date(),
    }).where(eq(schema.autopilotTasks.id, task.id));

    await logAction(ctx.company.id, task.agent as AgentName, 'task_failed',
      `❌ Failed: ${task.title} — ${e.message?.slice(0, 200)}`, null, task.id, 0, 'error');
  }
}

// ─── Task Type Executors ────────────────────────────────────────────────────

async function executeCreatePost(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  const input = task.input ? JSON.parse(task.input) : {};
  
  // Ask Content agent to write the post
  const contentPrompt = `Create a social media post for ${ctx.company.name}.

Task: ${task.description}
${input.platform ? `Platform: ${input.platform}` : 'Choose the best platform'}
${input.topic ? `Topic: ${input.topic}` : ''}

Company: ${ctx.company.idea || ctx.company.name}
Industry: ${ctx.company.industry || 'General'}

Respond with JSON:
{
  "content": "the post text (platform-appropriate length)",
  "platform": "twitter|linkedin|instagram|facebook",
  "hashtags": ["tag1", "tag2"],
  "imagePrompt": "description for AI image generation (or null if text-only)",
  "callToAction": "what the reader should do",
  "hook": "the attention-grabbing first line"
}`;

  const postPlan = await callAgent('content', ctx, contentPrompt, 1500);
  
  // La plateforme choisie au planning (réseau connecté, cf. normalizePlannedTasks) prime.
  const platform = String(input.platform || postPlan.platform || 'instagram').toLowerCase();
  
  // [2026-10-01] Réseau indisponible (pas de clés API) ou non connecté : avant,
  // la tâche était simplement « ignorée » → aucun livrable. Le post est
  // maintenant RÉDIGÉ et enregistré en brouillon prêt à publier.
  const connection = isPlatformEnabled(platform)
    ? await db.select().from(schema.socialConnections)
      .where(and(
        eq(schema.socialConnections.companyId, ctx.company.id),
        eq(schema.socialConnections.platform, platform),
        eq(schema.socialConnections.isActive, 1),
      )).get()
    : null;

  if (!connection) {
    const content = String(postPlan.content || '').trim();
    if (!content) return { error: 'Le texte du post n\'a pas pu être rédigé.' };
    const hashtags = Array.isArray(postPlan.hashtags) ? postPlan.hashtags.filter((h: any) => typeof h === 'string').slice(0, 15) : [];
    const postId = uuidv4();
    await db.insert(schema.socialPosts).values({
      id: postId, companyId: ctx.company.id, platform, contentType: 'post', content,
      hashtags: JSON.stringify(hashtags), status: 'draft',
      strategy: JSON.stringify({ source: 'autopilot', taskId: task.id, hook: postPlan.hook || null, callToAction: postPlan.callToAction || null, imagePrompt: postPlan.imagePrompt || null }),
    });
    return {
      drafted: true, platform, postId, content, hashtags,
      reason: isPlatformEnabled(platform)
        ? `${platform} n'est pas encore connecté : connecte-le dans Réseaux sociaux pour que le mode auto publie lui-même.`
        : `${platform} n'est pas disponible (clés API manquantes) : le post est prêt à copier-coller.`,
    };
  }

  // Run through existing pipeline
  try {
    // `companyName` / `companyIdea` sont OBLIGATOIRES : le pipeline les injecte
    // dans chaque prompt IA (« un post publié par ${companyName} »). Sans eux
    // l'IA écrivait littéralement « undefined » à la place du nom de la boîte.
    const result = await runContentPipeline({
      companyId: ctx.company.id,
      companyName: ctx.company.name,
      companyIdea: ctx.company.idea || '',
      soulMd: ctx.company.soulMd || undefined,
      platform,
      customPrompt: postPlan.content || task.description,
    });
    // [2026-09-13] BUG CORRIGÉ : on renvoyait `posted: true` dès que le
    // pipeline ne levait pas d'exception. Or `runContentPipeline` attrape
    // l'échec de publication en interne et le remonte dans `published` /
    // `publishError` — l'autopilote annonçait donc « posté » alors que X
    // avait refusé (402 credits depleted, 401, 429…). On se fie maintenant
    // uniquement à la confirmation de la plateforme.
    const reallyPublished = result.published === true;
    if (!reallyPublished) {
      await createInsight(
        ctx.company.id,
        'content',
        `Post ${platform} NON publié`,
        result.publishError || `${platform} n'a pas confirmé la publication — le texte est enregistré mais rien n'est parti.`,
        'warning',
        result.publishFixUrl
          ? `Débloque le compte ici : ${result.publishFixUrl}, puis relance la publication.`
          : `Corrige la cause ci-dessus puis relance la publication.`,
      );
      return {
        posted: false,
        platform,
        postId: result.postId,
        status: result.status,
        error: result.publishError || 'Publication non confirmée par la plateforme',
        errorCode: result.publishErrorCode,
        content: result.content,
      };
    }
    return {
      posted: true,
      platform,
      postId: result.postId,
      status: result.status,
      url: result.platformPostUrl,
    };
  } catch (e: any) {
    return { posted: false, error: e.message, content: postPlan.content };
  }
}

// Édition RÉELLE du site (même pipeline que le chat). `null` = pas de site
// éditable / pas de pont → l'exécuteur retombe sur une simple proposition.
async function realSiteEdit(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any | null> {
  if (!_chat) {
    console.warn('[Autopilot] édition réelle impossible : pont chat non initialisé', ctx.company.id);
    return null;
  }
  const r = await _chat.runSiteEdit(ctx.company.id, taskInstruction(task));
  if (r.status === 'no_site') {
    console.warn('[Autopilot] édition réelle impossible : aucun site éditable', ctx.company.id);
    return null;
  }
  if (r.status === 'error') return { edited: false, chatReplied: true, error: r.error || 'édition échouée' };
  return { edited: true, chatReplied: true, summary: r.summary };
}

async function executeEditWebsite(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  const real = await realSiteEdit(task, ctx);
  if (real) return real;
  const input = task.input ? JSON.parse(task.input) : {};
  
  // Ask Strategist what to change
  const editPrompt = `You need to edit the website for ${ctx.company.name}.

Task: ${task.description}

What specific changes should be made? Respond with JSON:
{
  "page": "which page to edit (home, about, etc.)",
  "changes": ["specific change 1", "specific change 2"],
  "reasoning": "why these changes will improve the business",
  "newContent": "any new text content to add"
}`;

  const editPlan = await callAgent('strategist', ctx, editPrompt, 1500);
  
  // For now, log the recommendation. Full website editing integration comes in Step 6
  await createInsight(ctx.company.id, 'content',
    `Website improvement: ${editPlan.page || 'homepage'}`,
    editPlan.changes?.join('; ') || task.description,
    'info',
    editPlan.reasoning
  );

  return { planned: true, changes: editPlan.changes, page: editPlan.page, reason: 'Aucun site éditable pour l\'instant : la modification est notée dans tes recommandations.' };
}

async function executeAnalyzeMetrics(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  // Gather all available data
  const [posts, connections] = await Promise.all([
    db.select().from(schema.socialPosts)
      .where(eq(schema.socialPosts.companyId, ctx.company.id))
      .orderBy(desc(schema.socialPosts.createdAt))
      .limit(30),
    db.select().from(schema.socialConnections)
      .where(eq(schema.socialConnections.companyId, ctx.company.id)),
  ]);

  // La table social_posts n'a pas de colonnes `likes`/`comments` : les vraies
  // colonnes sont `engagements`, `replies`, `impressions` et `clicks`. On lisait
  // donc `undefined` partout et l'analyse IA tournait sur des zéros.
  const totalEngagements = posts.reduce((sum, p) => sum + (p.engagements || 0), 0);
  const totalReplies = posts.reduce((sum, p) => sum + (p.replies || 0), 0);
  const totalImpressions = posts.reduce((sum, p) => sum + (p.impressions || 0), 0);
  const publishedPosts = posts.filter(p => p.status === 'published');
  const avgEngagement = publishedPosts.length > 0
    ? (totalEngagements + totalReplies) / publishedPosts.length
    : 0;

  const realWorld = await realWorldBrief(ctx.company.id);
  const caps = await autopilotCaps(ctx);

  const analyticsPrompt = `Analyze the performance data for ${ctx.company.name}.
${realWorld}

DATA:
- Total posts: ${posts.length} (${publishedPosts.length} published)
- Total engagements: ${totalEngagements}
- Total replies: ${totalReplies}
- Total impressions: ${totalImpressions}
- Average engagement per post: ${avgEngagement.toFixed(1)}
- Connected platforms: ${connections.filter(c => isPlatformEnabled(c.platform)).map(c => `${c.platform} (${c.isActive ? 'active' : 'inactive'})`).join(', ') || 'none'}

RECENT POSTS:
${publishedPosts.slice(0, 10).map(p => 
  `- [${p.platform}] "${p.content?.slice(0, 80)}" — ${p.engagements || 0} engagements, ${p.replies || 0} replies`
).join('\n') || 'No published posts yet'}

Provide analysis. Respond with JSON:
{
  "summary": "brief overview of performance",
  "insights": [
    {"title": "insight title", "description": "detail", "severity": "positive|info|warning|critical", "category": "content|audience|traffic|revenue", "recommendation": "the single concrete action to take for this insight"}
  ],
  "recommendations": ["actionable rec 1", "actionable rec 2"],
  "bestPerforming": "what type of content works best",
  "worstPerforming": "what to stop doing",
  "nextActions": [
    {"type": "edit_website|create_article|create_post|send_email", "title": "imperative action to execute", "description": "precise content to produce", "priority": 1-10}
  ]
}

nextActions = 1 or 2 CONCRETE tasks that apply your top recommendations right away.
${capabilitiesBrief(caps)}`;

  const analysis = await callAgent('analytics', ctx, analyticsPrompt, 2000);

  // Save insights
  if (analysis.insights) {
    for (const insight of analysis.insights.slice(0, 5)) {
      await createInsight(
        ctx.company.id,
        insight.category || 'content',
        insight.title,
        insight.description,
        insight.severity || 'info',
        insight.recommendation || undefined
      );
    }
  }

  analysis.followUps = await createFollowUps(ctx, task, analysis.nextActions, caps);
  return analysis;
}

/** Une tâche de réflexion n'est utile que si elle débouche sur des ACTIONS : on les crée. */
async function createFollowUps(ctx: AgentContext, task: typeof schema.autopilotTasks.$inferSelect, raw: unknown, caps: AutopilotCaps): Promise<string[]> {
  const next = followUpTasks(raw, caps, 2);
  if (!next.length) return [];
  await createPlannedTasks(ctx, task.planId || null, next).catch((e: any) => {
    console.error('[Autopilot] follow-up tasks failed:', e?.message);
  });
  return next.map((t) => String(t.title || ''));
}

async function executeEngageComment(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  // Placeholder — requires social API integration
  return { skipped: true, reason: 'Comment engagement not yet integrated' };
}

async function executeCreateArticle(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  const input = task.input ? JSON.parse(task.input) : {};
  
  const articlePrompt = `Write a blog article for ${ctx.company.name}.

Task: ${task.description}
${input.topic ? `Topic: ${input.topic}` : ''}

Company: ${ctx.company.idea || ctx.company.name}
Industry: ${ctx.company.industry || 'General'}

Write a complete, engaging article (600-1000 words). Respond with JSON:
{
  "title": "article title",
  "content": "full article in markdown",
  "metaDescription": "SEO meta description (160 chars)",
  "tags": ["tag1", "tag2"]
}`;

  const article = await callAgent('content', ctx, articlePrompt, 4000);
  if (!article?.title || !article?.content) return { error: 'L\'article n\'a pas pu être rédigé.' };

  // Store as a document
  const documentId = uuidv4();
  await db.insert(schema.documents).values({
    id: documentId,
    companyId: ctx.company.id,
    title: article.title,
    content: article.content,
    type: 'blog',
  });

  // [2026-10-01] Avant, l'article restait dans les documents : rien de visible
  // sur le site, aucun trafic. Il est maintenant PUBLIÉ sur le site (page
  // /blog) via le même pipeline d'édition que le chat.
  let onSite = false;
  let siteNote: string | null = null;
  if (_chat) {
    const r = await _chat.runSiteEdit(ctx.company.id, articlePublishInstruction(article)).catch((e: any) => ({ status: 'error' as const, error: e?.message }));
    onSite = r.status === 'done';
    if (r.status === 'error') siteNote = 'La mise en ligne sur le site a échoué ; l\'article reste dans tes documents.';
  }
  return {
    title: article.title,
    metaDescription: article.metaDescription || null,
    tags: article.tags || [],
    documentId,
    onSite,
    siteNote,
    words: String(article.content).split(/\s+/).filter(Boolean).length,
  };
}

async function executeAdjustStrategy(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  const input = task.input ? JSON.parse(task.input) : {};
  
  // Get recent insights
  const insights = await db.select().from(schema.autopilotInsights)
    .where(eq(schema.autopilotInsights.companyId, ctx.company.id))
    .orderBy(desc(schema.autopilotInsights.createdAt))
    .limit(10);

  const caps = await autopilotCaps(ctx);
  const strategyPrompt = `Review and adjust strategy for ${ctx.company.name}.

Task: ${task.description}

CURRENT INSIGHTS:
${insights.map(i => `- [${i.severity}] ${i.title}: ${i.description}`).join('\n') || 'No insights yet'}

What strategic adjustments should be made? Respond with JSON:
{
  "assessment": "current situation assessment",
  "adjustments": ["adjustment 1", "adjustment 2"],
  "newPriorities": ["priority 1", "priority 2"],
  "reasoning": "why these changes",
  "nextActions": [
    {"type": "edit_website|create_article|create_post|send_email", "title": "imperative action to execute", "description": "precise content to produce", "priority": 1-10}
  ]
}

nextActions = 1 or 2 CONCRETE tasks that apply your adjustments right away.
${capabilitiesBrief(caps)}`;

  const strategy = await callAgent('strategist', ctx, strategyPrompt, 2000);
  
  await createInsight(ctx.company.id, 'revenue',
    'Strategy adjustment',
    strategy.assessment || 'Strategy reviewed',
    'info',
    strategy.adjustments?.join('; ') || null
  );

  strategy.followUps = await createFollowUps(ctx, task, strategy.nextActions, caps);
  return strategy;
}

// ─── Main Tick (runs every hour) ────────────────────────────────────────────

async function executeSendEmail(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  const input = task.input ? JSON.parse(task.input) : {};

  // Draft the email with the content agent
  const draftPrompt = `Draft an email for ${ctx.company.name}.

Task: ${task.description}
${input.to ? `Recipient: ${input.to}` : ''}

Company: ${ctx.company.idea || ctx.company.name}
Industry: ${ctx.company.industry || 'General'}

Respond with JSON:
{
  "to": "recipient email (use the one provided, or the company owner if none)",
  "subject": "email subject",
  "html": "email body as simple HTML"
}`;

  const draft = await callAgent('content', ctx, draftPrompt, 2000);
  // Fall back to the company owner's email if no recipient was specified
  let ownerEmail: string | null = null;
  if (!input.to && !draft.to) {
    const owner = await db.select({ email: schema.users.email })
      .from(schema.users).where(eq(schema.users.id, ctx.company.userId)).get();
    ownerEmail = owner?.email || null;
  }
  const to = input.to || draft.to || ownerEmail || null;

  if (!to) {
    return { skipped: true, reason: 'No recipient email available', draft };
  }

  // [2026-10-01] SÉCURITÉ : le mode auto n'envoie JAMAIS seul un email à un
  // tiers (adresse souvent inventée par l'IA). Seul l'email du propriétaire
  // part directement ; tout autre destinataire = brouillon à valider.
  const owner = await db.select({ email: schema.users.email })
    .from(schema.users).where(eq(schema.users.id, ctx.company.userId)).get().catch(() => null);
  const toOwner = !!owner?.email && String(to).trim().toLowerCase() === owner.email.trim().toLowerCase();
  if (!toOwner || !isEmailConfigured()) {
    await db.insert(schema.emails).values({
      id: uuidv4(), companyId: ctx.company.id, type: 'outreach',
      subject: String(draft.subject || task.title).slice(0, 300),
      body: String(draft.html || draft.text || ''),
      recipientEmail: String(to), status: 'draft', generatedBy: 'autopilot',
    }).catch(() => {});
    return {
      drafted: true, sent: false, to, subject: draft.subject,
      reason: !toOwner
        ? 'Par sécurité, le mode auto n\'envoie rien à un tiers sans ton accord : le brouillon t\'attend dans tes emails.'
        : 'Envoi d\'email non configuré : le brouillon t\'attend dans tes emails.',
    };
  }

  const sender = await loadSiteSender(ctx.company).catch(() => null);
  const res = await sendEmail({ to, subject: draft.subject || 'Message', html: draft.html || draft.text || '', from: sender?.from, replyTo: sender?.replyTo });
  return { sent: res.ok, id: res.id, error: res.error, to, subject: draft.subject };
}

async function executeScheduleAppointment(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  // A scheduled appointment/reminder is primarily a dated task that lives in a slot.
  // Executing it = confirming the appointment and logging it. The scheduling itself
  // happens at creation time (scheduledFor + timeSlot).
  const when = task.scheduledFor ? new Date(task.scheduledFor) : null;
  await logAction(ctx.company.id, 'strategist', 'appointment',
    `📅 Rendez-vous: ${task.title}${when ? ` — ${when.toLocaleString('fr-FR')}` : ''}`,
    { taskId: task.id, scheduledFor: when?.toISOString() }, task.id, 0, 'info');
  return { scheduled: true, when: when?.toISOString() || null, title: task.title };
}

async function executeImproveApp(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<any> {
  const real = await realSiteEdit(task, ctx);
  if (real) return real;
  // Ask the strategist to produce a concrete improvement proposal for the app.
  const prompt = `Propose a concrete improvement for ${ctx.company.name}'s app/website.

Task: ${task.description}
Company: ${ctx.company.idea || ctx.company.name}

Respond with JSON:
{
  "area": "what part of the app to improve",
  "change": "the specific change to make",
  "impact": "expected impact",
  "priority": 1-10
}`;
  const proposal = await callAgent('strategist', ctx, prompt, 2000);
  await createInsight(
    ctx.company.id,
    'product',
    `App improvement: ${proposal.area || task.title}`,
    proposal.change || task.description || '',
    'info',
    proposal.impact || null,
  );
  return proposal;
}

// ─── Exécution d'une tâche DUE : prompt dans le chat + vrai travail ─────────

async function postponeTask(taskId: string, ms: number) {
  await db.update(schema.autopilotTasks).set({ scheduledFor: new Date(Date.now() + ms) })
    .where(eq(schema.autopilotTasks.id, taskId));
}

async function runDueTask(task: typeof schema.autopilotTasks.$inferSelect, ctx: AgentContext): Promise<'done' | 'postponed'> {
  const sid = ctx.company.id;
  // L'utilisateur est en train de travailler dans le chat : on ne s'interpose pas.
  if (_chat?.isChatBusy(sid)) { await postponeTask(task.id, 5 * 60 * 1000); return 'postponed'; }
  // Pas de crédits : on ne poste rien (sinon le prompt serait répété à chaque passage).
  const owner = await db.select({ tokens: schema.users.tokens }).from(schema.users)
    .where(eq(schema.users.id, ctx.userId)).get().catch(() => null);
  if (owner && owner.tokens <= 0) { await postponeTask(task.id, 60 * 60 * 1000); return 'postponed'; }

  const tz = configTimeZone(ctx.config);
  // 1) Le prompt PRÉCIS de la tâche arrive dans le chat, comme un message.
  await postChat(sid, 'user', taskChatPrompt(task, tz));

  // 2) Vrai travail. Les éditions de site ont leur propre run (pipeline du chat) ;
  //    les autres tâches ouvrent un run pour que le chat montre l'IA au travail.
  const run = EDIT_TYPES.has(task.type) ? null : _chat?.beginRun(sid) || null;
  run?.step(`🤖 ${task.title}`);
  try {
    await executeTask(task, ctx);
    const after = await db.select().from(schema.autopilotTasks).where(eq(schema.autopilotTasks.id, task.id)).get();
    if (after && (after.status === 'completed' || after.status === 'failed')) {
      let output: any = null;
      try { output = after.output ? JSON.parse(after.output) : null; } catch { output = null; }
      // 3) Le résultat dans le chat (sauf si le pipeline d'édition l'a déjà posté).
      if (!output?.chatReplied) await postChat(sid, 'assistant', taskResultMessage(after, output));
    }
  } finally {
    run?.end();
  }
  return 'done';
}

// Début du jour LOCAL de l'utilisateur (pour les limites quotidiennes).
function localDayStart(now: Date, tz: string): Date {
  return atLocal(now, 0, 0, tz);
}

async function completedTodayCount(companyId: string, types: string[], since: Date): Promise<number> {
  const r = await db.select({ c: count() }).from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      or(...types.map(t => eq(schema.autopilotTasks.type, t))),
      eq(schema.autopilotTasks.status, 'completed'),
      gte(schema.autopilotTasks.completedAt, since),
    )).get();
  return r?.c || 0;
}

/** Tâches en attente dont l'heure est passée (ou absente) → replanifiées sur l'avenir. */
async function rescheduleOverdue(companyId: string, olderThanMs = 0): Promise<number> {
  const config = await db.select().from(schema.autopilotConfig)
    .where(eq(schema.autopilotConfig.companyId, companyId)).get();
  if (!config) return 0;
  const now = new Date();
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = await db.select().from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      or(eq(schema.autopilotTasks.status, 'pending'), eq(schema.autopilotTasks.status, 'waiting_approval')),
    ))
    .orderBy(asc(schema.autopilotTasks.scheduledFor), asc(schema.autopilotTasks.priority));
  const stale = rows.filter(r => !r.scheduledFor || new Date(r.scheduledFor).getTime() < cutoff.getTime());
  if (!stale.length) return 0;
  const staleIds = new Set(stale.map(r => r.id));
  const taken = rows.filter(r => !staleIds.has(r.id) && r.scheduledFor).map(r => new Date(r.scheduledFor!));
  const tz = configTimeZone(config);
  const times = planTaskTimes(stale.map(() => ({})), {
    now, tz, workStartHour: config.workStartHour, workEndHour: config.workEndHour, taken,
  });
  for (let i = 0; i < stale.length; i++) {
    await db.update(schema.autopilotTasks).set({
      scheduledFor: times[i].scheduledFor, timeSlot: times[i].timeSlot, hasExactTime: true,
    }).where(eq(schema.autopilotTasks.id, stale[i].id));
  }
  return stale.length;
}

// Verrou PAR ENTREPRISE : activation, planificateur et « trigger » lançaient
// des ticks en parallèle → plan du matin + réflexion simultanés = tâches en double.
const busyCompanies: Set<string> = G.__velbaz_autopilot_busy ??= new Set<string>();
const lastPlanAttempt: Map<string, number> = G.__velbaz_autopilot_plan_attempt ??= new Map<string, number>();
const lastReflectAttempt: Map<string, number> = G.__velbaz_autopilot_reflect_attempt ??= new Map<string, number>();
const PLAN_RETRY_MS = 20 * 60 * 1000;
const REFLECT_RETRY_MS = 30 * 60 * 1000;
const MAX_TASKS_PER_PASS = 3;
const STUCK_RUNNING_MS = 30 * 60 * 1000;

export function isAutopilotBusy(companyId: string): boolean { return busyCompanies.has(companyId); }

function tick(companyId: string): Promise<void> {
  if (busyCompanies.has(companyId)) return Promise.resolve();
  busyCompanies.add(companyId);
  // Étiquette les appels IA du tick autopilot (suivi des crédits, ai-usage/).
  return runWithAiContext({ feature: "autopilot", companyId, runId: newRunId() }, () => tickInner(companyId))
    .finally(() => { busyCompanies.delete(companyId); });
}

async function tickInner(companyId: string): Promise<void> {
  const config = await db.select().from(schema.autopilotConfig)
    .where(eq(schema.autopilotConfig.companyId, companyId)).get();
  
  if (!config?.enabled) return;
  if (!_callAI || !_pickModel || !_deductTokens) {
    console.error('[Autopilot] engine not initialized — tick skipped');
    return;
  }

  const company = await db.select().from(schema.companies)
    .where(eq(schema.companies.id, companyId)).get();
  if (!company) return;

  const now = new Date();
  const currentHour = now.getUTCHours();
  
  // Check work hours
  if (currentHour < config.workStartHour || currentHour > config.workEndHour) {
    return; // Outside work hours
  }

  const ctx: AgentContext = {
    company,
    config,
    plan: null,
    userId: company.userId,
  };
  const tz = configTimeZone(config);

  // Tâche restée « running » après un redémarrage du serveur : jamais reprise.
  await db.update(schema.autopilotTasks).set({ status: 'failed', error: 'Interrompue (redémarrage du serveur)', completedAt: now })
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.status, 'running'),
      lte(schema.autopilotTasks.startedAt, new Date(now.getTime() - STUCK_RUNNING_MS)),
    )).catch(() => {});

  // Morning plan (first tick of the day, or if no plan exists)
  const today = now.toISOString().split('T')[0];
  const todayPlan = await db.select().from(schema.autopilotPlans)
    .where(and(
      eq(schema.autopilotPlans.companyId, companyId),
      eq(schema.autopilotPlans.date, today),
    )).get();

  // ── Calendrier interne : matérialiser les événements dont la date est arrivée ──
  try {
    const mat = await materializeDueEvents(companyId, createTaskFromCalendar);
    if (mat.created > 0) {
      await logAction(companyId, 'strategist', 'calendar_materialized',
        `🗓️ ${mat.created} échéance(s) du calendrier transformée(s) en tâche(s).`,
        { created: mat.created, conflicts: mat.conflicts }, undefined, 0, 'info');
    }
    for (const cf of mat.conflicts) {
      await logAction(companyId, 'strategist', 'calendar_conflict', cf, null, undefined, 0, 'warning');
    }
  } catch (e: any) {
    console.error(`[Autopilot] calendar materialize failed for ${companyId}:`, e?.message);
  }

  if (!todayPlan) {
    const lastTry = lastPlanAttempt.get(companyId) || 0;
    if (Date.now() - lastTry >= PLAN_RETRY_MS) {
      lastPlanAttempt.set(companyId, Date.now());
      // Nouveau jour : les restes d'hier (heure passée depuis > 1 h) sont replanifiés
      // au lieu de partir tous d'un coup au premier passage.
      await rescheduleOverdue(companyId, 60 * 60 * 1000).catch(() => 0);
      await runMorningPlan(ctx);
    }
    ctx.plan = await db.select().from(schema.autopilotPlans)
      .where(and(
        eq(schema.autopilotPlans.companyId, companyId),
        eq(schema.autopilotPlans.date, today),
      )).get() || null;
  } else {
    ctx.plan = todayPlan;
  }

  // Exécute les tâches DUES, une par une (plusieurs par passage si besoin).
  const dayStart = localDayStart(now, tz);
  let ran = 0;
  const seen = new Set<string>();
  while (ran < MAX_TASKS_PER_PASS) {
    const fresh = await db.select({ enabled: schema.autopilotConfig.enabled }).from(schema.autopilotConfig)
      .where(eq(schema.autopilotConfig.companyId, companyId)).get();
    if (!fresh?.enabled) break; // désactivé pendant le passage
    const nextTask = await getNextTask(companyId);
    if (!nextTask || seen.has(nextTask.id)) break;
    seen.add(nextTask.id);

    // Limites quotidiennes (jour local) : la tâche est reportée à demain, pas perdue.
    const tomorrow = clampToWorkWindow(atLocal(now, 9, 0, tz, 1), config);
    if (nextTask.type === 'create_post'
      && await completedTodayCount(companyId, ['create_post'], dayStart) >= config.maxPostsPerDay) {
      await db.update(schema.autopilotTasks).set({ scheduledFor: tomorrow, timeSlot: slotOf(tomorrow, tz) })
        .where(eq(schema.autopilotTasks.id, nextTask.id));
      await logAction(companyId, 'system', 'limit_reached',
        `Limite de posts du jour atteinte (${config.maxPostsPerDay}) — « ${nextTask.title} » reporté à demain.`);
      continue;
    }
    if (EDIT_TYPES.has(nextTask.type)
      && await completedTodayCount(companyId, [...EDIT_TYPES], dayStart) >= config.maxWebsiteEditsPerDay) {
      await db.update(schema.autopilotTasks).set({ scheduledFor: tomorrow, timeSlot: slotOf(tomorrow, tz) })
        .where(eq(schema.autopilotTasks.id, nextTask.id));
      await logAction(companyId, 'system', 'limit_reached',
        `Limite de modifications du site atteinte (${config.maxWebsiteEditsPerDay}/jour) — « ${nextTask.title} » reporté à demain.`);
      continue;
    }

    const r = await runDueTask(nextTask, ctx);
    if (r === 'postponed') break;
    ran++;
  }

  if (ran === 0) {
    // Plus rien en attente → réflexion (limitée : pas un appel IA par minute).
    const lastTry = lastReflectAttempt.get(companyId) || 0;
    if (Date.now() - lastTry >= REFLECT_RETRY_MS) {
      const active = await db.select({ c: count() }).from(schema.autopilotTasks)
        .where(and(
          eq(schema.autopilotTasks.companyId, companyId),
          or(eq(schema.autopilotTasks.status, 'pending'), eq(schema.autopilotTasks.status, 'waiting_approval'), eq(schema.autopilotTasks.status, 'running')),
        )).get();
      if ((active?.c || 0) === 0) {
        lastReflectAttempt.set(companyId, Date.now());
        await reflectAndGenerate(ctx);
      }
    }
  }

  // Update last tick
  await db.update(schema.autopilotConfig).set({
    lastTickAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(schema.autopilotConfig.companyId, companyId));
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
// [2026-10-01] Passage toutes les MINUTES (avant : 30 min, une seule tâche par
// tick → une tâche de 18:00 pouvait partir à 18:29, et les suivantes bien plus
// tard). Un passage ne coûte rien s'il n'y a rien de dû : le plan du matin et
// la réflexion ont leur propre limite. Le passage est lu sur globalThis pour
// qu'un hot-reload du module prenne effet sans redémarrer le serveur.

const PASS_MS = 60 * 1000;

async function schedulerPass(): Promise<void> {
  let configs: (typeof schema.autopilotConfig.$inferSelect)[] = [];
  try {
    configs = await db.select().from(schema.autopilotConfig)
      .where(eq(schema.autopilotConfig.enabled, true));
  } catch (e: any) {
    console.error('[Autopilot] Scheduler error:', e?.message);
    return;
  }
  for (const config of configs) {
    // Pas d'await : une longue édition d'un projet ne bloque pas les autres
    // (le verrou par entreprise empêche tout chevauchement).
    // Hors requête : le tick suit le mode Velbaz du propriétaire du projet.
    runWithVelbazModeForCompany(config.companyId, () => tick(config.companyId)).catch((e: any) =>
      console.error(`[Autopilot] Tick failed for company ${config.companyId}:`, e?.message));
  }
}
G.__velbaz_autopilot_pass = schedulerPass;

export function startAutopilotScheduler() {
  if (G.__velbaz_autopilot_interval) return;
  console.log('[Autopilot] Scheduler started — checking due tasks every minute');
  G.__velbaz_autopilot_interval = setInterval(() => {
    Promise.resolve(G.__velbaz_autopilot_pass?.()).catch(() => {});
  }, PASS_MS);
  // Premier passage peu après le démarrage (rattrape ce qui est dû).
  setTimeout(() => { Promise.resolve(G.__velbaz_autopilot_pass?.()).catch(() => {}); }, 15_000);
}

export function stopAutopilotScheduler() {
  if (G.__velbaz_autopilot_interval) {
    clearInterval(G.__velbaz_autopilot_interval);
    G.__velbaz_autopilot_interval = null;
    console.log('[Autopilot] Scheduler stopped');
  }
}

// ─── Manual trigger (for API) ───────────────────────────────────────────────

export async function triggerTick(companyId: string): Promise<void> {
  await tick(companyId);
}

export async function enableAutopilot(companyId: string, timezone?: unknown): Promise<void> {
  const existing = await db.select().from(schema.autopilotConfig)
    .where(eq(schema.autopilotConfig.companyId, companyId)).get();
  
  if (existing) {
    await db.update(schema.autopilotConfig).set({ 
      enabled: true, updatedAt: new Date() 
    }).where(eq(schema.autopilotConfig.companyId, companyId));
  } else {
    await db.insert(schema.autopilotConfig).values({
      id: uuidv4(),
      companyId,
      enabled: true,
    });
  }
  await rememberAutopilotTimezone(companyId, timezone).catch(() => {});

  // Tâches restées en attente avec une heure passée → replanifiées sur l'avenir
  // (avant : elles s'affichaient « à 8 h » alors qu'il était 18 h et partaient d'un coup).
  await rescheduleOverdue(companyId).catch(() => 0);

  await logAction(companyId, 'system', 'enabled', '🚀 Autopilot enabled! AI team is now active.');
  
  // Premier passage immédiat (le verrou évite tout doublon avec le planificateur).
  setTimeout(() => tick(companyId).catch(() => {}), 2000);
}

export async function disableAutopilot(companyId: string): Promise<void> {
  await db.update(schema.autopilotConfig).set({ 
    enabled: false, updatedAt: new Date() 
  }).where(eq(schema.autopilotConfig.companyId, companyId));

  // Cancel pending tasks
  await db.update(schema.autopilotTasks).set({ status: 'cancelled' })
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      or(
        eq(schema.autopilotTasks.status, 'pending'),
        eq(schema.autopilotTasks.status, 'waiting_approval'),
      ),
    ));

  await logAction(companyId, 'system', 'disabled', '⏸️ Autopilot disabled. AI team is paused.');
}

export async function setApprovalMode(companyId: string, enabled: boolean): Promise<void> {
  await db.update(schema.autopilotConfig).set({ 
    approvalMode: enabled, updatedAt: new Date() 
  }).where(eq(schema.autopilotConfig.companyId, companyId));

  await logAction(companyId, 'system', 'approval_mode', 
    enabled ? '🔒 Approval mode ON — AI will ask before acting' : '🔓 Approval mode OFF — AI acts autonomously');
}

export async function approveTask(taskId: string, userId: string): Promise<void> {
  await db.update(schema.autopilotTasks).set({ 
    status: 'pending', 
    approvedAt: new Date(), 
    approvedBy: userId 
  }).where(eq(schema.autopilotTasks.id, taskId));
}

export async function rejectTask(taskId: string, reason?: string): Promise<void> {
  await db.update(schema.autopilotTasks).set({ 
    status: 'rejected', 
    rejectedAt: new Date(), 
    rejectionReason: reason || null 
  }).where(eq(schema.autopilotTasks.id, taskId));
}

// ─── Query helpers ──────────────────────────────────────────────────────────

export async function getAutopilotStatus(companyId: string) {
  // [2026-09-10] Statut d'autopilot = route pollée en boucle par l'UI. Une
  // simple coupure réseau Turso ("Failed query") la faisait répondre 500 et
  // l'onglet Autopilot affichait une erreur. Chaque lecture passe désormais par
  // dbRetry (backoff court sur erreurs transitoires uniquement).
  const config = await dbRetry(() => db.select().from(schema.autopilotConfig)
    .where(eq(schema.autopilotConfig.companyId, companyId)).get());
  
  const today = new Date().toISOString().split('T')[0];
  const plan = await dbRetry(() => db.select().from(schema.autopilotPlans)
    .where(and(
      eq(schema.autopilotPlans.companyId, companyId),
      eq(schema.autopilotPlans.date, today),
    )).get());

  const pendingTasks = await dbRetry(() => db.select({ count: count() }).from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.status, 'pending'),
    )).get());

  const awaitingApproval = await dbRetry(() => db.select({ count: count() }).from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.status, 'waiting_approval'),
    )).get());

  // Check if AI is CURRENTLY running a task
  const runningTask = await dbRetry(() => db.select().from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.status, 'running'),
    ))
    .orderBy(desc(schema.autopilotTasks.startedAt))
    .limit(1)
    .get());

  const recentLogs = await dbRetry(() => db.select().from(schema.autopilotLogs)
    .where(eq(schema.autopilotLogs.companyId, companyId))
    .orderBy(desc(schema.autopilotLogs.createdAt))
    .limit(10));

  // Count completed tasks today
  // [2026-09-10] Le filtre de date manquait : « terminées aujourd'hui »
  // affichait en réalité TOUTES les tâches terminées depuis la création de
  // l'entreprise, un compteur qui ne redescendait jamais.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const completedToday = await dbRetry(() => db.select({ count: count() }).from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.status, 'completed'),
      gte(schema.autopilotTasks.completedAt, startOfToday),
    )).get());

  return {
    enabled: config?.enabled || false,
    approvalMode: config?.approvalMode || false,
    lastTick: config?.lastTickAt,
    lastMorningPlan: config?.lastMorningPlanAt,
    isWorking: !!runningTask,
    currentTask: runningTask ? {
      id: runningTask.id,
      title: runningTask.title,
      agent: runningTask.agent,
      type: runningTask.type,
      startedAt: runningTask.startedAt,
    } : null,
    completedToday: completedToday?.count || 0,
    todayPlan: plan ? {
      summary: plan.summary,
      goals: JSON.parse(plan.goals || '[]'),
      progress: `${plan.completedTasks}/${plan.totalTasks}`,
    } : null,
    pendingTasks: pendingTasks?.count || 0,
    awaitingApproval: awaitingApproval?.count || 0,
    recentActivity: recentLogs.map(l => ({
      agent: l.agent,
      action: l.action,
      message: l.message,
      level: l.level,
      time: l.createdAt,
    })),
    config: config ? {
      workStartHour: config.workStartHour,
      workEndHour: config.workEndHour,
      maxPostsPerDay: config.maxPostsPerDay,
      maxWebsiteEditsPerDay: config.maxWebsiteEditsPerDay,
    } : null,
  };
}

// Get activity summary since a given timestamp (for "while you were away")
export async function getAutopilotActivitySince(companyId: string, since: Date) {
  const logs = await db.select().from(schema.autopilotLogs)
    .where(and(
      eq(schema.autopilotLogs.companyId, companyId),
      sql`${schema.autopilotLogs.createdAt} > ${since}`,
    ))
    .orderBy(desc(schema.autopilotLogs.createdAt))
    .limit(100);

  const completedTasks = await db.select().from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.status, 'completed'),
      sql`${schema.autopilotTasks.completedAt} > ${since}`,
    ))
    .orderBy(desc(schema.autopilotTasks.completedAt));

  const newInsights = await db.select().from(schema.autopilotInsights)
    .where(and(
      eq(schema.autopilotInsights.companyId, companyId),
      sql`${schema.autopilotInsights.createdAt} > ${since}`,
    ))
    .orderBy(desc(schema.autopilotInsights.createdAt));

  // Group actions by agent
  const agentSummary: Record<string, number> = {};
  for (const l of logs) {
    agentSummary[l.agent] = (agentSummary[l.agent] || 0) + 1;
  }

  return {
    totalActions: logs.length,
    completedTasks: completedTasks.map(t => ({
      id: t.id, title: t.title, agent: t.agent, type: t.type, completedAt: t.completedAt,
    })),
    newInsights: newInsights.map(i => ({
      id: i.id, title: i.title, severity: i.severity, category: i.category,
    })),
    agentSummary,
    logs: logs.slice(0, 20).map(l => ({
      agent: l.agent, action: l.action, message: l.message, level: l.level, time: l.createdAt,
    })),
  };
}

export async function getAutopilotLogs(companyId: string, limit = 50, offset = 0) {
  return db.select().from(schema.autopilotLogs)
    .where(eq(schema.autopilotLogs.companyId, companyId))
    .orderBy(desc(schema.autopilotLogs.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function getAutopilotInsights(companyId: string) {
  return db.select().from(schema.autopilotInsights)
    .where(and(
      eq(schema.autopilotInsights.companyId, companyId),
      or(
        eq(schema.autopilotInsights.status, 'new'),
        eq(schema.autopilotInsights.status, 'acknowledged'),
      ),
    ))
    .orderBy(desc(schema.autopilotInsights.createdAt))
    .limit(20);
}

export async function getAutopilotTasks(companyId: string, status?: string) {
  const conditions = [eq(schema.autopilotTasks.companyId, companyId)];
  if (status) conditions.push(eq(schema.autopilotTasks.status, status));
  
  return db.select().from(schema.autopilotTasks)
    .where(and(...conditions))
    .orderBy(desc(schema.autopilotTasks.createdAt))
    .limit(50);
}

// ─── Build-page scheduler helpers (grouped by slot) ─────────────────────────

const ACTIVE_STATUSES = ['pending', 'waiting_approval', 'running'] as const;

// Return only the active/visible tasks grouped into the 3 slots, ordered so the
// soonest task is at the top of each slot.
export async function getAutopilotSlots(companyId: string) {
  const rows = await db.select().from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      or(...ACTIVE_STATUSES.map(s => eq(schema.autopilotTasks.status, s))),
    ))
    .orderBy(asc(schema.autopilotTasks.scheduledFor), asc(schema.autopilotTasks.slotOrder), asc(schema.autopilotTasks.createdAt));

  const tz = await companyTimeZone(companyId);
  const slots: Record<TimeSlot, typeof rows> = { morning: [], noon: [], evening: [] };
  // [2026-10-01] L'ordre affiché = l'ordre des HEURES = l'ordre d'exécution.
  // Avant : tri par slotOrder (rang donné par l'IA) → « 21:00, 20:00, 21:30,
  // 20:30 » dans le même créneau. Le créneau suit lui aussi l'heure réelle.
  for (const r of [...rows].sort(compareTasksByTime)) {
    const slot = r.scheduledFor ? slotOf(new Date(r.scheduledFor), tz) : ((r.timeSlot as TimeSlot) || 'morning');
    (slots[slot] ||= []).push({ ...r, timeSlot: slot });
  }
  return slots;
}

// Move / reorder a task into a slot at a given position
// Une tâche glissée dans un AUTRE créneau change aussi d'heure d'exécution
// (avant : seul l'affichage bougeait, la tâche partait à son ancienne heure).
async function retimeIfSlotChanged(companyId: string, taskId: string, timeSlot: TimeSlot, tz: string) {
  const row = await db.select({ ts: schema.autopilotTasks.timeSlot, s: schema.autopilotTasks.scheduledFor })
    .from(schema.autopilotTasks)
    .where(and(eq(schema.autopilotTasks.id, taskId), eq(schema.autopilotTasks.companyId, companyId))).get();
  if (!row) return;
  const currentSlot = row.s ? slotOf(new Date(row.s), tz) : row.ts;
  if (currentSlot === timeSlot) return;
  await db.update(schema.autopilotTasks)
    .set({ scheduledFor: timeForSlot(timeSlot, new Date(), tz), hasExactTime: false })
    .where(and(eq(schema.autopilotTasks.id, taskId), eq(schema.autopilotTasks.companyId, companyId)));
}

// Après un glisser-déposer, les heures du créneau suivent le nouvel ordre
// (la tâche glissée en tête prend la 1re heure, etc.) : ce qui est affiché en
// haut part vraiment en premier.
async function resequenceSlot(companyId: string, slot: TimeSlot, orderedIds: string[], tz: string) {
  if (!orderedIds.length) return;
  const rows = await db.select({ id: schema.autopilotTasks.id, s: schema.autopilotTasks.scheduledFor, status: schema.autopilotTasks.status })
    .from(schema.autopilotTasks)
    .where(and(eq(schema.autopilotTasks.companyId, companyId), inArray(schema.autopilotTasks.id, orderedIds)));
  const byId = new Map(rows.map(r => [r.id, r]));
  // Une tâche en cours garde son heure ; seules les tâches en attente sont re-datées.
  const ids = orderedIds.filter(id => { const r = byId.get(id); return r && r.status !== 'running'; });
  if (!ids.length) return;
  const now = new Date();
  const times = resequenceTimes(ids.map(id => { const s = byId.get(id)!.s; return s ? new Date(s) : null; }),
    { now, fallback: timeForSlot(slot, now, tz) });
  for (let i = 0; i < ids.length; i++) {
    await db.update(schema.autopilotTasks)
      .set({ scheduledFor: times[i], slotOrder: i, timeSlot: slotOf(times[i], tz) })
      .where(and(eq(schema.autopilotTasks.id, ids[i]), eq(schema.autopilotTasks.companyId, companyId)));
  }
}

export async function moveAutopilotTask(companyId: string, taskId: string, timeSlot: TimeSlot, slotOrder: number) {
  await retimeIfSlotChanged(companyId, taskId, timeSlot, await companyTimeZone(companyId));
  await db.update(schema.autopilotTasks)
    .set({ timeSlot, slotOrder })
    .where(and(eq(schema.autopilotTasks.id, taskId), eq(schema.autopilotTasks.companyId, companyId)));

  // Re-normalise the ordering within the target slot so positions stay stable
  const rows = await db.select({ id: schema.autopilotTasks.id }).from(schema.autopilotTasks)
    .where(and(
      eq(schema.autopilotTasks.companyId, companyId),
      eq(schema.autopilotTasks.timeSlot, timeSlot),
      or(...ACTIVE_STATUSES.map(s => eq(schema.autopilotTasks.status, s))),
    ))
    .orderBy(asc(schema.autopilotTasks.slotOrder), asc(schema.autopilotTasks.createdAt));
  await resequenceSlot(companyId, timeSlot, rows.map(r => r.id), await companyTimeZone(companyId));
}

// Persist a full new arrangement of the 3 slots at once (drag-and-drop).
// `slots` maps each slot to the ordered list of task IDs it should contain.
export async function reorderAutopilotSlots(companyId: string, slots: Partial<Record<TimeSlot, string[]>>) {
  const tz = await companyTimeZone(companyId);
  for (const slot of ['morning', 'noon', 'evening'] as TimeSlot[]) {
    const ids = slots[slot];
    if (!ids) continue;
    for (const id of ids) await retimeIfSlotChanged(companyId, id, slot, tz);
    await resequenceSlot(companyId, slot, ids, tz);
  }
}

// Edit a task's idea/description (and optionally title)
export async function editAutopilotTask(companyId: string, taskId: string, patch: { title?: string; description?: string }) {
  const set: any = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.description !== undefined) set.description = patch.description;
  if (Object.keys(set).length === 0) return;
  await db.update(schema.autopilotTasks).set(set)
    .where(and(eq(schema.autopilotTasks.id, taskId), eq(schema.autopilotTasks.companyId, companyId)));
}

// Set a precise date (with or without hour) via the 3-dot menu.
// `localDate` (AAAA-MM-JJ) + `time` (HH:MM) sont lus dans le fuseau de
// l'utilisateur ; date seule → 9 h locale ; jamais dans le passé.
export async function scheduleAutopilotTask(
  companyId: string,
  taskId: string,
  when: { iso?: string | null; localDate?: string | null; time?: string | null; hasExactTime: boolean },
) {
  const tz = await companyTimeZone(companyId);
  const scheduledFor = timeForChosenDate(when, new Date(), tz);
  const hasExactTime = !!when.hasExactTime;
  const timeSlot = slotOf(scheduledFor, tz);
  await db.update(schema.autopilotTasks)
    .set({ scheduledFor, hasExactTime, timeSlot })
    .where(and(eq(schema.autopilotTasks.id, taskId), eq(schema.autopilotTasks.companyId, companyId)));
}

// Delete a task (leaves the slot free → dashed placeholder in the UI)
export async function deleteAutopilotTask(companyId: string, taskId: string) {
  await db.delete(schema.autopilotTasks)
    .where(and(eq(schema.autopilotTasks.id, taskId), eq(schema.autopilotTasks.companyId, companyId)));
}

// Add a user-created task into a specific slot (the "+" popup)
export async function addAutopilotTask(companyId: string, timeSlot: TimeSlot, title: string, description?: string): Promise<string> {
  const today = new Date().toISOString().split('T')[0];
  const plan = await db.select().from(schema.autopilotPlans)
    .where(and(eq(schema.autopilotPlans.companyId, companyId), eq(schema.autopilotPlans.date, today))).get();
  const tz = await companyTimeZone(companyId);
  const scheduledFor = timeForSlot(timeSlot, new Date(), tz);
  // Tâche écrite par l'utilisateur : si elle parle du site, c'est une VRAIE
  // modification du site (pipeline du chat), pas une simple note de stratégie.
  const text = `${title} ${description || ''}`;
  const isSiteEdit = /\b(site|page|section|bouton|couleur|texte|titre|image|photo|logo|menu|footer|header|banni[èe]re|formulaire|faq|accueil|boutique|produit|prix|police|font)\b/i.test(text)
    || /^(ajoute|modifie|change|supprime|enl[èe]ve|retire|mets|remplace|corrige|am[ée]liore)\b/i.test(title.trim());
  return createTask(companyId, plan?.id || null, {
    type: isSiteEdit ? 'edit_website' : 'adjust_strategy',
    title,
    description: description || title,
    agent: isSiteEdit ? 'content' : 'strategist',
    priority: 5,
    scheduledFor,
    timeSlot,
    hasExactTime: false,
    input: { userCreated: true },
  });
}
