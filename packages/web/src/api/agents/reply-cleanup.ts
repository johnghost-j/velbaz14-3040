// ─────────────────────────────────────────────────────────────────────────────
// Nettoyage des fuites de contexte système
// ─────────────────────────────────────────────────────────────────────────────
// [2026-09-19] Des lignes de contexte interne apparaissaient à l'écran, soit en
// tête de réponse (recopiées telles quelles par le modèle), soit collées à un
// libellé d'étape :
//   « Current date: 2026-09-19 »
//   « Analyse du contexte du projetCurrent date: 2026-09-19 »
// Ce sont des instructions internes, jamais destinées à l'utilisateur.
// Une phrase normale qui MENTIONNE la date (« Aujourd'hui, 19 septembre… ») est
// conservée : les motifs exigent l'étiquette du prompt système.

/** Ligne qui n'est QUE une étiquette de contexte (date/heure système). */
const CONTEXT_LINE =
  /^\s*[-*•]?\s*(?:current\s+date|date\s+actuelle|current\s+time(?:\s*\(utc\))?|heure\s+actuelle|contexte\s+temporel)\s*[:：].*$/i;

/** Même étiquette, repérée n'importe où dans une chaîne (libellé d'étape). */
const CONTEXT_FRAGMENT =
  /[-*•]?\s*(?:current\s+date|date\s+actuelle|current\s+time(?:\s*\(utc\))?|heure\s+actuelle|contexte\s+temporel)\s*[:：][\s\S]*/i;

/**
 * Nettoie un LIBELLÉ d'étape : une seule ligne, sans fragment de contexte
 * système collé à la fin. On coupe à la première étiquette rencontrée.
 */
export function sanitizeStepLabel(label: string): string {
  if (!label) return label;
  // Une étape tient sur une ligne : ce qui suit un saut de ligne est parasite.
  let out = label.split(/[\r\n]/)[0] || '';
  out = out.replace(CONTEXT_FRAGMENT, '').trim();
  // Caractère orphelin laissé par la coupure (« …projetù »).
  out = out.replace(/[\s\-–—:·•ù]+$/u, '').trim();
  return out || label.trim();
}

/**
 * Retire les lignes d'étiquette de contexte (date/heure système) situées au
 * tout début ou à la toute fin de la réponse. Le corps du message n'est jamais
 * touché : une telle ligne au milieu d'un texte fait partie de la réponse.
 *
 * [2026-09-19] Cas signalé : la réponse ENTIÈRE valait « Current date:
 * 2026-09-19 ». On renvoie alors une chaîne VIDE (il n'y a rien à montrer) —
 * c'est à l'appelant de substituer un message lisible via `cleanReply`.
 */
export function stripLeakedContext(reply: string): string {
  if (!reply) return reply;
  const lines = reply.split('\n');

  let start = 0;
  while (start < lines.length && CONTEXT_LINE.test(lines[start]!)) start++;
  // Blancs laissés par les lignes retirées.
  if (start > 0) {
    while (start < lines.length && lines[start]!.trim() === '') start++;
  }

  let end = lines.length;
  while (end > start && CONTEXT_LINE.test(lines[end - 1]!.trimEnd())) end--;
  if (end < lines.length) {
    while (end > start && lines[end - 1]!.trim() === '') end--;
  }

  const out = lines.slice(start, end).join('\n');
  // Plus rien après nettoyage → la réponse n'était QUE du contexte système.
  return out.trim() ? out : '';
}

/** Repli FR/EN quand la réponse ne contenait aucun contenu utilisable. */
const EMPTY_REPLY_FALLBACK = {
  fr: "Petit raté de mon côté : ma réponse est partie vide. Redis-moi ce que tu veux et j'enchaîne.",
  en: "My bad — my answer came back empty. Tell me again what you need and I'll pick it right up.",
};

/** Détection FR sommaire, suffisante pour choisir la langue d'un repli. */
function looksFrench(text: string): boolean {
  return /\b(je|tu|nous|vous|une?|les?|des?|est|sont|dans|avec|pour|sur|pas|qui|que|mon|ton|salut|bonjour|merci|oui|non|fais|crée|corrige|veux)\b/i
    .test(String(text || ''));
}

/**
 * Réponse prête à afficher : contexte système retiré et, si plus rien ne reste
 * (réponse = uniquement « Current date: … »), un message lisible à la place —
 * l'utilisateur ne doit JAMAIS voir une étiquette de prompt comme réponse.
 */
export function cleanReply(reply: string, userMessage?: string): string {
  const cleaned = stripLeakedContext(String(reply || '')).trim();
  if (cleaned) return cleaned;
  return looksFrench(userMessage || reply || '') ? EMPTY_REPLY_FALLBACK.fr : EMPTY_REPLY_FALLBACK.en;
}
