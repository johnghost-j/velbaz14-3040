import { create } from 'zustand';
import { api } from './api';
import { roleModel, marketingModel, MARKETING_MODEL } from './role-models';
import { pickBuildEndMessages, buildRecapId } from './build-end-messages';
import { translate } from './i18n';

export interface BuildMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  time: Date;
  isBuildStep?: boolean;
  reasoning?: string;
  agentRole?: string;
  action?: string;
}

const PROCESS_LABELS: Record<string, string> = {
  initialize: 'Initializing',
  create: 'Creating company',
  'build-website': 'Building website',
  mega_init: 'Industry setup',
  heartbeat: 'Running agents',
};

const STORAGE_KEY = 'velbaz_build_state';

/* ═══ Réseaux sociaux : un état PAR PROJET ═══════════════════════════════════
   Avant, socialPhase / connectedPlatforms étaient globaux : un « Skip for now »
   ou une connexion faite dans un projet s'appliquait à TOUS les autres projets.
   L'état est maintenant rangé par companyId dans localStorage et rechargé quand
   on ouvre un projet. */
type SocialPhase = 'none' | 'connecting' | 'learning' | 'active';
interface SocialSnap { phase: SocialPhase; platforms: string[] }

const SOCIAL_KEY = (companyId: string) => `velbaz_social_${companyId}`;

function loadSocialSnap(companyId: string): SocialSnap {
  try {
    const raw = localStorage.getItem(SOCIAL_KEY(companyId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<SocialSnap>;
      return {
        phase: (p.phase ?? 'none') as SocialPhase,
        platforms: Array.isArray(p.platforms) ? p.platforms : [],
      };
    }
  } catch {}
  return { phase: 'none', platforms: [] };
}

function saveSocialSnap(companyId: string, snap: SocialSnap) {
  try { localStorage.setItem(SOCIAL_KEY(companyId), JSON.stringify(snap)); } catch {}
}

// ── Resilient build-website trigger ─────────────────────────────────────────
// `api.request()` does NOT throw on HTTP 401/500 — it resolves with `{error}`.
// So a plain `.catch(() => {})` never catches a failed build start, and the
// build silently never begins ("rien ne se passe"). This helper inspects the
// response, retries transient failures (Unauthorized from a transient Turso
// socket drop on the server, DB errors, network), and returns whether the
// build actually started. A `queued` / `already_running` / `already_built`
// status all count as success.
// ── Verrou de SÉQUENCEMENT (commande /genesis) ──────────────────────────────
// [2026-09-05] Cause du bug « ça génère les images ET ça code le site en même
// temps » : le chat gardait ses propres appels (`genesisBlocksBuild`), mais
// TOUS les autres chemins passaient à côté — reprise au retour d'onglet,
// reprise après redémarrage serveur, relance automatique du poll ci-dessous.
// Or il n'existe qu'UNE seule porte vers le serveur : `startBuildWebsiteResilient`.
// Le verrou est donc posé ICI, à la porte. Tant qu'il est posé, aucun build ne
// peut partir, quel que soit le chemin. Il vit en MÉMOIRE uniquement (jamais en
// storage : un verrou persisté avait déjà bloqué tous les builds à vie) et il
// est relâché dès que le moteur d'images a fini.
let buildGateReason: string | null = null;
export function setBuildGate(reason: string | null) {
  buildGateReason = reason;
  if (reason) console.log(`[build-gate] posé : ${reason}`);
  else console.log('[build-gate] relâché');
}
export function buildGateBlocks(where: string): boolean {
  if (!buildGateReason) return false;
  console.log(`[build-gate/${where}] build refusé — ${buildGateReason}`);
  return true;
}

async function startBuildWebsiteResilient(
  companyId: string,
  styleReference?: string,
  attempts = 4,
): Promise<{ ok: boolean; error?: string; gated?: boolean }> {
  // Porte unique : le site ne se code JAMAIS pendant la phase d'images.
  if (buildGateBlocks('startBuildWebsite')) {
    return { ok: false, gated: true, error: buildGateReason || 'séquencement' };
  }
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const res: any = await api.companies.buildWebsite(companyId, styleReference);
      const err = typeof res?.error === 'string' ? res.error : '';
      if (!err) {
        // No error → build started (queued) or was already going / done.
        return { ok: true };
      }
      lastError = err;
      // Retry transient server-side failures (auth blip from Turso socket drop,
      // DB query failures, network). Don't retry a hard "not found".
      const transient = /Unauthorized|Failed query|ECONNRESET|socket|closed|timed out|timeout|network|fetch failed|500|Internal/i.test(err);
      if (!transient) return { ok: false, error: err };
    } catch (e: any) {
      lastError = e?.message || String(e);
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 600 * (i + 1)));
  }
  return { ok: false, error: lastError || 'unknown' };
}

interface PersistedBuildState {
  companyId: string;
  companyName: string;
  isBuilding: boolean;
  isBuildingWebsite: boolean;
  websiteReady: boolean;
  buildProgress: number;
  currentTask: string;
  parallelCount: number;
  liveStatus: string;
  buildMessages: BuildMessage[];
}

