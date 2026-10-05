"use client";

/* ─────────────────────────────────────────────────────────────────────────
 * INCOMING CALL POPUP — quelqu'un appelle le numéro d'un projet.
 *
 * Demande utilisateur (2026-10-01) : « quand la personne appelle, l'IA répond
 * (quand j'ai activé le auto) ; si je ne l'ai pas activé, ça met cette popup
 * et quand j'appuie sur Répondre, l'IA lui parle ».
 *
 * Montée une seule fois dans app.tsx pour tout utilisateur connecté.
 * Sonde /api/inbound/ringing (~2 s) :
 *   • calls  → appels qui sonnent (inbound_state = pending) → la popup ;
 *   • recent → appels déjà pris (auto / répondu / refusé / délai) → on
 *     prévient le chat du projet pour qu'il affiche la carte d'appel.
 * « Répondre » : l'IA parle à l'appelant, on ouvre le chat du projet où la
 * carte d'appel montre la conversation en direct.
 * « Refuser »  : l'IA prend un message.
 * Sans réaction avant la fin du compte à rebours, l'IA décroche quand même.
 * Design adapté du composant shadcn « IncomingCall » (motion/react + lucide).
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Phone, PhoneOff, X } from 'lucide-react';
import { useLocation } from 'wouter';
import { commsJson, initials, prettyPhone } from '../lib/comms-context';

interface RingingCall {
  id: string;
  companyId: string;
  companyName: string | null;
  phone: string;
  contactName: string | null;
  mode: 'bland' | 'sim';
  createdAt: number;
  ringUntil: number | null;
}
interface RingingPayload {
  calls: RingingCall[];
  recent: { id: string; companyId: string; inboundState: string | null; status: string }[];
  now: number;
}

const POLL_MS = 2000;
const HIDDEN_POLL_MS = 6000;
const LOCKED_POLL_MS = 120_000;

/** Petite sonnerie (deux bips doux) via Web Audio ; silencieuse si bloquée. */
function useRingtone(active: boolean) {
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const AC: typeof AudioContext | undefined = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    let ctx: AudioContext | null = null;
    try { ctx = new AC(); } catch { return; }
    const ring = () => {
      if (!ctx || ctx.state === 'closed') return;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const t0 = ctx.currentTime + 0.02;
      for (const [off, freq] of [[0, 880], [0.22, 660]] as const) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, t0 + off);
        g.gain.linearRampToValueAtTime(0.06, t0 + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.2);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + off);
        o.stop(t0 + off + 0.22);
      }
    };
    ring();
    const iv = setInterval(ring, 2600);
    return () => { clearInterval(iv); try { void ctx?.close(); } catch { /* déjà fermé */ } };
  }, [active]);
}

