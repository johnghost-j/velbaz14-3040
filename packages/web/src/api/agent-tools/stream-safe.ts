// ─── Diffusion sûre du texte en direct ───────────────────────────────────────
//
// Les prompts autorisent des balises internes ([WEB_SEARCH: …], [QUESTIONS]…,
// [BUILD_COMPANY], [POPUP]…) qui ne doivent JAMAIS s'afficher dans le chat.
// Quand on diffuse la réponse au fur et à mesure, un morceau peut couper une
// balise en deux (« [QUES » puis « TIONS] ») : on retient donc tout ce qui suit
// un « [ » susceptible d'ouvrir une balise et on ne le relâche que si la suite
// prouve que ce n'en est pas une (ex. un lien Markdown).

export const STREAM_HOLD_MARKERS = [
  '[WEB_SEARCH', '[QUESTIONS', '[/QUESTIONS', '[BUILD_COMPANY',
  '[POPUP', '[/POPUP', '[PLAN_DATA', '[CODE_', '[REASONING',
  '[CALENDAR', '[/CALENDAR', '[COIN_CHART', '[PREDICT',
];

export interface MarkerSafeEmitter {
  /** Ajoute un morceau de texte et diffuse ce qui est sûr à afficher. */
  (chunk: string): void;
  /** Repart de zéro (nouveau tour de l'agent : le brouillon précédent est jeté). */
  reset: () => void;
}

export function createMarkerSafeEmitter(onToken: (chunk: string) => void): MarkerSafeEmitter {
  let raw = '';
  let sent = 0;
  let stopped = false;
  const emit = ((chunk: string) => {
    if (stopped) return;
    raw += chunk;
    let hold = raw.length;
    // On examine chaque « [ » non encore diffusé, du plus ancien au plus récent :
    // un crochet anodin (lien Markdown, liste) est relâché, un début de balise
    // bloque la diffusion.
    let i = raw.indexOf('[', sent);
    while (i !== -1) {
      const upper = raw.slice(i).toUpperCase();
      if (STREAM_HOLD_MARKERS.some(m => upper.startsWith(m))) {
        // Vraie balise : tout ce qui suit est interne (JSON, données) → on
        // coupe DÉFINITIVEMENT la diffusion. Le texte final (post-traité)
        // arrivera de toute façon dans l'événement `token`.
        hold = i;
        stopped = true;
        break;
      }
      if (STREAM_HOLD_MARKERS.some(m => m.startsWith(upper))) {
        // Balise peut-être coupée en deux morceaux : on attend la suite.
        hold = i;
        break;
      }
      i = raw.indexOf('[', i + 1);
    }
    if (hold > sent) {
      const out = raw.slice(sent, hold);
      sent = hold;
      try { onToken(out); } catch { /* le client a coupé : sans effet */ }
    }
  }) as MarkerSafeEmitter;
  emit.reset = () => { raw = ''; sent = 0; stopped = false; };
  return emit;
}