function saveToStorage(state: Partial<PersistedBuildState>) {
  try {
    const existing = loadFromStorage();
    const merged = { ...existing, ...state };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {}
}

function loadFromStorage(): PersistedBuildState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Restore Date objects in messages
    if (parsed.buildMessages) {
      parsed.buildMessages = parsed.buildMessages.map((m: any) => ({
        ...m,
        time: new Date(m.time),
      }));
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearStorage() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
}

function deriveStatusText(data: { jobs: any[]; executions: any[]; latestActivity?: any[] }): string {
  const { jobs, executions, latestActivity } = data;

  const running = executions?.filter((e: any) => e.status === 'running') || [];
  if (running.length > 0) {
    const exec = running[0];
    const processLabel = PROCESS_LABELS[exec.type] || exec.type;
    const progress = exec.totalSteps > 0 ? ` (${exec.step}/${exec.totalSteps})` : '';
    return `${processLabel}${progress}`;
  }

  const runningJobs = jobs?.filter((j: any) => j.status === 'running' || j.status === 'queued') || [];
  if (runningJobs.length > 0) {
    const job = runningJobs[0];
    const label = PROCESS_LABELS[job.type] || job.type;
    return `${label}...`;
  }

  if (latestActivity?.length) {
    const latest = latestActivity[0];
    if (latest.action === 'executing' || latest.action === 'spawned') {
      const msg = latest.message
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/^\[.*?\]\s*/, '')
        .trim();
      return msg.length > 60 ? msg.slice(0, 57) + '...' : msg;
    }
    // If latest activity is 'completed' but there are running jobs/executions above,
    // we already returned. If we're here, show what the last activity was doing.
    if (latest.action === 'completed') {
      return 'Processing next step...';
    }
  }

  return 'AI is working...';
}

interface BuildStore {
  companyId: string | null;
  companyName: string | null;
  isBuilding: boolean;
  isBuildingWebsite: boolean;
  websiteReady: boolean;
  /** True once the AI has defined the build plan (number of pages / tasks). Preview panel only shows after this. */
  planReady: boolean;
  buildProgress: number;
  currentTask: string;
  parallelCount: number;
  buildMessages: BuildMessage[];
  liveStatus: string;
  /** Social AI phase — transitions after website is ready */
  socialPhase: 'none' | 'connecting' | 'learning' | 'active';
  connectedPlatforms: string[];
  /** Projet auquel appartient socialPhase / connectedPlatforms (état par projet). */
  socialCompanyId: string | null;
  /**
   * [2026-09-05] Vrai quand la commande /genesis pilote le projet ouvert.
   * Sert au badge « genesis » de la barre latérale : l'utilisateur doit voir
   * d'un coup d'oeil s'il est en mode genesis. C'est le chat qui le pose et le
   * retire — aucun état inventé, aucune horloge.
   */
  genesisMode: boolean;
  _cancelled: boolean;
  _pollInterval: ReturnType<typeof setInterval> | null;
  _seenActivityIds: Set<string>;

  /**
   * Lance un build.
   *
   * [2026-09-25] `waitFor` : promesse dont le SERVEUR dépend (enregistrement
   * des pages choisies, marque en cours). L'état « en construction » est posé
   * TOUT DE SUITE, de façon synchrone ; seul l'appel réseau attend `waitFor`.
   * Avant, l'appelant attendait ces promesses AVANT d'appeler runBuild : rien
   * ne bougeait à l'écran pendant ~1,5 s après la validation du plan de pages.
   */
  runBuild: (company: { id: string; name: string }, styleReference?: string, waitFor?: Promise<unknown>) => void;
  resumeBuild: (companyId: string) => void;
  /** Restore "ready" state when opening a finished project (pages exist, nothing running) */
  markWebsiteReady: (companyId: string) => void;
  cancelBuild: () => void;
  reset: () => void;
  setSocialPhase: (phase: 'none' | 'connecting' | 'learning' | 'active') => void;
  setConnectedPlatforms: (platforms: string[]) => void;
  /** Charge l'état réseaux sociaux du projet ouvert (skip / connexions propres à CE projet). */
  loadSocial: (companyId: string) => void;
  /** Pose / retire le mode genesis (badge de la barre latérale). */
  setGenesisMode: (on: boolean) => void;
}

// Anti-boucle : une relance automatique côté client (après « server restart »)
// relançait un build complet — avec à nouveau QA, bugs, corrections… — à
// chaque poll qui voyait l'état, sans aucune limite. Au plus 2 relances par
// projet et par 30 min, mémorisées en localStorage (survit au rechargement).
/** Builds dont la fin est en cours d'affichage (lecture de l'historique) : un poll concurrent ne rajoute rien. */
const finalizingBuilds = new Set<string>();

const AUTO_RESUME_MAX = 2;
const AUTO_RESUME_WINDOW_MS = 30 * 60 * 1000;
export function allowClientAutoResume(companyId: string, now = Date.now()): boolean {
  const key = `velbaz_auto_resume_${companyId}`;
  let stamps: number[] = [];
  try { stamps = (JSON.parse(localStorage.getItem(key) || '[]') as number[]).filter(t => now - t < AUTO_RESUME_WINDOW_MS); } catch { stamps = []; }
  if (stamps.length >= AUTO_RESUME_MAX) return false;
  stamps.push(now);
  try { localStorage.setItem(key, JSON.stringify(stamps)); } catch {}
  return true;
}

