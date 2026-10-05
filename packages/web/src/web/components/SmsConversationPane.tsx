"use client";

/* ─────────────────────────────────────────────────────────────────────────
 * SMS CONVERSATION — la conversation SMS complète, dans le rectangle de droite.
 *
 * Ouvert depuis la popup SMS du chat. Bulles façon messagerie (sortants à
 * droite, reçus à gauche), séparateurs de jour, statut de livraison, « en
 * train d'écrire… », bandeau STOP, et un composeur avec suggestion de
 * réponse par l'IA. L'état est relu en base toutes les 2,5 s.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { commsJson, initials, prettyPhone } from '../lib/comms-context';
import { SMS_STATUS, type SmsThreadPayload } from './SmsPopup';
import PreviewWideButton from './PreviewWideButton';

interface Props {
  threadId: string;
  label: string;
  onClose: () => void;
  wide?: boolean;
  onToggleWide?: () => void;
}

const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
function segments(text: string): { count: number; left: number } {
  if (!text) return { count: 0, left: 160 };
  const gsm = GSM.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const len = [...text].length;
  if (len <= single) return { count: 1, left: single - len };
  const count = Math.ceil(len / multi);
  return { count, left: count * multi - len };
}

const dayKey = (ms: number) => new Date(ms).toDateString();
function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === y.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export default function SmsConversationPane({ threadId, label, onClose, wide, onToggleWide }: Props) {
  const [t, setT] = useState<SmsThreadPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    try {
      const d = await commsJson<SmsThreadPayload>(`/api/sms-threads/${encodeURIComponent(threadId)}`);
      setT(d);
      setError(null);
    } catch (e: any) {
      if (e?.status && e.status < 500) setError(e.message || 'Conversation introuvable');
    }
  }, [threadId]);

  useEffect(() => {
    setT(null);
    setError(null);
    lastCount.current = 0;
    stick.current = true;
    void load();
    const iv = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 2500);
    return () => clearInterval(iv);
  }, [load]);

  // Reste collé en bas quand un message arrive (sauf si l'utilisateur remonte lire).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !t) return;
    const n = t.messages.length + (t.thread.typing ? 1 : 0);
    if (n !== lastCount.current && stick.current) el.scrollTop = el.scrollHeight;
    lastCount.current = n;
  }, [t]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Hauteur automatique du composeur.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
  }, [draft]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending || !t) return;
    setSending(true);
    setSendErr(null);
    try {
      const d = await commsJson<SmsThreadPayload>(`/api/sms-threads/${encodeURIComponent(threadId)}/messages`, { method: 'POST', body: { body } });
      setT(d);
      setDraft('');
      stick.current = true;
    } catch (e: any) {
      setSendErr(e?.message || 'Envoi impossible');
    } finally {
      setSending(false);
    }
  };

  const suggest = async () => {
    if (suggesting) return;
    setSuggesting(true);
    setSendErr(null);
    try {
      const d = await commsJson<{ text: string }>(`/api/sms-threads/${encodeURIComponent(threadId)}/suggest`, { method: 'POST', body: {} });
      if (d?.text) { setDraft(d.text); taRef.current?.focus(); }
    } catch (e: any) {
      setSendErr(e?.message || 'Suggestion indisponible');
    } finally {
      setSuggesting(false);
    }
  };

  const th = t?.thread;
  const name = th?.contactName || prettyPhone(th?.phone) || label;
  const seg = segments(draft);
  const lastOut = t ? [...t.messages].reverse().find((m) => m.direction === 'out') : undefined;

  return (
    <div className="smsp">
      {/* ── Barre du haut ── */}
      <div className="smsp-top">
        {onToggleWide && <PreviewWideButton wide={!!wide} onClick={onToggleWide} flat />}
        <span className="smsp-avatar">{initials(th?.contactName, th?.phone)}</span>
        <div className="smsp-title">
          <span className="smsp-name">{name}</span>
          <span className="smsp-sub">
            {th?.contactName ? prettyPhone(th.phone) : 'SMS'}
            {th?.mode === 'sim' && <span title="Aucun vrai SMS n'est envoyé">· simulation</span>}
          </span>
        </div>
        <button type="button" className="smsp-iconbtn" onClick={onClose} title="Fermer la conversation" aria-label="Fermer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="smsp-box">
        {th?.context && (
          <div className="smsp-context">{th.context}</div>
        )}

        {/* ── Fil ── */}
        <div className="smsp-thread" ref={scrollRef} onScroll={onScroll}>
          {!t && !error && <div className="smsp-empty">Chargement…</div>}
          {error && <div className="smsp-empty smsp-empty--err">{error}</div>}
          {t?.messages.map((m, i) => {
            const prev = t.messages[i - 1];
            const next = t.messages[i + 1];
            const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
            const grouped = !!next && next.direction === m.direction && next.createdAt - m.createdAt < 5 * 60_000 && dayKey(next.createdAt) === dayKey(m.createdAt);
            return (
              <div key={m.id} className="smsp-row-wrap">
                {newDay && <div className="smsp-day">{dayLabel(m.createdAt)}</div>}
                <div className={`smsp-row smsp-row--${m.direction}${grouped ? ' is-grouped' : ''}`}>
                  <div className={`smsp-bubble${m.status === 'failed' ? ' is-failed' : ''}`}>
                    {m.body}
                  </div>
                  {!grouped && (
                    <div className="smsp-meta">
                      {hhmm(m.createdAt)}
                      {m.direction === 'out' && m.id === lastOut?.id && (
                        <span className={`smsp-status smsp-status--${m.status}`}>
                          {(m.status === 'delivered' || m.status === 'sent' || m.status === 'simulated') && (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                              {m.status === 'delivered' ? <><path d="M2 13l4 4L16 7" /><path d="M9 16l1 1L22 5" /></> : <path d="M5 13l4 4L19 7" />}
                            </svg>
                          )}
                          {SMS_STATUS[m.status] || m.status}
                        </span>
                      )}
                    </div>
                  )}
                  {m.status === 'failed' && m.error && <div className="smsp-fail">{m.error}</div>}
                </div>
              </div>
            );
          })}
          {th?.typing && (
            <div className="smsp-row smsp-row--in">
              <div className="smsp-bubble smsp-typing" aria-label="En train d'écrire"><i /><i /><i /></div>
            </div>
          )}
        </div>

        {/* ── Composeur ── */}
        {th?.optedOut ? (
          <div className="smsp-optout">
            Ce contact a répondu <strong>STOP</strong> : plus aucun SMS ne peut lui être envoyé.
          </div>
        ) : (
          <div className="smsp-composer">
            {sendErr && <div className="smsp-err">{sendErr}</div>}
            <div className="smsp-compose-row">
              <button type="button" className="smsp-suggest" onClick={() => void suggest()} disabled={suggesting || !t} title="L'IA propose une réponse (tu peux la modifier)">
                {suggesting ? <span className="smsp-spin" /> : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>
                )}
                <span>Suggestion IA</span>
              </button>
              <div className="smsp-field">
                <textarea
                  ref={taRef}
                  value={draft}
                  rows={1}
                  maxLength={1200}
                  placeholder="Écrire un SMS…"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                />
                {draft && <span className="smsp-count" title="Nombre de SMS facturés">{seg.left} · {seg.count} SMS</span>}
              </div>
              <button type="button" className="smsp-send" onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Envoyer">
                {sending ? <span className="smsp-spin" /> : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
