"use client";

/* ─────────────────────────────────────────────────────────────────────────
 * LIVE CALL CARD — l'IA téléphone à quelqu'un, en direct dans le chat.
 *
 * Demande utilisateur (2026-10-01) : « quand l'IA appelle quelqu'un, il y a
 * une animation dans le chat, j'entends la voix de l'IA et celle de la
 * personne, et pendant que l'IA parle je peux lui écrire pour comprendre ou
 * changer ce qu'elle dit ».
 *
 * Tout l'état vient du serveur (flux SSE /api/live-calls/:id/stream) :
 *   • event  → une ligne du journal (ai, contact, user, note, directive, system)
 *   • state  → l'état de l'appel (statut, durée, résumé, enregistrement)
 *   • end    → fin du flux
 * Le navigateur ne fait que l'afficher. Les consignes privées partent sur
 * POST /live-calls/:id/instruct : l'IA répond en privé (note) et transmet
 * une consigne courte à l'IA au téléphone (directive).
 *
 * Audio :
 *   • appel réel (Bland) : WebSocket d'écoute, PCM 16 bits 16 kHz mono, joué
 *     par Web Audio. Le flux mélange les deux voix : l'animation « qui parle »
 *     suit donc la transcription, son amplitude suit le vrai niveau sonore ;
 *   • simulation : chaque réplique est lue avec une voix Bland (TTS v2/v3,
 *     POST /api/live-calls/:id/tts), une voix pour l'IA et une autre pour le
 *     contact ; la synthèse du navigateur ne sert que de secours.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authHeaders } from '../lib/token';
import { clock, commsJson, initials, prettyPhone } from '../lib/comms-context';
import './LiveCallCard.css';

export interface CallViewData { id?: string }

type Kind = 'ai' | 'contact' | 'user' | 'note' | 'directive' | 'system';
interface CallEvent { id: number; kind: Kind; text: string; at: number }
interface CallState {
  id: string;
  mode: 'bland' | 'sim';
  phone: string;
  contactName: string | null;
  goal: string;
  language: string;
  status: 'dialing' | 'ringing' | 'live' | 'ended' | 'failed' | 'canceled';
  error: string | null;
  summary: string | null;
  recordingUrl: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  direction?: 'out' | 'in';
  inboundState?: 'pending' | 'auto' | 'accepted' | 'declined' | 'timeout' | null;
  ringUntil?: number | null;
}

const TERMINAL = new Set(['ended', 'failed', 'canceled']);
const BARS = 34;
/** Durée de parole estimée (même formule que le serveur, sans la marge). */
const speakEstimate = (t: string) => Math.max(1400, Math.min(14000, t.length * 75));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