// Shared polling logic used by both runBuild and resumeBuild
function startPolling(companyId: string, companyName: string, set: any, get: any, seenIds: Set<string>) {
  // Tracks the last-seen message content per activity id so live-streaming code
  // rows (same id, growing message) can be updated in place instead of skipped.
  const seenContent = new Map<string, string>();
  let taskTotal = 0;
  let taskCompleted = 0;
  let lastNewActivityAt = Date.now();
  // Mode de modèles de la dernière étape vue (« velbaz2 » ou non) : sert à
  // étiqueter la synthèse marketing de fin de build, qui n'a pas de ligne
  // d'activité propre.
  let lastModelMode: string | undefined;
  let consecutiveNoActivityPolls = 0;
  const STALE_TIMEOUT = 20 * 60 * 1000; // 20 minutes with no new activity = stuck (large AI calls can take 10min+)

  // Soft ceiling the progress bar is allowed to creep toward between real
  // milestones. Milestones (from [n/m] activity messages) only land every
  // 30–90s while a page generates, so without this the bar looks frozen.
  // The creep interval below eases the bar toward this ceiling continuously
  // so the user always sees live movement.
  let creepCeiling = 5;
  const creepInterval = setInterval(() => {
    // Self-terminate on any build end/cancel. Every terminal path sets
    // _pollInterval to null, so this cleans itself up in all cases.
    if (get()._pollInterval === null || get()._cancelled || !get().isBuilding) {
      clearInterval(creepInterval);
      return;
    }
    const cur = get().buildProgress || 0;
    if (cur >= creepCeiling) return;
    // Ease-out: fast when far from the ceiling, slow as it approaches.
    const step = Math.max(0.25, (creepCeiling - cur) * 0.06);
    set({ buildProgress: Math.min(creepCeiling, Math.round((cur + step) * 10) / 10) });
  }, 700);

  const poll = async () => {
    if (get()._cancelled || !get().isBuilding) return;
    try {
      const res = await api.companies.jobs(companyId);
      const { jobs, latestActivity } = res as { jobs: any[]; executions: any[]; latestActivity: any[] };

      const status = deriveStatusText(res);
      set({ liveStatus: status });

      // Mode « approbation manuelle » : le serveur a mis le build EN PAUSE en
      // attendant la réponse de l'utilisateur. L'absence d'activité est alors
      // voulue — ce n'est pas un build bloqué.
      if ((res as any)?.pendingApproval) {
        lastNewActivityAt = Date.now();
        consecutiveNoActivityPolls = 0;
        set({ liveStatus: 'En pause — en attente de ta validation' });
      }

      // Stale detection: only declare stuck after extended inactivity AND multiple consecutive polls with no new activity
      const runningJobs = jobs?.filter((j: any) => j.status === 'running' || j.status === 'queued') || [];
      if (runningJobs.length > 0 && Date.now() - lastNewActivityAt > STALE_TIMEOUT) {
        // Double-check: increment consecutive no-activity counter to avoid false positives from transient gaps
        consecutiveNoActivityPolls++;
        // Only declare stuck after 3+ consecutive stale polls (7.5+ seconds) AND exceeding the timeout
        if (consecutiveNoActivityPolls >= 3) {
          const iv = get()._pollInterval;
          if (iv) clearInterval(iv);
          const stuckMsg: BuildMessage = {
            id: `stuck-${Date.now()}`,
            role: 'assistant',
            content: 'Build appears to be stuck — no new activity for 20 minutes. The AI gateway may have timed out. You can try resuming the build to pick up where it left off, or create a new company to start fresh.',
            model: 'velbaz',
            time: new Date(),
            reasoning: 'No new activity detected for 20 minutes while jobs are still marked as running. This usually means the backend AI call hung or the gateway failed.',
          };
          set((s: any) => ({
            isBuilding: false,
            isBuildingWebsite: false,
            _pollInterval: null,
            liveStatus: 'Build stalled — try resuming',
            currentTask: 'Build stalled — no activity for 20 minutes',
            buildMessages: [...s.buildMessages, stuckMsg],
          }));
          clearStorage();
          return;
        }
      } else if (runningJobs.length > 0) {
        // Jobs still running and within timeout — reset consecutive counter
        consecutiveNoActivityPolls = 0;
      }

      if (latestActivity?.length) {
        const newMessages: BuildMessage[] = [];
        const updatedById = new Map<string, { content: string; action: string }>();
        const chronological = [...latestActivity].reverse();
        for (const act of chronological) {
          if (!act.id) continue;
          if (seenIds.has(act.id)) {
            // Already rendered. For live-streaming code rows the id stays the same
            // but the message grows — detect content changes and update in place so
            // the code rectangle fills in real time instead of freezing.
            const prev = seenContent.get(act.id);
            const nextContent = act.message || '';
            if (prev !== nextContent) {
              seenContent.set(act.id, nextContent);
              updatedById.set(act.id, { content: nextContent, action: act.action || 'executing' });
              lastNewActivityAt = Date.now();
            }
            continue;
          }
          seenIds.add(act.id);
          seenContent.set(act.id, act.message || '');
          lastNewActivityAt = Date.now(); // Reset stale timer on any new activity

          let content = act.message || '';
          if (act.modelMode) lastModelMode = act.modelMode;
          const model = roleModel(act.agentRole, act.modelMode);

          const progressMatch = content.match(/\[(\d+)\/(\d+)\]/);
          if (progressMatch) {
            taskCompleted = parseInt(progressMatch[1]);
            taskTotal = parseInt(progressMatch[2]);
            if (taskTotal > 0 && !get().planReady) set({ planReady: true });
          }

          const planMatch = content.match(/(\d+)\s*phases?,\s*(\d+)\s*tasks?/);
          if (planMatch) {
            taskTotal = parseInt(planMatch[2]);
            if (!get().planReady) set({ planReady: true });
          }

          // App builder progress markers (engine.ts). These fire as soon as the
          // plan/pages are known — reveal the right-hand preview panel right away.
          //   "📋 Plan: tool, 4 pages"  |  "📄 Génération de 4 pages…"
          const appPlanMatch = content.match(/Plan:\s*[\w-]+,\s*(\d+)\s*pages?/i);
          if (appPlanMatch) {
            taskTotal = Math.max(taskTotal, parseInt(appPlanMatch[1]));
            if (!get().planReady) set({ planReady: true });
          }
          const appPagesMatch = content.match(/G[ée]n[ée]ration de\s*(\d+)\s*pages?/i);
          if (appPagesMatch) {
            taskTotal = Math.max(taskTotal, parseInt(appPagesMatch[1]));
            if (!get().planReady) set({ planReady: true });
          }
          // Any design-system / component / page-generation step means the build
          // has a concrete plan — safe to show the preview panel.
          if (/Syst[èe]me de design|Composants partag|Construction d'une vraie app|Planification de l'app/i.test(content)) {
            if (!get().planReady) set({ planReady: true });
          }

          const parallelMatch = content.match(/Running (\d+) tasks in parallel/);
          if (parallelMatch) {
            set({ parallelCount: parseInt(parallelMatch[1]) });
          }

          if (act.action === 'executing') {
            const taskDesc = content
              .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
              .replace(/^\[.*?\]\s*/, '')
              .replace(/^Phase:\s*/, '')
              .trim();
            if (taskDesc.length > 5) {
              set({ currentTask: taskDesc });
            }
          }

          if (act.action === 'completed' && progressMatch) {
            set({ parallelCount: Math.max(0, get().parallelCount - 1) });
          }

          if (taskTotal > 0) {
            // Real milestone reached. Snap the bar up to the completed mark,
            // then let the creep interval ease it toward the NEXT milestone so
            // movement stays continuous instead of freezing between steps.
            const done = Math.min(95, Math.round((taskCompleted / taskTotal) * 90) + 5);
            const next = Math.min(95, Math.round(((taskCompleted + 1) / taskTotal) * 90) + 5);
            creepCeiling = next;
            if ((get().buildProgress || 0) < done) set({ buildProgress: done });
          }

          let reasoning: string | undefined;
          const roleName = act.agentRole === 'design' ? 'Design Agent'
            : act.agentRole === 'engineer' || act.agentRole === 'engineering' ? 'Engineering Agent'
            : act.agentRole === 'ceo' ? 'CEO Agent'
            : act.agentRole === 'marketing' ? 'Marketing Agent'
            : act.agentRole === 'supply_chain' ? 'Supply Chain Agent'
            : act.agentRole || 'Agent';
          if (act.action === 'executing') {
            reasoning = `${roleName} is working on this...`;
          } else if (act.action === 'completed') {
            reasoning = `${roleName} — done`;
          } else if (act.action === 'spawned') {
            reasoning = `${roleName} activated`;
          } else if (act.action === 'error') {
            reasoning = `${roleName} encountered an issue — retrying...`;
          } else if (act.action === 'waiting') {
            reasoning = `${roleName} — en pause, attend ta validation`;
          }

          newMessages.push({
            id: `activity-${act.id}`,
            role: 'assistant',
            content,
            model,
            time: new Date(act.createdAt),
            isBuildStep: true,
            reasoning,
            agentRole: act.agentRole || 'velbaz',
            action: act.action || 'executing',
          });
        }

        if (updatedById.size > 0 || newMessages.length > 0) {
          // Don't save build step messages to chat DB — they come from the activity log
          // and saving them causes duplication when history is reloaded
          set((s: any) => {
            let msgs = s.buildMessages;
            if (updatedById.size > 0) {
              msgs = msgs.map((bm: BuildMessage) => {
                const key = bm.id.startsWith('activity-') ? bm.id.slice('activity-'.length) : bm.id;
                const upd = updatedById.get(key);
                return upd ? { ...bm, content: upd.content, action: upd.action } : bm;
              });
            }
            return { buildMessages: newMessages.length > 0 ? [...msgs, ...newMessages] : msgs };
          });
        }
      }

      // Check job states — merge in-memory jobs with DB-persisted executions for resilience across server restarts
      const initJob = jobs?.find((j: any) => j.type === 'initialize');
      const websiteJob = jobs?.find((j: any) => j.type === 'build-website');
      // Also check DB executions as fallback (in-memory jobs are lost on server restart)
      const executions = (res as any).executions || [];
      const dbInitExec = executions.find((e: any) => e.type === 'initialize');
      const dbWebsiteExec = executions.find((e: any) => e.type === 'build-website');

      const initStatus = initJob?.status || dbInitExec?.status;
      const websiteStatus = websiteJob?.status || dbWebsiteExec?.status;
      const hasInitRecord = !!(initJob || dbInitExec);
      const hasWebsiteRecord = !!(websiteJob || dbWebsiteExec);

      // Only consider a step "done" if its record EXISTS and has completed/failed.
      // If no record exists, it hasn't started yet — NOT done.
      const initDone = hasInitRecord && (initStatus === 'completed' || initStatus === 'failed');
      const websiteDone = hasWebsiteRecord && (websiteStatus === 'completed' || websiteStatus === 'failed');

      const websiteRunningOrQueued = websiteStatus === 'running' || websiteStatus === 'queued';
      if (websiteRunningOrQueued && !get().isBuildingWebsite) {
        set({ isBuildingWebsite: true });
      }

      if (websiteStatus === 'completed') {
        set({ websiteReady: true, buildProgress: 100, parallelCount: 0 });
      }

      // Persist state after every poll
      const st = get();
      saveToStorage({
        companyId: st.companyId,
        companyName: st.companyName,
        isBuilding: st.isBuilding,
        isBuildingWebsite: st.isBuildingWebsite,
        websiteReady: st.websiteReady,
        buildProgress: st.buildProgress,
        currentTask: st.currentTask,
        parallelCount: st.parallelCount,
        liveStatus: st.liveStatus,
        buildMessages: st.buildMessages,
      });

      // Build is complete only when ALL existing processes have finished.
      // At minimum, website must be done. Init is optional (some flows skip it).
      const allProcessesDone = websiteDone && (!hasInitRecord || initDone);
      if (allProcessesDone) {
        // Guard: don't add done message if one already exists (race condition from overlapping polls)
        const existingDone = finalizingBuilds.has(companyId) || get().buildMessages.some((m: BuildMessage) => m.id.startsWith('done-') || m.id === buildRecapId(companyId) || m.content?.includes('company is ready') || m.content?.includes('Build had issues'));
        if (existingDone) {
          // Already have a done message — just stop polling and finalize state
          const iv = get()._pollInterval;
          if (iv) clearInterval(iv);
          const websiteActuallyReady = websiteStatus === 'completed';
          set({ isBuilding: false, isBuildingWebsite: false, _pollInterval: null, buildProgress: websiteActuallyReady ? 100 : 0, websiteReady: websiteActuallyReady });
          saveToStorage({
            companyId, companyName,
            isBuilding: false, isBuildingWebsite: false,
            websiteReady: websiteActuallyReady, buildProgress: websiteActuallyReady ? 100 : 0,
            currentTask: '', parallelCount: 0, liveStatus: 'Done',
            buildMessages: get().buildMessages,
          });
          return;
        }

        const initFailed = initStatus === 'failed';
        const websiteFailed = websiteStatus === 'failed';

        // Auto-resume: if build-website failed due to server restart, auto-trigger rebuild
        // The backend sets a resume marker so the rebuild skips completed steps & doesn't charge tokens
        const websiteError = websiteJob?.error || dbWebsiteExec?.error || '';
        const isServerRestart = /server restart|auto-resum/i.test(websiteError);
        const websiteAutoResuming = (websiteJob as any)?.autoResuming || (dbWebsiteExec as any)?.autoResuming;
        if (((websiteFailed && isServerRestart) || websiteAutoResuming) && allowClientAutoResume(companyId)) {
          // Don't count this as a real failure — auto-resume in progress
          console.log('[build-store] Server restart detected — auto-resuming build-website...');
          const resumeMsg: BuildMessage = {
            id: `resume-${Date.now()}`,
            role: 'assistant',
            content: '🔄 Server restarted during build — automatically resuming from last checkpoint...',
            model: 'velbaz',
            time: new Date(),
            isBuildStep: true,
          };
          set((s: any) => ({ buildMessages: [...s.buildMessages, resumeMsg] }));
          // Fire rebuild — backend will find resume marker and skip completed steps
          startBuildWebsiteResilient(companyId).catch(() => {});
          return; // Keep polling — the rebuild will create a new running job
        }

        const anyFailed = initFailed || websiteFailed;

        // [2026-10-04] Fin de build : plus de « Your project is ready! 🎉 » codé
        // en dur. Le serveur a écrit dans le chat le récap de ce qui a été
        // construit (dernier message) et les messages de fin (marketing, pack
        // visibilité, contenu d'exemple, propositions) : on les affiche ICI, en
        // direct, avec leurs fichiers. Cf. lib/build-end-messages.ts.
        const doneMsg = (key: 'build.done.ready' | 'build.done.failed'): BuildMessage => ({
          id: `done-${companyId}`,  // Stable ID based on company, not timestamp
          role: 'assistant',
          content: translate(key),
          model: 'velbaz',
          time: new Date(),
        });
        if (anyFailed) {
          // Message calme et actionnable (pas d'alarme technique, pas de stack brute).
          set((s: any) => ({ buildMessages: [...s.buildMessages, doneMsg('build.done.failed')] }));
        } else {
          finalizingBuilds.add(companyId);
          const startedRaw = websiteJob?.startedAt || dbWebsiteExec?.startedAt;
          const startedAt = startedRaw ? new Date(startedRaw) : null;
          const since = startedAt && !isNaN(startedAt.getTime()) ? startedAt : null;
          const label = (model?: string | null) => (model === MARKETING_MODEL ? marketingModel(lastModelMode) : (model || 'velbaz'));
          api.chat.history(companyId).then((res: any) => {
            const present = new Set(get().buildMessages.map((m: BuildMessage) => m.id));
            const picked = pickBuildEndMessages(res?.messages || [], companyId, since, present, label);
            // Pas de récap en base (serveur antérieur, ou écriture échouée — signalée
            // dans le déroulé du build) : une phrase de fin traduite, jamais rien.
            const hasRecap = picked.some((m) => m.id === buildRecapId(companyId)) || present.has(buildRecapId(companyId));
            if (get().companyId !== companyId) return; // l'utilisateur est passé à un autre build entre-temps
            set((s: any) => ({ buildMessages: [...s.buildMessages, ...picked, ...(hasRecap ? [] : [doneMsg('build.done.ready')])] }));
          }, (err: unknown) => {
            // Historique injoignable (réseau) : le récap est en base et réapparaîtra au rechargement.
            console.warn('[build-store] messages de fin de build non chargés:', err);
            if (get().companyId !== companyId) return;
            set((s: any) => ({ buildMessages: [...s.buildMessages, doneMsg('build.done.ready')] }));
          }).finally(() => {
            finalizingBuilds.delete(companyId);
            if (get().companyId === companyId) saveToStorage({ buildMessages: get().buildMessages });
          });
        }

        const iv = get()._pollInterval;
        if (iv) clearInterval(iv);

        const websiteActuallyReady = websiteStatus === 'completed';
        set({ isBuilding: false, isBuildingWebsite: false, _pollInterval: null, buildProgress: anyFailed ? 0 : 100, websiteReady: websiteActuallyReady });
        saveToStorage({
          companyId,
          companyName,
          isBuilding: false,
          isBuildingWebsite: false,
          websiteReady: websiteActuallyReady,
          buildProgress: anyFailed ? 0 : 100,
          currentTask: '',
          parallelCount: 0,
          liveStatus: anyFailed ? 'Failed' : 'Done',
          buildMessages: get().buildMessages,
        });
      }
    } catch {
      // Network error — keep polling
    }
  };

  // [2026-09-17] Les premières lignes d'activité arrivaient jusqu'à 2,5 s après
  // le départ réel du build (premier poll à 800 ms puis intervalle de 2,5 s),
  // ce qui faisait croire que l'IA ne démarrait pas. On sonde plus vite les
  // trois premières secondes, puis on reprend le rythme normal. `poll` est
  // idempotent (dédup par `seenIds`) et sort tout seul si le build est fini.
  setTimeout(poll, 250);
  setTimeout(poll, 900);
  setTimeout(poll, 1700);
  const iv = setInterval(poll, 2500);
  set({ _pollInterval: iv });
}

