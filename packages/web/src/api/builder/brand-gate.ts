// ─── Porte « aperçu de marque » : quand le build doit-il attendre ? ─────────
// [2026-10-04] Bug signalé : « l'IA crée des images sur le site, mais pas du
// produit ». Mesuré sur un vrai projet (Paséo, marque de baskets Printify) :
//   −25 s  le pop-up de marque appelle POST /brand-preview (nom, produits, logo) ;
//    +0 s  le build démarre EN PARALLÈLE (mode automatique) et demande le
//          catalogue réel. L'ancienne attente ne regardait QUE le fichier cache
//          de l'aperçu — or ce fichier n'est écrit qu'à la FIN de
//          /brand-preview (logo compris, +42 s). Absent → « aucun aperçu en
//          cours » → catalogue lu VIDE tout de suite ;
//   +77 s  direction artistique : 3 visuels « sneaker » inventés, aucun produit
//          réel en référence ;
//   +85 s  validation de la marque → les 2 vraies baskets arrivent en base.
// Le site a donc été illustré par des chaussures génériques, pendant que les
// vraies baskets (mockups Printify) n'étaient branchées qu'à la toute fin.
//
// L'état « aperçu en cours » combine désormais les DEUX signaux réels :
//   1. une requête de l'aperçu (génération, produits, validation) est en vol ;
//   2. une proposition est en cache et le pop-up peut encore la valider
//      (le pop-up valide tout seul BRAND_AUTO_VALIDATE_MS après l'affichage).
// Module pur (aucun import serveur) : le pop-up lit ses délais ICI, donc
// serveur et client ne peuvent pas diverger.

/** Délai max de POST /brand-preview côté pop-up. */
export const BRAND_PREVIEW_TIMEOUT_MS = 150_000;
/** Délai max de POST /brand-preview/products côté pop-up. */
export const BRAND_PRODUCTS_TIMEOUT_MS = 180_000;
/** Le pop-up visible valide seul la proposition affichée après ce délai. */
export const BRAND_AUTO_VALIDATE_MS = 4 * 60 * 1000;
/** Marge réseau entre la dernière écriture du cache et l'auto-validation. */
export const BRAND_GATE_GRACE_MS = 30_000;
/** Borne dure : toutes les étapes du pop-up mises bout à bout, plus une marge. */
export const BRAND_GATE_MAX_WAIT_MS =
  BRAND_PREVIEW_TIMEOUT_MS + BRAND_PRODUCTS_TIMEOUT_MS + BRAND_AUTO_VALIDATE_MS + 2 * BRAND_GATE_GRACE_MS;

// Requêtes de l'aperçu en vol, par projet (compteur : plusieurs onglets).
const inFlight = new Map<string, number>();

/** Marque une requête de l'aperçu en cours ; appeler la fonction rendue à la fin. */
export function beginBrandPreviewWork(companyId: string): () => void {
  inFlight.set(companyId, (inFlight.get(companyId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (inFlight.get(companyId) ?? 1) - 1;
    if (n > 0) inFlight.set(companyId, n);
    else inFlight.delete(companyId);
  };
}

export function isBrandPreviewWorkInFlight(companyId: string): boolean {
  return (inFlight.get(companyId) ?? 0) > 0;
}

/** Middleware (Hono) : trace chaque POST de l'aperçu pendant toute sa durée. */
export async function trackBrandPreviewWork(
  c: { req: { method: string; param: (name: string) => string | undefined } },
  next: () => Promise<void>,
): Promise<void> {
  if (c.req.method !== "POST") return next();
  const end = beginBrandPreviewWork(String(c.req.param("id") || ""));
  try { await next(); } finally { end(); }
}

export interface BrandGateProbe {
  /** Une requête de l'aperçu tourne pour ce projet. */
  inFlight: boolean;
  /** Date (ms) de la dernière écriture du cache d'aperçu, null s'il n'existe pas. */
  cacheWrittenAt: number | null;
}

export type BrandGateState = "none" | "working" | "awaiting_validation" | "abandoned";

/** Pur : où en est l'aperçu de marque à l'instant `now`. */
export function brandGateState(p: BrandGateProbe, now: number): BrandGateState {
  if (p.inFlight) return "working";
  if (p.cacheWrittenAt == null) return "none";
  // Plus rien ne tourne et le délai d'auto-validation du pop-up est dépassé :
  // l'onglet est fermé, personne ne validera cette proposition.
  if (now - p.cacheWrittenAt > BRAND_AUTO_VALIDATE_MS + BRAND_GATE_GRACE_MS) return "abandoned";
  return "awaiting_validation";
}

export type BrandGateOutcome = "no_preview" | "resolved" | "abandoned" | "timeout" | "cancelled";

/**
 * Attend que l'aperçu de marque soit tranché (validé, abandonné ou fermé).
 * `onWait` est appelé à chaque changement d'état d'attente, pour l'annoncer.
 */
export async function waitForBrandGate(opts: {
  probe: () => BrandGateProbe;
  isCancelled?: () => boolean;
  onWait?: (state: "working" | "awaiting_validation") => void;
  maxWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ outcome: BrandGateOutcome; waitedMs: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWaitMs = opts.maxWaitMs ?? BRAND_GATE_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? 2000;
  const t0 = now();
  let last: BrandGateState | null = null;
  for (;;) {
    const waitedMs = now() - t0;
    const state = brandGateState(opts.probe(), now());
    if (state === "none") return { outcome: last === null ? "no_preview" : "resolved", waitedMs };
    if (state === "abandoned") return { outcome: "abandoned", waitedMs };
    if (opts.isCancelled?.()) return { outcome: "cancelled", waitedMs };
    if (waitedMs > maxWaitMs) return { outcome: "timeout", waitedMs };
    if (state !== last) opts.onWait?.(state);
    last = state;
    await sleep(pollMs);
  }
}
