"use client";

/* ─────────────────────────────────────────────────────────────────────────
 * SMS POPUP — l'IA a envoyé un SMS : petite carte dans le chat.
 *
 * Le bloc [SMS_VIEW]{"id":"st_…","messageId":"sm_…"} ne porte que des ids :
 * le texte, le destinataire et le statut sont relus en base (GET
 * /sms-threads/:id). Le bouton ouvre la conversation complète dans le
 * rectangle de droite (SmsConversationPane).
 * ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from 'react';
import { commsJson, prettyPhone, useSmsPaneOpener } from '../lib/comms-context';

export interface SmsViewData { id?: string; messageId?: string }

export interface SmsThreadPayload {
  thread: {
    id: string; mode: 'bland' | 'sim'; phone: string; contactName: string | null; context: string | null;
    optedOut: boolean; typing: boolean; createdAt: number; updatedAt: number;
  };
  messages: { id: string; direction: 'in' | 'out'; body: string; status: string; error: string | null; createdAt: number }[];
}

export const SMS_STATUS: Record<string, string> = {
  sending: 'Envoi…', sent: 'Envoyé', delivered: 'Distribué', failed: 'Échec', simulated: 'Simulé', received: 'Reçu',
};

export default function SmsPopup({ data }: { data: SmsViewData }) {
  const id = String(data?.id || '');
  const open = useSmsPaneOpener();
  const [t, setT] = useState<SmsThreadPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setError('Conversation introuvable'); return; }
    let stop = false;
    const started = Date.now();
    const load = async () => {
      try {
        const d = await commsJson<SmsThreadPayload>(`/api/sms-threads/${encodeURIComponent(id)}`);
        if (!stop) { setT(d); setError(null); }
      } catch (e: any) {
        if (!stop && e?.status && e.status < 500) setError(e.message || 'Conversation introuvable');
      }
    };
    void load();
    // La carte suit les réponses quelques minutes ; le panneau, lui, suit en continu.
    const iv = setInterval(() => {
      if (Date.now() - started > 4 * 60_000) { clearInterval(iv); return; }
      if (document.visibilityState === 'visible') void load();
    }, 4000);
    return () => { stop = true; clearInterval(iv); };
  }, [id]);

  if (error && !t) return <div className="smsc smsc--error">{error}</div>;
  if (!t) return <div className="smsc smsc--loading"><span className="smsc-skel" /><span className="smsc-skel smsc-skel--short" /></div>;

  const msg = t.messages.find((m) => m.id === data.messageId) || [...t.messages].reverse().find((m) => m.direction === 'out');
  const replies = msg ? t.messages.filter((m) => m.direction === 'in' && m.createdAt >= msg.createdAt).length : 0;
  const name = t.thread.contactName || prettyPhone(t.thread.phone);
  const failed = msg?.status === 'failed';

  return (
    <div className="smsc" data-failed={failed ? '1' : undefined}>
      <div className="smsc-head">
        <span className="smsc-ico" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        </span>
        <span className="smsc-title">
          {failed ? 'SMS non envoyé à ' : 'SMS à '}<strong>{name}</strong>
        </span>
        <span className="smsc-meta">
          {msg ? (SMS_STATUS[msg.status] || msg.status) : ''}
          {t.thread.mode === 'sim' && msg?.status !== 'simulated' && ' · simulation'}
        </span>
      </div>

      {msg && <p className="smsc-body">{msg.body}</p>}
      {failed && msg?.error && <p className="smsc-err">{msg.error}</p>}

      <div className="smsc-foot">
        {t.thread.typing && <span className="smsc-typing">{t.thread.contactName?.split(' ')[0] || 'Le contact'} écrit…</span>}
        {!t.thread.typing && replies > 0 && <span className="smsc-replies">{replies} réponse{replies > 1 ? 's' : ''}</span>}
        {t.thread.optedOut && <span className="smsc-stop">STOP — ne plus contacter</span>}
        {open && (
          <button type="button" className="smsc-open" onClick={() => open({ threadId: t.thread.id, label: name })}>
            Ouvrir la conversation
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
