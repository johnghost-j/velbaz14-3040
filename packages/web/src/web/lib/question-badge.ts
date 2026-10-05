/* ─────────────────────────────────────────────────────────────────────────────
   Pastille « l'IA attend une réponse » (rond jaune de la Sidebar + favicon).

   Source unique de vérité pour répondre à UNE question : est-ce que l'IA
   attend réellement quelque chose de l'utilisateur sur ce projet ?

   Historique du bug corrigé ici [2026-09-25] : le rond jaune s'allumait sur des
   projets où l'IA ne demandait rien, pour deux raisons —
   1. N'IMPORTE QUELLE pop-up allumait la pastille, y compris les types 'info'
      (message informatif) et 'progress' (barre de progression) qui n'attendent
      aucune réponse et se ferment tout seuls.
   2. Le flag persisté en base ne s'éteignait que via des appels manuels
      dispersés dans le front : tout chemin oublié (réponse tapée dans la barre
      de chat, annulation du build, onglet fermé) laissait la pastille allumée
      définitivement.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Types de pop-up qui NE bloquent PAS l'IA : elles informent, elles ne
 * demandent rien. AIPopup.isBlockingPopup() est construite dessus, pour que
 * pastille et pop-up ne puissent jamais diverger.
 */
export const NON_BLOCKING_POPUP_TYPES = ['info', 'progress'] as const;

export function isNonBlockingPopupType(type: string | null | undefined): boolean {
  return !!type && (NON_BLOCKING_POPUP_TYPES as readonly string[]).includes(type);
}

/** État « en attente » du chat, tel que persisté/restauré par projet. */
export interface PendingUiState {
  pendingQuestions?: unknown[] | null;
  /** Pop-up affichée au-dessus de la barre de saisie. */
  pendingPopup?: { type?: string | null } | null;
  /** Demande d'approbation explicite (AIApprovalPopup). */
  pendingApproval?: unknown;
  /** Validation de la fiche société. */
  pendingCompany?: unknown;
  /** Validation du plan de pages. */
  pendingPagePlan?: unknown;
}

/**
 * True seulement si quelque chose attend RÉELLEMENT une réponse de
 * l'utilisateur. C'est le seul prédicat qui doit allumer la pastille.
 */
export function hasBlockingQuestion(s: PendingUiState | null | undefined): boolean {
  if (!s) return false;
  if (Array.isArray(s.pendingQuestions) && s.pendingQuestions.length > 0) return true;
  if (s.pendingApproval) return true;
  if (s.pendingCompany) return true;
  if (s.pendingPagePlan) return true;
  const popup = s.pendingPopup;
  if (popup && !isNonBlockingPopupType(popup.type)) return true;
  return false;
}

/**
 * Règle serveur (GET /companies) : un build qui tourne ne peut pas attendre une
 * réponse. Un flag resté à 1 en base n'affiche donc jamais de rond jaune
 * pendant que l'IA travaille.
 */
export function showsAwaitingBadge(flag: boolean | number | null | undefined, buildRunning?: boolean | null): boolean {
  return !!flag && !buildRunning;
}
