// ─── Passe d'interaction du QA live : bornes de temps ───────────────────────
// Avant, la passe d'interaction pouvait prendre 80 s sur UNE page :
//  - `innerText()` sans timeout → 30 s (défaut Playwright) dès qu'un bouton
//    était détaché/re-rendu par le clic précédent ;
//  - chaque bouton recouvert par une modale / un bandeau cookies attendait
//    2 s de timeout de clic pour rien (Playwright réessaie tant que la cible
//    est masquée).
// Ici : budget total par page, arrêt après N échecs consécutifs, et un test
// de recouvrement côté page pour sauter immédiatement un bouton masqué.

/** Budget total de la passe d'interaction (remplissage + clics) par page. */
export const QA_INTERACTION_BUDGET_MS = 12_000;
/** Au-delà de N clics ratés d'affilée, la page est jugée bloquée : on arrête. */
export const QA_MAX_CLICK_FAILURES = 3;
/** Timeout max d'un clic (les clics sains prennent quelques dizaines de ms). */
export const QA_CLICK_TIMEOUT_MS = 1_500;
/** Timeout de lecture d'un bouton (libellé + recouvrement). */
export const QA_PROBE_TIMEOUT_MS = 500;
/** Timeout de remplissage d'un champ. */
export const QA_FILL_TIMEOUT_MS = 1_000;

export interface InteractionBudget {
  /** ms restantes (jamais négatif). */
  left(): number;
  over(): boolean;
}

export function interactionBudget(totalMs: number, now: () => number = Date.now): InteractionBudget {
  const end = now() + totalMs;
  return {
    left: () => Math.max(0, end - now()),
    over: () => now() >= end,
  };
}

/** Timeout effectif d'une action : jamais au-delà du budget restant.
 *  Jamais 0 : pour Playwright, `timeout: 0` veut dire « attendre sans fin ». */
export function actionTimeout(maxMs: number, budget: InteractionBudget): number {
  return Math.max(1, Math.min(maxMs, budget.left()));
}

export type ClickDecision = "click" | "skip" | "stop";

/** Actions à ne pas déclencher en boucle (destruction, déconnexion). */
const DANGEROUS_LABEL = /suppr|delete|logout|déconne|log out|sign out/i;

/**
 * Décide quoi faire d'un bouton. `covered` = un autre élément (modale,
 * overlay, bandeau) intercepte le clic au centre du bouton : le cliquer ne
 * ferait qu'attendre le timeout.
 */
export function clickDecision(s: {
  budgetLeftMs: number;
  consecutiveFailures: number;
  label: string;
  covered: boolean;
}): ClickDecision {
  if (s.budgetLeftMs <= 0) return "stop";
  if (s.consecutiveFailures >= QA_MAX_CLICK_FAILURES) return "stop";
  if (s.covered) return "skip";
  if (DANGEROUS_LABEL.test(s.label)) return "skip";
  return "click";
}

export interface ButtonProbe {
  label: string;
  covered: boolean;
}

/**
 * Exécutée DANS la page (Playwright `locator.evaluate`). Amène le bouton au
 * centre de l'écran sans animation, puis regarde quel élément reçoit le clic
 * en son centre. Doit rester autonome (sérialisée vers le navigateur).
 */
export function probeButtonInPage(el: Element): ButtonProbe {
  const h = el as HTMLElement;
  const label = (h.innerText || h.getAttribute("aria-label") || h.getAttribute("title") || "").trim().slice(0, 40);
  h.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  const r = h.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { label, covered: true };
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { label, covered: !hit || !(h === hit || h.contains(hit)) };
}

/** Pages testées en même temps (onglets du même navigateur). La machine a
 *  peu de RAM/CPU : 2 suffit à recouvrir les attentes réseau/animations. */
export const QA_PAGE_CONCURRENCY = 2;

/**
 * Exécute `fn` sur chaque élément avec au plus `limit` exécutions en
 * parallèle. `shouldStop` est relu avant chaque nouvel élément (annulation).
 * Une erreur de `fn` est propagée (pas avalée).
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (shouldStop?.()) return;
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
