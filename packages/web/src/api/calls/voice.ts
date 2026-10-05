// ─── Voix Bland : appels réels + lecture des répliques dans le chat ─────────
//
// Les répliques d'un appel (simulé ou réel) sont lues avec la synthèse vocale
// de Bland (POST https://api.bland.ai/v2/tts) au lieu de la voix robotique du
// navigateur. L'endpoint n'accepte que des voix BTTS_V2 / BTTS_V3 (les voix
// « LEGACY » répondent 400 unsupported_voice).
//
// Voix choisies (vérifiées le 2026-10-01 : 200 + transcription française
// exacte) :
//   • IA, français   : Océane Descat (EN+FR), BTTS_V3
//   • contact, fr    : Pierre, BTTS_V2 (voix masculine neutre)
//   • IA, anglais    : Karen, BTTS_V3 (voix par défaut de Bland)
//   • contact, en    : Brad « Warm Professional », BTTS_V3
// Surcharge possible via les secrets BLAND_VOICE_FR / BLAND_VOICE_EN (voix
// de l'IA, appels réels compris).

import { getSecret } from '../secret-store';

export const VOICES = {
  fr: { ai: '28a2d179-b00f-48a7-958d-1e8c27eae59d', contact: '78fd3e75-6147-4cf7-b4d8-7f6bc9fe5f74' },
  en: { ai: '29158307-9893-4149-8a75-bc9ce313d64e', contact: '36526d1a-9b3a-4309-83c6-8aaaa758adad' },
} as const;

export type VoiceRole = 'ai' | 'contact';
const langOf = (language?: string | null): 'fr' | 'en' => (/^en/i.test(String(language || '')) ? 'en' : 'fr');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Voix Bland pour un rôle et une langue (l'IA peut être surchargée par secret). */
export function blandVoiceFor(role: VoiceRole, language?: string | null): string {
  const lang = langOf(language);
  if (role === 'ai') {
    const custom = (getSecret(lang === 'en' ? 'BLAND_VOICE_EN' : 'BLAND_VOICE_FR') || '').trim();
    if (custom) return custom;
  }
  return VOICES[lang][role];
}

/** Voix de l'agent pour un vrai appel Bland (remplace l'ancien « maya », anglais). */
export const callVoice = (language?: string | null) => blandVoiceFor('ai', language);

// ── Synthèse ────────────────────────────────────────────────────────────────

export const TTS_MAX_CHARS = 1200;
const CACHE_MAX = 300;
const cache = new Map<string, Uint8Array>();
const inflight = new Map<string, Promise<TtsResult>>();

export type TtsResult = { ok: true; audio: Uint8Array } | { ok: false; status: number; error: string };

/** Nettoie le texte avant lecture (markdown, espaces) et le borne. */
export function ttsText(text: string): string {
  return String(text || '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TTS_MAX_CHARS);
}

/**
 * Texte → WAV 24 kHz via Bland. Mis en cache (mémoire) par voix + texte :
 * une même réplique relue (rechargement, deuxième onglet) ne coûte rien.
 */
export async function synthesize(rawText: string, voice: string, fetchImpl: typeof fetch = fetch): Promise<TtsResult> {
  const text = ttsText(rawText);
  if (!text) return { ok: false, status: 400, error: 'Texte vide' };
  if (!UUID.test(voice)) return { ok: false, status: 400, error: 'Voix invalide' };
  const apiKey = getSecret('BLAND_API_KEY') || '';
  if (!apiKey) return { ok: false, status: 503, error: 'Clé Bland absente' };
  const k = `${voice}\u0000${text}`;
  const hit = cache.get(k);
  if (hit) { cache.delete(k); cache.set(k, hit); return { ok: true, audio: hit }; }
  const running = inflight.get(k);
  if (running) return running;
  const p = (async (): Promise<TtsResult> => {
    try {
      const r = await fetchImpl('https://api.bland.ai/v2/tts', {
        method: 'POST',
        headers: { authorization: apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice, audio: { container: 'wav', sample_rate: 24000 } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) {
        const j: any = await r.json().catch(() => ({}));
        return { ok: false, status: r.status >= 500 ? 502 : r.status, error: j?.error?.message || `Bland TTS ${r.status}` };
      }
      const audio = new Uint8Array(await r.arrayBuffer());
      if (audio.byteLength < 100) return { ok: false, status: 502, error: 'Audio vide' };
      cache.set(k, audio);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return { ok: true, audio };
    } catch (e: any) {
      return { ok: false, status: 502, error: e?.message || 'Bland TTS injoignable' };
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

// ── Garde-fou de volume (par utilisateur, en mémoire) ───────────────────────

const WINDOW_MS = 60 * 60_000;
export const TTS_PER_HOUR = 400;
const usage = new Map<string, number[]>();

/** true si l'utilisateur peut encore lancer une synthèse cette heure-ci. */
export function ttsAllowed(userId: string, now = Date.now()): boolean {
  const list = (usage.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= TTS_PER_HOUR) { usage.set(userId, list); return false; }
  list.push(now);
  usage.set(userId, list);
  return true;
}

export function _resetVoiceState() { cache.clear(); inflight.clear(); usage.clear(); }
