// ─── Boucle d'agent : le modèle appelle ses outils jusqu'à avoir la réponse ──
//
// Une réponse de chat normale = 1 appel au modèle. Ici, tant que le modèle
// demande un outil (ouvrir une page, lancer une commande…), on l'exécute et on
// lui renvoie le résultat, jusqu'à ce qu'il rédige sa réponse finale ou qu'on
// atteigne le plafond d'étapes.
//
// Rien n'est masqué : chaque outil exécuté émet une étape `progress` visible
// dans le chat, et le journal des appels revient dans le résultat.

import { generateText, streamText, stepCountIs } from 'ai';
import { gateway } from '../agent/gateway';
import { buildAgentTools } from './tools';
import { createMarkerSafeEmitter } from './stream-safe';
import type { AgentProgress, AgentUser, ToolCall } from './types';

/** Outils aux effets réels, qu'on ne doit jamais rejouer en double. */
export const SIDE_EFFECT_TOOLS = new Set(['send_email', 'generate_image', 'create_document']);

const MAX_STEPS = 12;              // garde-fou : jamais de boucle infinie
const CALL_TIMEOUT_MS = 600_000;   // 10 min pour toute la boucle
const FALLBACK_MODELS = ['openai/gpt-5.4-mini', 'google/gemini-3-flash'];

// [2026-09-16] Réflexion interne coupée, comme NO_THINKING dans
// agents/orchestrator.ts. Les modèles à raisonnement (gemini, ici en repli, et
// deepseek) facturent leur réflexion SUR l'enveloppe de sortie : avec 1500
// tokens partagés entre 12 étapes d'outils, la réponse finale peut revenir
// vide. Ces options sont ignorées par les providers qui ne les connaissent pas
// (openai, anthropic).
const NO_THINKING = {
  google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
  deepseek: { thinking: { type: 'disabled' } },
} as const;

export interface AgentLoopOptions {
  system: string;
  /** Message utilisateur, ou contenu multimodal (pièces jointes). */
  content: string | any[];
  model: string;
  sessionId: string;
  companyId?: string;
  /** Utilisateur connecté + son message brut (outils email/image). */
  user?: AgentUser;
  userMessage?: string;
  onProgress?: (step: AgentProgress) => void;
  /** Texte diffusé au fur et à mesure de sa rédaction (brouillon en direct). */
  onToken?: (chunk: string) => void;
  /** Le modèle repart pour un tour (appel d'outil) → le brouillon est jeté. */
  onTokenReset?: () => void;
  maxOutputTokens?: number;
  maxSteps?: number;
}

export interface AgentLoopResult {
  text: string;
  calls: ToolCall[];
  steps: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`AI_TIMEOUT: ${label} exceeded ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Lance la boucle. Renvoie null si le modèle est indisponible — l'appelant
 * retombe alors sur la génération de texte classique (pas de chat cassé).
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult | null> {
  const calls: ToolCall[] = [];
  const tools = buildAgentTools({
    sessionId: opts.sessionId,
    companyId: opts.companyId,
    onProgress: opts.onProgress,
    log: calls,
    user: opts.user,
    userMessage: opts.userMessage,
  });

  const models = [opts.model, ...FALLBACK_MODELS.filter((m) => m !== opts.model)];
  let lastErr = '';

  for (const model of models) {
    try {
      const common = {
        model: gateway(model),
        system: opts.system,
        messages: [{ role: 'user' as const, content: opts.content as any }],
        tools: tools as any,
        stopWhen: stepCountIs(opts.maxSteps ?? MAX_STEPS),
        maxOutputTokens: opts.maxOutputTokens ?? 1500,
        providerOptions: NO_THINKING as any,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      };

      let text = '';
      let steps = 1;

      if (opts.onToken) {
        // ── Rédaction diffusée en direct ──────────────────────────────────
        // L'utilisateur voit la réponse s'écrire au lieu d'attendre plusieurs
        // secondes devant un écran figé. Un appel d'outil = nouveau tour : ce
        // qui avait été écrit avant n'est pas la réponse finale → on le jette.
        const emit = createMarkerSafeEmitter(opts.onToken);
        const __tl = Date.now();
        let __first = true;
        const res = streamText(common);
        await withTimeout((async () => {
          for await (const part of res.fullStream as AsyncIterable<any>) {
            if (!part) continue;
            if (part.type === 'text-delta' && __first) { __first = false; console.log(`[PERF] agent-loop TTFT ${Date.now() - __tl}ms (prompt ${opts.system.length} chars)`); }
            if (part.type === 'text-delta') {
              const d: string = typeof part.text === 'string' ? part.text : (part.textDelta || '');
              if (d) emit(d);
            } else if (part.type === 'tool-call') {
              emit.reset();
              try { opts.onTokenReset?.(); } catch { /* client parti */ }
            } else if (part.type === 'error') {
              throw part.error instanceof Error ? part.error : new Error(String(part.error));
            }
          }
        })(), CALL_TIMEOUT_MS, model);
        text = ((await res.text) || '').trim();
        steps = (await res.steps)?.length ?? 1;
      } else {
        const res = await withTimeout(generateText(common), CALL_TIMEOUT_MS, model);
        text = (res.text || '').trim();
        steps = res.steps?.length ?? 1;
      }

      // Un modèle qui a travaillé mais n'a rien rédigé : on ne renvoie pas du
      // vide, l'appelant reprendra la main avec le journal des outils.
      if (!text && calls.length === 0) { lastErr = 'EMPTY_OUTPUT'; continue; }
      return { text, calls, steps };
    } catch (e: any) {
      lastErr = e?.message || String(e);
      console.log(`[agent-loop] ${model} a échoué :`, lastErr.slice(0, 200));
      // Une action réelle (email envoyé, image générée, document écrit) a déjà
      // eu lieu : rejouer la boucle sur un autre modèle la referait (deux
      // emails). On s'arrête et on rend le journal ; l'appelant rédige un
      // compte rendu fidèle à partir de ce qui a vraiment été fait.
      if (calls.some((c) => c.ok && SIDE_EFFECT_TOOLS.has(c.tool))) {
        try { opts.onTokenReset?.(); } catch { /* client parti */ }
        return { text: '', calls, steps: 0 };
      }
      // Modèle suivant : le brouillon déjà diffusé ne vaut plus rien.
      try { opts.onTokenReset?.(); } catch { /* client parti */ }
      continue;
    }
  }
  console.log('[agent-loop] aucun modèle disponible pour la boucle d\'outils :', lastErr.slice(0, 200));
  return null;
}

/** Résumé lisible des outils utilisés (repli quand le modèle ne rédige rien). */
export function summarizeCalls(calls: ToolCall[]): string {
  if (!calls.length) return '';
  return calls.map((c) => `- ${c.tool} → ${c.ok ? 'ok' : 'échec'} : ${c.summary}`).join('\n');
}