export const useBuildStore = create<BuildStore>((set, get) => ({
  companyId: null,
  companyName: null,
  isBuilding: false,
  isBuildingWebsite: false,
  websiteReady: false,
  planReady: false,
  buildProgress: 0,
  currentTask: '',
  parallelCount: 0,
  buildMessages: [],
  liveStatus: 'AI is working...',
  socialPhase: 'none',
  connectedPlatforms: [],
  socialCompanyId: null,
  genesisMode: false,
  _cancelled: false,
  _pollInterval: null,
  _seenActivityIds: new Set(),

  runBuild: (company, styleReference, waitFor) => {
    // Verrou de séquencement /genesis : on n'entre même pas dans l'état
    // « en construction » (sinon l'écran afficherait un build qui n'existe pas).
    if (buildGateBlocks('runBuild')) return;
    const prev = get()._pollInterval;
    if (prev) clearInterval(prev);

    // A brand-new build supersedes any previous cancel of this company:
    // clear the "cancelled" marker so refreshes resume THIS build normally.
    try { localStorage.removeItem(`velbaz_cancelled_${company.id}`); } catch {}

    const seenIds = new Set<string>();

    set({
      companyId: company.id,
      companyName: company.name,
      isBuilding: true,
      isBuildingWebsite: false,
      websiteReady: false,
      planReady: false,
      buildProgress: 0,
      currentTask: styleReference ? `Applying "${styleReference}" style...` : 'Analyzing project...',
      parallelCount: 0,
      buildMessages: [],
      liveStatus: 'Starting up...',
      _cancelled: false,
      _pollInterval: null,
      _seenActivityIds: seenIds,
    });

    // Persist initial state
    saveToStorage({
      companyId: company.id,
      companyName: company.name,
      isBuilding: true,
      isBuildingWebsite: false,
      websiteReady: false,
      buildProgress: 0,
      currentTask: styleReference ? `Applying "${styleReference}" style...` : 'Analyzing project...',
      parallelCount: 0,
      liveStatus: 'Starting up...',
      buildMessages: [],
    });

    // ── Départ réel côté serveur ────────────────────────────────────────
    // L'état ci-dessus est déjà posé : l'écran montre la construction dans la
    // même image que le clic. Ce qui suit part soit immédiatement, soit dès que
    // `waitFor` est tenue (les pages validées doivent être en base avant que le
    // moteur les lise) — sans jamais retarder l'affichage.
    const launch = () => {
      // Annulé pendant l'attente → rien ne part.
      if (get()._cancelled) return;
      // Un autre projet a pris la main pendant l'attente : le build de CELUI-CI
      // doit quand même partir côté serveur (sinon il ne démarrerait jamais),
      // mais on ne sonde pas — le polling écrirait l'état d'un autre projet.
      const stillMine = get().companyId === company.id;

      // Fire-and-forget company init (agents/logo) — best-effort, not blocking.
      api.companies.initialize(company.id).catch(() => {});

      // ── Build-website MUST actually start, or the preview never appears. ──
      // `api.request` resolves (not rejects) on 401/500, so we inspect the result
      // and retry transient failures. On a hard failure we surface a visible
      // error + retry instead of leaving the user on an infinite skeleton.
      startBuildWebsiteResilient(company.id, styleReference).then(r => {
        if (r.ok) return;
        // Verrou de séquencement /genesis : ce n'est PAS une panne, le site
        // attend simplement la fin des images. Aucun message d'erreur.
        if (r.gated) return;
        console.error('[build-store] build-website failed to start:', r.error);
        const st = get();
        // Only show the failure if we're still on this company and not already done.
        if (st.companyId !== company.id) return;
        const iv = get()._pollInterval;
        if (iv) clearInterval(iv);
        const failMsg: BuildMessage = {
          id: `build-fail-${company.id}`,
          role: 'assistant',
          content: `⚠️ The build couldn't start (${r.error || 'server error'}). It may be a temporary outage — click **Retry** or resend your request.`,
          model: 'velbaz',
          time: new Date(),
          isBuildStep: true,
        };
        set((s: any) => ({
          isBuilding: false,
          isBuildingWebsite: false,
          _pollInterval: null,
          liveStatus: 'Failed',
          buildProgress: 0,
          buildMessages: [...s.buildMessages, failMsg],
        }));
        saveToStorage({
          companyId: company.id, companyName: company.name,
          isBuilding: false, isBuildingWebsite: false,
          websiteReady: false, buildProgress: 0,
          currentTask: '', parallelCount: 0, liveStatus: 'Failed',
          buildMessages: get().buildMessages,
        });
      });

      if (stillMine) startPolling(company.id, company.name, set, get, seenIds);
    };

    if (waitFor) Promise.resolve(waitFor).catch(() => {}).then(launch);
    else launch();
  },

  // Restore final "ready" state for a finished project (pages exist, nothing running).
  // Without this, opening a completed project left websiteReady=false → infinite skeleton.
  markWebsiteReady: (companyId: string) => {
    const st = get();
    // Don't interfere with an active build of another (or the same) project
    if (st.isBuilding && st.companyId === companyId) return;
    set({
      companyId,
      isBuilding: false,
      isBuildingWebsite: false,
      websiteReady: true,
      buildProgress: 100,
      parallelCount: 0,
    });
  },

  // Resume a build after page refresh — restores state from sessionStorage and re-starts polling
  resumeBuild: (companyId: string) => {
    // ── User cancelled this build recently → NEVER restore "AI is working" ──
    // Covers the race where the page is refreshed (or the server restarts)
    // before the backend cancel finished persisting. We still re-send the
    // cancel to the backend so any surviving job/DB row gets killed too.
    try {
      const cancelledAt = Number(localStorage.getItem(`velbaz_cancelled_${companyId}`) || 0);
      if (cancelledAt && Date.now() - cancelledAt < 30 * 60 * 1000) {
        clearStorage();
        api.companies.cancelBuild(companyId).catch(() => {});
        return;
      }
      if (cancelledAt) localStorage.removeItem(`velbaz_cancelled_${companyId}`);
    } catch {}

    // Don't resume if already polling this company
    if (get()._pollInterval && get().companyId === companyId && get().isBuilding) return;

    // Clear any stale poll from a different company
    const prevIv = get()._pollInterval;
    if (prevIv) clearInterval(prevIv);

    const saved = loadFromStorage();
    if (!saved || saved.companyId !== companyId) {
      // No saved state — check server directly
      api.companies.jobs(companyId).then((res: any) => {
        const { jobs, executions } = res;
        const websiteJob = jobs?.find((j: any) => j.type === 'build-website');
        const runningJobs = jobs?.filter((j: any) => j.status === 'running' || j.status === 'queued') || [];

        const dbWebsiteExec = executions?.find((e: any) => e.type === 'build-website');
        const websiteCompleted = websiteJob?.status === 'completed' || dbWebsiteExec?.status === 'completed';
        // Check both in-memory jobs and DB executions (server now auto-resumes stale DB records)
        const dbRunning = executions?.some((e: any) => e.status === 'running') || false;
        const anythingRunning = runningJobs.length > 0 || dbRunning;

        if (websiteCompleted && !anythingRunning) {
          set({
            companyId,
            companyName: companyId,
            isBuilding: false,
            isBuildingWebsite: false,
            websiteReady: true,
            buildProgress: 100,
            currentTask: '',
            parallelCount: 0,
            buildMessages: [],
            liveStatus: 'Done',
            _cancelled: false,
            _pollInterval: null,
            _seenActivityIds: new Set(),
          });
          return;
        }

        // Nothing running — nothing to resume
        if (!anythingRunning) return;

        const websiteRunning = (websiteJob && (websiteJob.status === 'running' || websiteJob.status === 'queued'))
          || (dbWebsiteExec && dbWebsiteExec.status === 'running');
        const websiteDone = websiteCompleted;

        const seenIds = new Set<string>();
        set({
          companyId,
          companyName: companyId,
          isBuilding: true,
          isBuildingWebsite: websiteRunning || false,
          websiteReady: websiteDone || false,
          planReady: true,
          buildProgress: websiteDone ? 100 : 10,
          currentTask: 'Resuming...',
          parallelCount: 0,
          buildMessages: [],
          liveStatus: 'Reconnecting...',
          _cancelled: false,
          _pollInterval: null,
          _seenActivityIds: seenIds,
        });

        startPolling(companyId, companyId, set, get, seenIds);
      }).catch(() => {});
      return;
    }

    // We have saved state — restore it
    const seenIds = new Set<string>();
    // Mark existing message IDs as seen so we don't duplicate
    if (saved.buildMessages) {
      for (const msg of saved.buildMessages) {
        const actId = msg.id.replace('activity-', '');
        seenIds.add(actId);
      }
    }

    // If build was already done (isBuilding=false, websiteReady=true), just restore final state
    if (!saved.isBuilding && saved.websiteReady) {
      set({
        companyId: saved.companyId,
        companyName: saved.companyName,
        isBuilding: false,
        isBuildingWebsite: false,
        websiteReady: true,
        buildProgress: 100,
        currentTask: '',
        parallelCount: 0,
        buildMessages: saved.buildMessages || [],
        liveStatus: 'Done',
        _cancelled: false,
        _pollInterval: null,
        _seenActivityIds: seenIds,
      });
      return;
    }

    // Saved state says build was in progress — but DON'T trust it blindly.
    // Verify with server first to avoid flashing "building" then immediately removing it.
    api.companies.jobs(companyId).then((res: any) => {
      const { jobs, executions } = res;
      // Check both in-memory jobs AND DB executions for running state
      const runningJobs = jobs?.filter((j: any) => j.status === 'running' || j.status === 'queued') || [];
      const dbRunning = executions?.some((e: any) => e.status === 'running') || false;
      const anythingRunning = runningJobs.length > 0 || dbRunning;

      const websiteJob = jobs?.find((j: any) => j.type === 'build-website');
      const dbWebsiteExec = executions?.find((e: any) => e.type === 'build-website');
      const websiteCompleted = websiteJob?.status === 'completed' || dbWebsiteExec?.status === 'completed';

      if (!anythingRunning) {
        // Nothing running on server — saved state is stale, clear it
        clearStorage();
        if (websiteCompleted) {
          set({
            companyId,
            companyName: saved.companyName || companyId,
            isBuilding: false,
            isBuildingWebsite: false,
            websiteReady: true,
            buildProgress: 100,
            currentTask: '',
            parallelCount: 0,
            buildMessages: saved.buildMessages || [],
            liveStatus: 'Done',
            _cancelled: false,
            _pollInterval: null,
            _seenActivityIds: seenIds,
          });
        }
        // If nothing running and website not completed, don't set any building state
        return;
      }

      // Server confirms something IS running — NOW restore building state and poll
      const websiteRunning = (websiteJob && (websiteJob.status === 'running' || websiteJob.status === 'queued'))
        || (dbWebsiteExec && dbWebsiteExec.status === 'running');
      set({
        companyId: saved.companyId,
        companyName: saved.companyName,
        isBuilding: true,
        isBuildingWebsite: websiteRunning || false,
        websiteReady: websiteCompleted || saved.websiteReady,
        planReady: true,
        buildProgress: saved.buildProgress,
        currentTask: saved.currentTask,
        parallelCount: saved.parallelCount,
        buildMessages: saved.buildMessages || [],
        liveStatus: saved.liveStatus || 'Reconnecting...',
        _cancelled: false,
        _pollInterval: null,
        _seenActivityIds: seenIds,
      });

      startPolling(saved.companyId, saved.companyName, set, get, seenIds);
    }).catch(() => {
      // Network error — don't show building state, fail safe
    });
  },

  cancelBuild: () => {
    const iv = get()._pollInterval;
    if (iv) clearInterval(iv);

    // Tell the backend to kill all running jobs for this company
    const companyId = get().companyId;
    if (companyId) {
      // Durable local marker: if the user refreshes RIGHT after cancelling
      // (before the backend cancel has landed), resumeBuild must NOT restore
      // the "AI is working" state for this company.
      try { localStorage.setItem(`velbaz_cancelled_${companyId}`, String(Date.now())); } catch {}
      api.companies.cancelBuild(companyId).catch(() => {});
    }

    const cancelMsg: BuildMessage = {
      id: `cancelled-${Date.now()}`,
      role: 'assistant',
      content: 'Build cancelled.',
      model: 'velbaz',
      time: new Date(),
    };
    set(s => ({
      _cancelled: true,
      isBuilding: false,
      isBuildingWebsite: false,
      _pollInterval: null,
      buildMessages: [...s.buildMessages, cancelMsg],
    }));
    clearStorage();
  },

  reset: () => {
    const iv = get()._pollInterval;
    if (iv) clearInterval(iv);
    set({
      companyId: null,
      companyName: null,
      isBuilding: false,
      isBuildingWebsite: false,
      websiteReady: false,
      planReady: false,
      buildProgress: 0,
      currentTask: '',
      parallelCount: 0,
      buildMessages: [],
      liveStatus: 'AI is working...',
      socialPhase: 'none',
      connectedPlatforms: [],
      socialCompanyId: null,
      _cancelled: false,
      _pollInterval: null,
      _seenActivityIds: new Set(),
    });
    clearStorage();
  },

  setGenesisMode: (on) => {
    if (get().genesisMode === on) return;
    set({ genesisMode: on });
  },

  setSocialPhase: (phase) => {
    set({ socialPhase: phase });
    const id = get().socialCompanyId;
    if (id) saveSocialSnap(id, { phase, platforms: get().connectedPlatforms });
  },

  setConnectedPlatforms: (platforms) => {
    set({ connectedPlatforms: platforms });
    const id = get().socialCompanyId;
    if (id) saveSocialSnap(id, { phase: get().socialPhase, platforms });
  },

  // Chaque projet garde son propre skip / ses propres connexions.
  loadSocial: (companyId) => {
    if (!companyId) return;
    if (get().socialCompanyId === companyId) return;
    const snap = loadSocialSnap(companyId);
    set({ socialCompanyId: companyId, socialPhase: snap.phase, connectedPlatforms: snap.platforms });
  },
}));
