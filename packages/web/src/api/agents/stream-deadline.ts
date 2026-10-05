// ─── Flux IA qui ne répond JAMAIS : détecté en secondes, pas en 5 minutes ────
//
// [2026-10-04] MESURÉ (table ai_usage_events) : une requête stream vers le
// Runable Gateway (openai/gpt-6-luna, compte Free, « cret moi une mark de
// chaussure ») est restée 299 999 ms sans renvoyer UN SEUL octet, puis :
//   « Gateway request failed: The operation was aborted due to timeout ».
// Les 4 appels identiques autour ont répondu en 2 à 6 s (1er mot en 1,1 à
// 2,4 s). Le seul garde-fou était le plafond global de 5 min (fait pour ne pas
// couper un modèle qui réfléchit ou écrit longtemps) : l'utilisateur restait
// bloqué 5 min sur « Analyse de ton idée et préparation du plan ».
//
// Une requête qui n'a encore rien renvoyé (ni en-têtes, ni début de
// raisonnement, ni texte) n'est pas « un modèle qui réfléchit » : elle est
// bloquée. On la coupe donc après `firstPartMs` et on la relance sur une
// connexion neuve. Dès qu'un premier morceau arrive, seul le plafond global
// s'applique : un modèle lent mais vivant n'est jamais interrompu.

export interface StreamPartLike {
  type: string;
  text?: string;
  error?: unknown;
}

export interface DeadlineStreamOptions {
  /** Démarre UN flux avec ce signal d'annulation. */
  start: (signal: AbortSignal) => AsyncIterable<StreamPartLike>;
  onText: (chunk: string) => void;
  /** Délai max avant le premier morceau (tout type sauf « start », local au SDK). */
  firstPartMs: number;
  /** Plafond global d'une tentative. */
  totalMs: number;
  /** Tentatives quand le flux est resté muet (défaut 2). */
  attempts?: number;
  label: string;
  log?: (msg: string) => void;
}

export interface DeadlineStreamResult {
  text: string;
  /** Toutes les tentatives sont restées muettes jusqu'au délai. */
  stalled: boolean;
  /** Dernière erreur vue (partie « error » ou exception). */
  error?: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function streamWithFirstPartDeadline(o: DeadlineStreamOptions): Promise<DeadlineStreamResult> {
  const attempts = Math.max(1, o.attempts ?? 2);
  const log = o.log ?? ((m: string) => console.log(m));
  let lastError: string | undefined;
  let stalled = false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(o.totalMs)]);
    let gotPart = false;
    stalled = false;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      if (gotPart) return;
      stalled = true;
      ac.abort(new Error(`FIRST_PART_TIMEOUT: ${o.label} muet depuis ${o.firstPartMs} ms`));
    }, o.firstPartMs);

    let text = '';
    try {
      for await (const part of o.start(signal)) {
        if (part.type !== 'start') gotPart = true;
        if (part.type === 'text-delta' && part.text) {
          text += part.text;
          o.onText(part.text);
        } else if (part.type === 'error') {
          lastError = errText(part.error);
        }
      }
    } catch (e) {
      lastError = errText(e);
    } finally {
      clearTimeout(timer);
    }

    if (text.trim()) return { text: text.trim(), stalled: false, error: lastError };
    if (!stalled) {
      // Flux terminé (vide ou en erreur) sans être muet : pas de relance ici,
      // l'appelant passe à la génération classique et à ses modèles de secours.
      log(`[stream-deadline] ${o.label} : flux terminé sans texte en ${Date.now() - startedAt} ms${lastError ? ` (${lastError.slice(0, 160)})` : ''}`);
      return { text: '', stalled: false, error: lastError };
    }
    log(`[stream-deadline] ${o.label} : aucune réponse du fournisseur en ${o.firstPartMs} ms (tentative ${attempt}/${attempts}) → ${attempt < attempts ? 'relance' : 'abandon du flux'}`);
  }
  return { text: '', stalled: true, error: lastError };
}
