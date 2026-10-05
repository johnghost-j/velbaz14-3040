/**
 * Barre de prompt — limite de longueur et texte collé en pièce jointe.
 *
 * [2026-09-19] Deux comportements DISTINCTS, souvent confondus :
 *
 *  • Texte TAPÉ au-delà de `MAX_PROMPT_CHARS` → l'envoi est refusé, avec un
 *    message d'erreur qui donne le compte exact. Le texte reste dans le champ :
 *    l'utilisateur ne perd rien, il raccourcit.
 *
 *  • Texte COLLÉ au-delà de `MAX_PROMPT_CHARS` → il n'est PAS refusé. Coller un
 *    mur de texte rendait la barre inutilisable et l'envoi impossible, alors que
 *    c'est un usage parfaitement légitime (un cahier des charges, une page de
 *    contenu, un export). Il devient donc une pièce jointe `.txt`, cliquable
 *    pour être relue en entier (`TextAttachmentViewer`), et l'IA la lit comme un
 *    fichier — ce qui lui est plus lisible qu'un bloc noyé dans la conversation.
 *
 * Partagé entre la page d'accueil et le chat : les deux barres de prompt
 * doivent se comporter à l'identique.
 */
import { useEffect, useState } from 'react';
import { useI18n } from './i18n';

/** Au-delà : un prompt tapé est refusé, un texte collé devient un fichier. */
export const MAX_PROMPT_CHARS = 5000;

/** Seuil d'apparition du compteur de caractères sous la barre. */
export const PROMPT_COUNTER_THRESHOLD = MAX_PROMPT_CHARS - 500;

/**
 * Hauteur maximale du champ de prompt, en pixels. Au-delà, il ne grandit plus
 * et on défile dedans.
 *
 * [2026-09-19] Une SEULE source de vérité, volontairement : le plafond était
 * écrit deux fois, dans le JS qui fixe la hauteur (200) et dans le `maxHeight`
 * CSS (140). Le JS posait donc une hauteur que le CSS rognait, sans jamais
 * activer le défilement (le test se faisait sur 200) : entre 140 et 200 px, le
 * texte était coupé ET impossible à faire défiler.
 */
export const PROMPT_MAX_HEIGHT = 200;

/**
 * Ajuste la hauteur du champ à son contenu, jusqu'à `PROMPT_MAX_HEIGHT`, puis
 * rend le champ défilable. À rappeler à CHAQUE changement de valeur, pas
 * seulement à la frappe : dictée vocale, texte suggéré, brouillon restauré et
 * commande « / » remplacent la valeur sans passer par `onChange`.
 */
export function autosizePromptTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  const needed = el.scrollHeight;
  el.style.height = Math.min(needed, PROMPT_MAX_HEIGHT) + 'px';
  el.style.overflowY = needed > PROMPT_MAX_HEIGHT ? 'auto' : 'hidden';
}

export interface PromptAttachment {
  id: string;
  name: string;
  mimeType: string;
  data: string; // data URI complet
  size: number;
  type: 'image' | 'document' | 'text';
  previewUrl?: string;
}

/** Encode en base64 un texte UTF-8 (btoa seul casse sur accents/emoji/CJK). */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  // Par tranches : `String.fromCharCode(...bytes)` explose la pile sur un gros
  // texte collé (RangeError au-delà de ~100 ko).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Fabrique la pièce jointe .txt correspondant à un gros texte collé. */
export function pastedTextAttachment(text: string, label: string, index: number): PromptAttachment {
  const base = label.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'texte';
  const bytes = new TextEncoder().encode(text);
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: `${base}-${index}.txt`,
    mimeType: 'text/plain',
    data: `data:text/plain;base64,${toBase64Utf8(text)}`,
    size: bytes.length,
    type: 'text',
  };
}

/** Décode une pièce jointe texte (data URI base64) pour l'afficher. */
export function decodeTextAttachment(att: { data: string }): string {
  try {
    const base64 = String(att.data).split(',')[1] || '';
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch { return ''; }
}

/**
 * Gère le collage dans une barre de prompt.
 * Renvoie `true` si le collage a été transformé en pièce jointe (donc
 * `preventDefault()` a été appelé et le texte ne doit PAS entrer dans le champ).
 */
export function handleLongTextPaste(
  e: React.ClipboardEvent<HTMLTextAreaElement>,
  opts: { label: string; index: number; onAttach: (att: PromptAttachment) => void; onNotice?: (chars: number) => void },
): boolean {
  const pasted = e.clipboardData?.getData('text/plain') || '';
  if (pasted.length <= MAX_PROMPT_CHARS) return false;
  e.preventDefault();
  opts.onAttach(pastedTextAttachment(pasted, opts.label, opts.index));
  opts.onNotice?.(pasted.length);
  return true;
}

function TextFileIcon() {
  return (
    <svg className="w-4 h-4" style={{ color: 'var(--text-ghost)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /><path d="M9 9h1" /><path d="M9 13h6" /><path d="M9 17h6" />
    </svg>
  );
}

/**
 * Visionneuse d'une pièce jointe texte : clic sur la puce → contenu en entier,
 * sans jamais le remettre dans la barre de prompt.
 */
export function TextAttachmentViewer({ name, content, onClose }: { name: string; content: string; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl shadow-2xl flex flex-col w-full"
        style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', maxWidth: 820, maxHeight: '82vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3.5 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="w-8 h-8 flex items-center justify-center shrink-0 rounded" style={{ background: 'var(--surface-3)' }}>
            <TextFileIcon />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{name}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {t('prompt.viewer.chars', { count: String(content.length) })}
            </div>
          </div>
          <button
            type="button"
            onClick={async () => {
              try { await navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
            }}
            className="h-8 px-3 rounded-lg text-[12.5px] shrink-0 transition-all hover:opacity-80"
            style={{ background: 'var(--surface-3)', color: 'var(--text-dim)' }}
          >{copied ? t('prompt.viewer.copied') : t('prompt.viewer.copy')}</button>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all hover:opacity-80"
            style={{ background: 'var(--surface-3)', color: 'var(--text-dim)' }}
            title={t('prompt.viewer.close')}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none"><path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
          </button>
        </div>
        <div className="overflow-auto px-5 py-4">
          <pre
            className="text-[12.5px] leading-relaxed whitespace-pre-wrap break-words font-mono"
            style={{ color: 'var(--text-secondary)', margin: 0 }}
          >{content}</pre>
        </div>
      </div>
    </div>
  );
}

/** Compteur de caractères : visible seulement à l'approche de la limite. */
export function PromptCharCounter({ length, right }: { length: number; right: number }) {
  if (length <= PROMPT_COUNTER_THRESHOLD) return null;
  return (
    <div
      className="absolute text-[11px] tabular-nums pointer-events-none"
      style={{ right, bottom: -2, color: length > MAX_PROMPT_CHARS ? 'var(--danger, #ef4444)' : 'var(--text-ghost)' }}
    >
      {length} / {MAX_PROMPT_CHARS}
    </div>
  );
}
