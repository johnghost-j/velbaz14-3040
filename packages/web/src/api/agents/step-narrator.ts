// ─────────────────────────────────────────────────────────────────────────────
// Émission des étapes de travail de l'IA
// ─────────────────────────────────────────────────────────────────────────────
// [2026-09-19] La narration bavarde a été RETIRÉE. Avant, chaque changement
// d'étape était doublé d'une phrase de transition (« Je m'y mets tout de
// suite — Lecture de ta demande. », « ✅ Lecture de ta demande : c'est fait.
// J'enchaîne — Compréhension de la demande. »…). Résultat à l'écran : chaque
// étape apparaissait DEUX fois (la phrase puis le libellé), le démarrage était
// noyé sous trois lignes de blabla avant le moindre travail réel.
//
// Ce module relaie désormais chaque étape telle quelle : la liste cochée
// (✓ terminé / spinner en cours) suffit à dire où en est le travail.

import { sanitizeStepLabel } from "./reply-cleanup";

export interface NarratedStep {
  id: string;
  label: string;
  /**
   * Champ conservé pour compatibilité : une note EXPLICITE fournie par
   * l'appelant est toujours relayée. Plus rien n'en génère automatiquement.
   */
  note?: string;
  preview?: any;
  [k: string]: any;
}

/**
 * Enveloppe un émetteur de progression.
 *
 * ```ts
 * const emitStep = createStepNarrator((step) => send({ progress: step }));
 * emitStep({ id: 'understand', label: 'Compréhension de la demande' });
 * ```
 */
export function createStepNarrator(
  emit: (step: NarratedStep) => void,
): ((step: NarratedStep) => void) & { finish: () => void } {
  // Garde-fou minimal conservé : deux appels consécutifs pour la MÊME étape
  // (relance, reprise) ne doivent pas dupliquer la ligne. Le client dédoublonne
  // aussi de son côté, ce filtre évite juste le trafic inutile.
  let prevLabel = '';
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  const narrate = (step: NarratedStep) => {
    // Le libellé ne doit JAMAIS transporter de contexte système collé
    // (« Analyse du contexte du projetCurrent date: 2026-09-19 »).
    const label = sanitizeStepLabel(String(step.label || ''));
    if (!label) return;
    // Dédoublonnage sur le LIBELLÉ seulement : un même id peut légitimement
    // porter un libellé différent (ex. 'write' → « Rédaction de la réponse »
    // puis « Recherche et rédaction de la réponse »).
    if (norm(label) === prevLabel) return;
    prevLabel = norm(label);
    emit({ ...step, label });
  };

  // Plus de phrase de clôture : la réponse elle-même arrive juste après.
  narrate.finish = () => { /* no-op */ };

  return narrate;
}