// ── Lecture PCM 16 kHz (écoute d'un vrai appel) ─────────────────────────────

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class PcmPlayer {
  ctx: AudioContext;
  analyser: AnalyserNode;
  private gain: GainNode;
  private t = 0;
  constructor() {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }
  push(bytes: Uint8Array) {
    const n = Math.floor(bytes.byteLength / 2);
    if (!n) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const buf = this.ctx.createBuffer(1, n, 16000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const now = this.ctx.currentTime;
    // Petit tampon (120 ms) pour absorber la gigue réseau sans trop de retard.
    if (this.t < now + 0.03) this.t = now + 0.12;
    src.start(this.t);
    this.t += buf.duration;
  }
  level(): number {
    const a = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(a);
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const v = (a[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / a.length) * 4);
  }
  close() { try { void this.ctx.close(); } catch { /* déjà fermé */ } }
}

// ── Synthèse vocale du navigateur (secours) ────────────────────────────────────────────

function pickVoices(lang: string): { ai: SpeechSynthesisVoice | null; contact: SpeechSynthesisVoice | null } {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return { ai: null, contact: null };
  const all = window.speechSynthesis.getVoices();
  const pref = lang === 'en' ? 'en' : 'fr';
  const list = all.filter((v) => v.lang?.toLowerCase().startsWith(pref));
  const pool = list.length ? list : all;
  if (!pool.length) return { ai: null, contact: null };
  const rank = (v: SpeechSynthesisVoice) => (/google|natural|neural|premium|enhanced/i.test(v.name) ? 0 : 1);
  const sorted = [...pool].sort((a, b) => rank(a) - rank(b));
  return { ai: sorted[0] || null, contact: sorted.find((v) => v !== sorted[0]) || sorted[0] || null };
}

// ── Composant ───────────────────────────────────────────────────────────────

export default function LiveCallCard({ data }: { data: CallViewData }) {
  const id = String(data?.id || '');
  const [call, setCall] = useState<CallState | null>(null);
  const [events, setEvents] = useState<CallEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<{ who: 'ai' | 'contact'; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [hanging, setHanging] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [listening, setListening] = useState(false);
  const [listenErr, setListenErr] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(true);

  const mountedAt = useRef(Date.now());
  const seen = useRef(new Set<number>());
  const listeningRef = useRef(false);
  const callRef = useRef<CallState | null>(null);
  callRef.current = call;
  const wavesRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const rafRef = useRef<number | null>(null);
  const ttsActive = useRef(0);

  const isTerminal = !!call && TERMINAL.has(call.status);
  const isLive = call?.status === 'live';

  // ── Voix des répliques ────────────────────────────────────────────────────
  // Chaque réplique est lue avec une voix Bland (POST /tts → WAV), dans
  // l'ordre, l'une après l'autre. La synthèse du navigateur ne sert plus que
  // de secours (pas de clé Bland, Bland injoignable).
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const finishClipRef = useRef<(() => void) | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const genRef = useRef(0);
  const stopRef = useRef<() => void>(() => {});

  /** Secours : synthèse du navigateur. Résout à la fin de la phrase. */
  const speakBrowser = useCallback((who: 'ai' | 'contact', text: string) => new Promise<void>((resolve) => {
    if (!('speechSynthesis' in window)) {
      setSpeaking({ who, until: Date.now() + speakEstimate(text) });
      resolve();
      return;
    }
    const c = callRef.current;
    const v = pickVoices(c?.language || 'fr');
    const u = new SpeechSynthesisUtterance(text);
    u.lang = c?.language === 'en' ? 'en-US' : 'fr-FR';
    const voice = who === 'ai' ? v.ai : v.contact;
    if (voice) u.voice = voice;
    const sameVoice = v.ai && v.ai === v.contact;
    u.pitch = who === 'ai' ? 1.05 : sameVoice ? 0.72 : 0.95;
    u.rate = who === 'ai' ? 1.06 : 0.98;
    let started = false;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (started) ttsActive.current = Math.max(0, ttsActive.current - 1);
      setSpeaking((s) => (s && s.who === who ? null : s));
      resolve();
    };
    u.onstart = () => { if (settled) return; started = true; ttsActive.current++; setSpeaking({ who, until: Date.now() + 60_000 }); };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
    window.setTimeout(() => {
      if (!started && !window.speechSynthesis.speaking) {
        setSpeaking({ who, until: Date.now() + speakEstimate(text) });
        done();
      }
    }, 900);
    window.setTimeout(done, speakEstimate(text) + 6000);
  }), []);

  /** Récupère la voix Bland d'une réplique (URL blob) ou null. */
  const fetchClip = useCallback(async (callId: string, eventId: number): Promise<string | null> => {
    try {
      const r = await fetch(`/api/live-calls/${encodeURIComponent(callId)}/tts`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ eventId }),
      });
      if (!r.ok) return null;
      const b = await r.blob();
      return b.size > 100 ? URL.createObjectURL(b) : null;
    } catch {
      return null;
    }
  }, []);

  const playClip = useCallback((url: string, who: 'ai' | 'contact') => new Promise<'ok' | 'blocked' | 'error'>((resolve) => {
    const a = audioElRef.current || new Audio();
    audioElRef.current = a;
    let settled = false;
    const fin = (v: 'ok' | 'blocked' | 'error') => {
      if (settled) return;
      settled = true;
      finishClipRef.current = null;
      a.onended = null;
      a.onerror = null;
      ttsActive.current = Math.max(0, ttsActive.current - 1);
      setSpeaking((s) => (s && s.who === who ? null : s));
      URL.revokeObjectURL(url);
      resolve(v);
    };
    finishClipRef.current = () => fin('ok');
    ttsActive.current++;
    a.onended = () => fin('ok');
    a.onerror = () => fin('error');
    a.src = url;
    a.onplaying = () => setSpeaking({ who, until: Date.now() + 60_000 });
    a.play().catch((err: any) => fin(err?.name === 'NotAllowedError' ? 'blocked' : 'error'));
  }), []);

  const enqueueVoice = useCallback((e: CallEvent) => {
    const c = callRef.current;
    if (!c || (e.kind !== 'ai' && e.kind !== 'contact')) return;
    const who = e.kind;
    const gen = genRef.current;
    const receivedAt = Date.now();
    const clip = fetchClip(c.id, e.id); // téléchargé tout de suite, joué à son tour
    queueRef.current = queueRef.current.then(async () => {
      const url = await clip;
      const stale = gen !== genRef.current || Date.now() - receivedAt > 30_000;
      if (stale) { if (url) URL.revokeObjectURL(url); return; }
      if (url) {
        const r = await playClip(url, who);
        if (r === 'ok') return;
        if (r === 'blocked') {
          stopRef.current();
          setListenErr('Touche le haut-parleur pour entendre les voix.');
          return;
        }
      }
      if (gen !== genRef.current) return;
      await speakBrowser(who, e.text);
    }).catch(() => {});
  }, [fetchClip, playClip, speakBrowser]);

  // ── Nouvelle ligne du journal ─────────────────────────────────────────────
  const onEvent = useCallback((e: CallEvent) => {
    if (seen.current.has(e.id)) return;
    seen.current.add(e.id);
    setEvents((prev) => [...prev, e]);
    const fresh = e.at >= mountedAt.current - 4000;
    if (!fresh || (e.kind !== 'ai' && e.kind !== 'contact')) return;
    const c = callRef.current;
    if (listeningRef.current && c?.mode === 'sim') enqueueVoice(e);
    else setSpeaking({ who: e.kind, until: Date.now() + speakEstimate(e.text) });
  }, [enqueueVoice]);

  // ── Flux SSE (fetch + Authorization, reprise avec ?after=) ───────────────
  useEffect(() => {
    if (!id) { setError('Appel introuvable'); return; }
    let stop = false;
    let ctrl: AbortController | null = null;
    let after = 0;
    let retry = 0;
    (async () => {
      while (!stop) {
        ctrl = new AbortController();
        let ended = false;
        try {
          const r = await fetch(`/api/live-calls/${encodeURIComponent(id)}/stream?after=${after}`, { headers: authHeaders(), signal: ctrl.signal });
          if (r.status === 404 || r.status === 401) {
            const d = await r.json().catch(() => ({}));
            setError(d?.error || 'Appel introuvable');
            return;
          }
          if (!r.ok || !r.body) throw new Error(String(r.status));
          retry = 0;
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let ev = 'message';
              let payload = '';
              for (const line of chunk.split('\n')) {
                if (line.startsWith('event:')) ev = line.slice(6).trim();
                else if (line.startsWith('data:')) payload += line.slice(5).trim();
              }
              if (!payload) continue;
              let d: any;
              try { d = JSON.parse(payload); } catch { continue; }
              if (ev === 'event') { after = Math.max(after, Number(d.id) || 0); onEvent(d); }
              else if (ev === 'state') { setCall(d); setError(null); }
              else if (ev === 'end') ended = true;
            }
          }
        } catch {
          if (stop) return;
        }
        if (ended || stop) return;
        retry++;
        await sleep(Math.min(8000, 700 * retry));
      }
    })();
    return () => { stop = true; ctrl?.abort(); };
  }, [id, onEvent]);

  // Horloge (durée + fin d'animation des paroles).
  useEffect(() => {
    if (isTerminal && !speaking) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [isTerminal, speaking]);
  useEffect(() => {
    if (speaking && ttsActive.current === 0 && now > speaking.until) setSpeaking(null);
  }, [now, speaking]);

  // Défilement automatique de la transcription.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [events.length]);

  // ── Écoute ────────────────────────────────────────────────────────────────
  const stopAudio = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    try { wsRef.current?.close(); } catch { /* ignore */ }
    wsRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    wavesRef.current?.style.setProperty('--lvl', '1');
    genRef.current++;
    try { audioElRef.current?.pause(); } catch { /* ignore */ }
    finishClipRef.current?.();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    ttsActive.current = 0;
  }, []);
  stopRef.current = stopAudio;

  const startListening = useCallback(async () => {
    setListenErr(null);
    const c = callRef.current;
    if (!c) return;
    if (c.mode === 'sim') {
      if ('speechSynthesis' in window) window.speechSynthesis.getVoices(); // voix de secours
      if (!audioElRef.current) audioElRef.current = new Audio();
      listeningRef.current = true;
      setListening(true);
      return;
    }
    try {
      const r = await commsJson<{ url: string }>(`/api/live-calls/${encodeURIComponent(c.id)}/listen`, { method: 'POST', body: {} });
      const player = new PcmPlayer();
      await player.ctx.resume().catch(() => {});
      playerRef.current = player;
      const ws = new WebSocket(r.url);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = async (m) => {
        const p = playerRef.current;
        if (!p) return;
        if (m.data instanceof ArrayBuffer) p.push(new Uint8Array(m.data));
        else if (m.data instanceof Blob) p.push(new Uint8Array(await m.data.arrayBuffer()));
        else if (typeof m.data === 'string') {
          try {
            const j = JSON.parse(m.data);
            const b64 = j.audio || j.data || j.payload || j.chunk || j.media?.payload;
            if (typeof b64 === 'string') p.push(b64ToBytes(b64));
          } catch { /* message de contrôle */ }
        }
      };
      ws.onerror = () => setListenErr("L'écoute a été coupée.");
      ws.onclose = () => { if (listeningRef.current) stopAudio(); };
      wsRef.current = ws;
      listeningRef.current = true;
      setListening(true);
      // Amplitude des ondes = vrai niveau sonore.
      const tick = () => {
        const p = playerRef.current;
        if (!p) return;
        wavesRef.current?.style.setProperty('--lvl', String(0.35 + p.level() * 1.1));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e: any) {
      setListenErr(e?.message || "Écoute impossible pour l'instant.");
    }
  }, [stopAudio]);

  // Simulation fraîche : les voix sont lues d'emblée (l'utilisateur vient
  // d'envoyer son message : le navigateur autorise la lecture).
  const autoListened = useRef(false);
  useEffect(() => {
    if (autoListened.current || !call) return;
    autoListened.current = true;
    if (call.mode === 'sim' && !TERMINAL.has(call.status) && Date.now() - call.createdAt < 60_000) void startListening();
  }, [call, startListening]);

  // Appel terminé : on coupe le son et la connexion d'écoute.
  useEffect(() => {
    if (isTerminal) stopAudio();
  }, [isTerminal, stopAudio]);
  useEffect(() => () => stopAudio(), [stopAudio]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const send = async (text?: string) => {
    const t = (text ?? draft).trim();
    if (!t || !call || sending) return;
    setSending(true);
    setSendErr(null);
    try {
      await commsJson(`/api/live-calls/${encodeURIComponent(call.id)}/instruct`, { method: 'POST', body: { text: t } });
      if (text === undefined) setDraft('');
    } catch (e: any) {
      setSendErr(e?.message || 'Envoi impossible');
    } finally {
      setSending(false);
    }
  };

  const hangUp = async () => {
    if (!call || hanging) return;
    setHanging(true);
    try {
      const r = await commsJson<{ call: CallState }>(`/api/live-calls/${encodeURIComponent(call.id)}/stop`, { method: 'POST', body: {} });
      if (r?.call) setCall(r.call);
      stopAudio();
    } catch (e: any) {
      setSendErr(e?.message || 'Impossible de raccrocher');
    } finally {
      setHanging(false);
    }
  };

  // Appel entrant encore en attente : répondre / refuser depuis la carte.
  const answer = async (action: 'accept' | 'decline') => {
    if (!call || answering) return;
    setAnswering(true);
    try {
      const r = await commsJson<{ call: CallState }>(`/api/live-calls/${encodeURIComponent(call.id)}/answer`, { method: 'POST', body: { action } });
      if (r?.call) setCall(r.call);
      window.dispatchEvent(new CustomEvent('velbaz:inbound-decided', { detail: { companyId: (r?.call as any)?.companyId, callId: call.id } }));
    } catch (e: any) {
      setSendErr(e?.message || 'Action impossible');
    } finally {
      setAnswering(false);
    }
  };

  // ── Dérivés ───────────────────────────────────────────────────────────────
  const talk = useMemo(() => events.filter((e) => e.kind !== 'system'), [events]);
  const turns = talk.filter((e) => e.kind === 'ai' || e.kind === 'contact').length;
  const lastSystem = [...events].reverse().find((e) => e.kind === 'system');
  const duration = call?.startedAt ? (call.endedAt || now) - call.startedAt : 0;
  const name = call?.contactName || prettyPhone(call?.phone) || 'Contact';
  const active = speaking && now <= speaking.until + 50 ? speaking.who : null;

  const inbound = call?.direction === 'in';
  const statusLabel = !call ? 'Connexion…'
    : call.status === 'dialing' ? 'Numérotation…'
    : call.status === 'ringing' ? (inbound ? (call.inboundState === 'pending' ? 'Appel entrant · ça sonne…' : 'Appel entrant · l’IA décroche…') : 'Ça sonne…')
    : call.status === 'live' ? `En direct · ${clock(duration)}`
    : call.status === 'ended' ? `Terminé · ${clock(duration)}`
    : call.status === 'canceled' ? `Raccroché${duration ? ` · ${clock(duration)}` : ''}`
    : 'Échec';

  // Hauteurs fixes des barres (pseudo-aléatoires, stables).
  const bars = useMemo(() => Array.from({ length: BARS }, (_, i) => 0.28 + 0.72 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6))), []);

  // Une fois l'appel fini, la transcription se replie (le résumé suffit).
  const wasTerminal = useRef(false);
  useEffect(() => {
    if (isTerminal && !wasTerminal.current) {
      wasTerminal.current = true;
      if (Date.now() - mountedAt.current < 2000) setShowTranscript(false);
    }
  }, [isTerminal]);

  if (error && !call) {
    return <div className="lcall lcall--error"><span className="lcall-err">{error}</span></div>;
  }

  const activeLabel = active === 'ai' ? 'L’IA parle'
    : active === 'contact' ? `${call?.contactName?.split(' ')[0] || 'Le contact'} parle`
    : isLive ? 'En écoute' : '';

  return (
    <div className="lcall" data-status={call?.status || 'loading'} data-active={active || 'none'}>
      {/* ── En-tête ── */}
      <div className="lcall-head">
        <div className="lcall-avatar" aria-hidden>
          {initials(call?.contactName, call?.phone)}
          {(call?.status === 'ringing' || call?.status === 'dialing') && <span className="lcall-ring" />}
        </div>
        <div className="lcall-who">
          <div className="lcall-name">{name}</div>
          <div className="lcall-sub">
            <span className="lcall-status">
              {isLive && <span className="lcall-dot" aria-hidden />}
              {statusLabel}
            </span>
            {call?.mode === 'sim' && <span className="lcall-sim" title="Aucun vrai appel n'est passé">· simulation</span>}
          </div>
        </div>
        {!isTerminal && call && (
          <div className="lcall-actions">
            <button
              type="button"
              className={`lcall-round${listening ? ' is-on' : ''}`}
              onClick={() => (listening ? stopAudio() : void startListening())}
              disabled={call.mode === 'bland' && !isLive && !listening}
              title={call.mode === 'bland' && !isLive ? 'Disponible dès que le contact décroche' : listening ? 'Couper le son' : 'Écouter l’appel'}
              aria-label={listening ? 'Couper le son' : 'Écouter'}
            >
              {listening ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m23 9-6 6M17 9l6 6" /></svg>
              )}
            </button>
            <button type="button" className="lcall-round lcall-round--hang" onClick={() => void hangUp()} disabled={hanging} title="Raccrocher" aria-label="Raccrocher">
              {hanging ? <span className="lcall-spin" /> : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(135deg)' }}>
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>

      {call?.goal && !inbound && <p className="lcall-goal">{call.goal}</p>}
      {inbound && call?.inboundState === 'pending' && !isTerminal && (
        <div className="lcall-answer">
          <button type="button" className="lcall-answer-btn is-accept" disabled={answering} onClick={() => void answer('accept')}>Répondre</button>
          <button type="button" className="lcall-answer-btn is-decline" disabled={answering} onClick={() => void answer('decline')}>Refuser</button>
        </div>
      )}

      {/* ── Onde unique : sa couleur suit qui parle ── */}
      {!isTerminal && (
        <div className="lcall-wave" ref={wavesRef} data-who={active || 'none'}>
          <div className="lcall-bars" aria-hidden>
            {bars.map((h, i) => (
              <span key={i} style={{ ['--h' as any]: h, animationDelay: `${(i % 9) * -0.11}s` }} />
            ))}
          </div>
          <span className="lcall-wave-label">{activeLabel}</span>
        </div>
      )}

      {/* ── Transcription ── */}
      {talk.length > 0 && (
        <>
          {showTranscript && (
            <div className="lcall-log" ref={scrollRef}>
              {talk.map((e) => <Line key={e.id} e={e} contact={call?.contactName?.split(' ')[0] || 'Contact'} />)}
            </div>
          )}
          {isTerminal && (
            <button type="button" className="lcall-link" onClick={() => setShowTranscript((v) => !v)}>
              {showTranscript ? 'Masquer la transcription' : `Voir la transcription · ${turns} répliques`}
            </button>
          )}
        </>
      )}
      {!talk.length && !isTerminal && (
        <div className="lcall-wait">{lastSystem?.text || 'Préparation de l’appel…'}</div>
      )}

      {/* ── Fin d'appel ── */}
      {isTerminal && (
        <div className="lcall-end">
          {call?.status === 'failed' && <p className="lcall-err">{call.error || 'L’appel n’a pas pu aboutir.'}</p>}
          {call?.summary
            ? <p className="lcall-summary"><span>Compte rendu</span>{call.summary}</p>
            : call?.status !== 'failed' && turns > 0 && <p className="lcall-summary lcall-summary--wait">Compte rendu en cours…</p>}
          {call?.recordingUrl && <audio className="lcall-audio" controls preload="none" src={call.recordingUrl} />}
        </div>
      )}

      {/* ── Message privé à l'IA pendant l'appel ── */}
      {!isTerminal && call && (
        <form className="lcall-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Glisse une consigne à l’IA… (le contact n’entend rien)"
            maxLength={600}
          />
          <button type="submit" disabled={!draft.trim() || sending} aria-label="Envoyer à l'IA">
            {sending ? <span className="lcall-spin" /> : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
            )}
          </button>
        </form>
      )}
      {(sendErr || listenErr) && <div className="lcall-err lcall-err--small">{sendErr || listenErr}</div>}
    </div>
  );
}

function Line({ e, contact }: { e: CallEvent; contact: string }) {
  // La consigne reformulée doublonne le message de l'utilisateur : on ne
  // montre que ce qu'il a écrit et l'accusé de l'IA.
  if (e.kind === 'directive') return null;
  const who = e.kind === 'ai' ? 'IA' : e.kind === 'contact' ? contact : e.kind === 'user' ? 'Toi' : 'IA';
  return (
    <div className={`lcall-line lcall-line--${e.kind}`}>
      <span className="lcall-who-tag">{who}{(e.kind === 'user' || e.kind === 'note') && <em> · privé</em>}</span>
      <p>{e.text}</p>
    </div>
  );
}
