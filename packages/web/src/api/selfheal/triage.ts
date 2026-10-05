// ─── Tri des erreurs : qu'est-ce qui mérite un correctif automatique ? ──────
//
// 95 % de ce qui atterrit dans error_logs n'est PAS un bug de code : une API
// tierce qui répond 429, un timeout réseau, une clé absente, un 404 attendu,
// une erreur de build d'un site généré. Patcher là-dessus, c'est du code mort
// ajouté à chaque incident réseau. Ce fichier ne garde que ce qui ressemble
// réellement à un défaut du code de Velbaz, localisable dans un fichier.
//
import { criticalFileReason, PATCHABLE_ROOT } from './guard';

export interface RawError {
  id?: string;
  source: string;           // runtime | agent | job | api | build | sentry
  level?: string | null;
  message: string;
  stack?: string | null;
  companyId?: string | null;
  metadata?: string | null;
}

export interface TriagedError {
  fingerprint: string;
  message: string;
  stack: string | null;
  /** Fichier fautif, relatif à la racine du dépôt. */
  targetFile: string;
  targetLine: number | null;
  /** Frames du dépôt, dans l'ordre de la pile. */
  frames: { file: string; line: number; col: number | null }[];
}

export type TriageResult =
  | { eligible: true; error: TriagedError }
  | { eligible: false; reason: string };

// ── Bruit opérationnel : pas un bug de code ─────────────────────────────────
const NOISE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\b(429|rate ?limit|too many requests|quota|throttl)/i, why: 'limite de débit d’un service tiers' },
  { re: /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up)\b/i, why: 'incident réseau' },
  { re: /\b(fetch failed|network error|timeout|timed out|aborted)\b/i, why: 'timeout ou requête interrompue' },
  { re: /\b(overloaded|service unavailable|503|502|504|bad gateway)\b/i, why: 'service tiers indisponible' },
  { re: /\b(401|403|unauthorized|forbidden|invalid api key|authentication)\b/i, why: 'identifiants ou droits — pas un bug de code' },
  { re: /\b(404|not found)\b/i, why: 'ressource absente (souvent attendu)' },
  { re: /\b(insufficient|no tokens|balance|payment required|402)\b/i, why: 'crédits ou facturation' },
  { re: /\b(SQLITE_BUSY|database is locked|stream is locked)\b/i, why: 'contention base de données (transitoire)' },
  { re: /\bAbortError\b|\bclosed\b.*\bcontroller\b/i, why: 'client déconnecté en cours de réponse' },
  // Journaux volontaires de Velbaz qui passent par console.error sans être des bugs.
  { re: /^\[(fulfillment|auto-heartbeat|comms\/learning|gateway|selfheal)\]/i, why: 'journal applicatif volontaire, non bloquant' },
  { re: /\bnon bloquant\b|\brepli\b|\bfallback\b/i, why: 'erreur déjà rattrapée par un repli' },
];

// ── Signatures de vrais défauts de code ─────────────────────────────────────
// Un de ces motifs doit être présent : ce sont les erreurs qu'un correctif de
// code peut réellement résoudre.
const CODE_BUG_PATTERNS: RegExp[] = [
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bRangeError\b/,
  /\bSyntaxError\b/,
  /is not a function\b/,
  /is not defined\b/,
  /Cannot read propert(y|ies) of (undefined|null)\b/,
  /Cannot access .* before initialization\b/,
  /undefined is not an object\b/,
  /\bof undefined\b/,
  /\bNaN\b.*\b(invalid|error)\b/i,
  /Assignment to constant variable\b/,
  /Converting circular structure to JSON\b/,
  /Maximum call stack size exceeded\b/,
  /\bJSON\.parse\b.*\b(unexpected|invalid)\b/i,
  /Unexpected token\b/,
];

/** Pile d'appel → frames appartenant au dépôt. */
export function extractFrames(stack: string): { file: string; line: number; col: number | null }[] {
  const out: { file: string; line: number; col: number | null }[] = [];
  const seen = new Set<string>();
  // Formats couverts : "at fn (/abs/path/file.ts:12:5)", "/abs/path:12:5",
  // "at file:///abs/path/file.ts:12:5", et les chemins relatifs du dépôt.
  const re = /(?:file:\/\/)?((?:\/home\/user\/velbaz\/)?packages\/web\/src\/[^\s():]+\.tsx?):(\d+)(?::(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stack)) !== null) {
    let file = m[1];
    const abs = '/home/user/velbaz/';
    if (file.startsWith(abs)) file = file.slice(abs.length);
    const key = `${file}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line: Number(m[2]), col: m[3] ? Number(m[3]) : null });
  }
  return out;
}

/** Empreinte stable : deux occurrences du même bug donnent la même valeur. */
export function fingerprint(message: string, frames: { file: string; line: number }[]): string {
  const normalized = message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{10,}\b/g, '<ts>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const top = frames[0] ? `${frames[0].file}:${frames[0].line}` : 'nostack';
  // Hash court et déterministe (djb2) — pas besoin de crypto ici.
  let h = 5381;
  const input = `${normalized}|${top}`;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return `sh_${(h >>> 0).toString(36)}`;
}

/**
 * Décide si une erreur est candidate à un correctif automatique.
 * Refuse par défaut : mieux vaut ignorer un bug réparable que patcher du bruit.
 */
export function triage(raw: RawError): TriageResult {
  const message = (raw.message || '').trim();
  if (!message) return { eligible: false, reason: 'message vide' };

  // Hors périmètre : les erreurs des sites/apps générés pour les clients.
  // L'utilisateur a demandé l'auto-réparation de Velbaz lui-même uniquement.
  if (raw.source === 'build') return { eligible: false, reason: 'erreur de build d’un projet généré (hors périmètre)' };
  if (raw.companyId) return { eligible: false, reason: 'erreur rattachée à une entreprise générée (hors périmètre)' };

  for (const { re, why } of NOISE_PATTERNS) {
    if (re.test(message)) return { eligible: false, reason: why };
  }

  const stack = (raw.stack || '').trim() || null;
  // Le message lui-même contient souvent la pile (console.error(err)).
  const frames = extractFrames(`${message}\n${stack || ''}`);
  if (frames.length === 0) {
    return { eligible: false, reason: `aucune frame dans ${PATCHABLE_ROOT}/ — origine du bug non localisable` };
  }

  const isCodeBug = CODE_BUG_PATTERNS.some(re => re.test(message)) ||
    (stack ? CODE_BUG_PATTERNS.some(re => re.test(stack)) : false);
  if (!isCodeBug) {
    return { eligible: false, reason: 'signature non reconnue comme défaut de code' };
  }

  // Première frame patchable de la pile : c'est là que le correctif doit aller.
  const target = frames.find(f => criticalFileReason(f.file) === null);
  if (!target) {
    const why = criticalFileReason(frames[0].file);
    return { eligible: false, reason: `origine dans un fichier protégé — ${frames[0].file} : ${why}` };
  }

  return {
    eligible: true,
    error: {
      fingerprint: fingerprint(message, frames),
      message: message.slice(0, 4000),
      stack: stack ? stack.slice(0, 6000) : null,
      targetFile: target.file,
      targetLine: target.line,
      frames: frames.slice(0, 8),
    },
  };
}