export function IncomingCallPopup() {
  const [, navigate] = useLocation();
  const [calls, setCalls] = useState<RingingCall[]>([]);
  const [skew, setSkew] = useState(0); // horloge serveur - horloge locale
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [muted, setMuted] = useState<Set<string>>(() => new Set());
  const seenRecent = useRef<Set<string>>(new Set());
  const firstPoll = useRef(true);

  // ── Sondage ──
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      let wait = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
      try {
        const d = await commsJson<RingingPayload>('/api/inbound/ringing');
        if (!alive) return;
        setSkew((d.now || Date.now()) - Date.now());
        setCalls(d.calls || []);
        // Appels pris sans la popup (mode auto, délai, autre onglet) : le chat
        // du projet se resynchronise pour afficher la carte d'appel.
        for (const r of d.recent || []) {
          if (seenRecent.current.has(r.id)) continue;
          seenRecent.current.add(r.id);
          if (!firstPoll.current) {
            window.dispatchEvent(new CustomEvent('velbaz:inbound-decided', { detail: { companyId: r.companyId, callId: r.id } }));
          }
        }
        firstPoll.current = false;
      } catch (e: any) {
        // Pas connecté / plan sans appels : rien à afficher, on sonde rarement.
        if (e?.status === 401 || e?.status === 403 || e?.status === 404) { setCalls([]); wait = LOCKED_POLL_MS; }
      }
      if (alive) timer = setTimeout(tick, wait);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  const call = calls.find((c) => !muted.has(c.id)) || null;
  useEffect(() => { setErr(null); }, [call?.id]);

  // Compte à rebours.
  useEffect(() => {
    if (!call) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [call?.id]);

  useRingtone(!!call);

  const answer = useCallback(async (c: RingingCall, action: 'accept' | 'decline') => {
    if (busy) return;
    setBusy(action);
    setErr(null);
    try {
      await commsJson(`/api/live-calls/${encodeURIComponent(c.id)}/answer`, { method: 'POST', body: { action } });
      setCalls((list) => list.filter((x) => x.id !== c.id));
      seenRecent.current.add(c.id);
      // Le chat (s'il est déjà ouvert sur ce projet) récupère la carte d'appel.
      window.dispatchEvent(new CustomEvent('velbaz:inbound-decided', { detail: { companyId: c.companyId, callId: c.id } }));
      if (action === 'accept' && !window.location.pathname.startsWith(`/chat/${c.companyId}`)) navigate(`/chat/${c.companyId}`);
    } catch (e: any) {
      setErr(e?.message || 'Action impossible');
      setTimeout(() => { setErr(null); setMuted((m) => new Set(m).add(c.id)); }, 2500);
    } finally {
      setBusy(null);
    }
  }, [busy, navigate]);

  const left = call?.ringUntil ? Math.max(0, Math.ceil((call.ringUntil - (now + skew)) / 1000)) : null;
  const name = call ? (call.contactName || prettyPhone(call.phone) || 'Numéro inconnu') : '';
  const info = call ? [call.companyName, call.contactName ? prettyPhone(call.phone) : null].filter(Boolean).join(' · ') : '';

  return (
    <AnimatePresence>
      {call && (
        <motion.div
          key={call.id}
          className="incall"
          role="alertdialog"
          aria-live="assertive"
          aria-label={`Appel entrant de ${name}`}
          initial={{ opacity: 0, y: 40, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        >
          <button type="button" className="incall-close" onClick={() => setMuted((m) => new Set(m).add(call.id))} aria-label="Masquer" title="Masquer (l’IA décrochera à la fin du délai)">
            <X size={16} />
          </button>

          <div className="incall-body">
            <div className="incall-avatar-wrap">
              <motion.span className="incall-pulse" aria-hidden animate={{ scale: [1, 1.35], opacity: [0.45, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }} />
              <motion.span className="incall-pulse" aria-hidden animate={{ scale: [1, 1.35], opacity: [0.45, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut', delay: 0.8 }} />
              <div className="incall-avatar">{initials(call.contactName, call.phone)}</div>
            </div>

            <div className="incall-text">
              <div className="incall-name">{name}</div>
              {info && <div className="incall-info">{info}</div>}
              <div className="incall-status">
                Appel entrant{call.mode === 'sim' ? ' · simulation' : ''}
                {left !== null && <> · l’IA décroche dans {left}s</>}
              </div>
            </div>

            <div className="incall-buttons">
              <button type="button" className="incall-btn is-decline" disabled={!!busy} onClick={() => void answer(call, 'decline')}>
                <PhoneOff size={17} />
                <span>{busy === 'decline' ? '…' : 'Refuser'}</span>
              </button>
              <button type="button" className="incall-btn is-accept" disabled={!!busy} onClick={() => void answer(call, 'accept')}>
                <Phone size={17} />
                <span>{busy === 'accept' ? '…' : 'Répondre'}</span>
              </button>
            </div>
            <p className="incall-hint">Répondre : l’IA lui parle, tu suis en direct. Refuser : l’IA prend un message.</p>
            {err && <p className="incall-err">{err}</p>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
