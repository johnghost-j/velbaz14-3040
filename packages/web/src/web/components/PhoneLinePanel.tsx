/**
 * PhoneLinePanel — onglet « Phone » d'un projet : la ligne téléphonique où
 * l'IA reçoit les appels.
 *
 * [2026-10-01] Appels entrants : mode auto (Autopilot) → l'IA décroche toute
 * seule ; sinon une popup « Appel entrant » apparaît (Répondre / Refuser).
 * Ici : brancher le numéro Bland du projet, simuler un appel pour tester, et
 * voir les derniers appels reçus.
 */

import { useCallback, useEffect, useState } from 'react';
import { Phone, PhoneIncoming } from 'lucide-react';
import { commsJson, prettyPhone } from '../lib/comms-context';

interface RecentCall {
  id: string; phone: string; contactName: string | null; status: string; mode: 'bland' | 'sim';
  inboundState: string | null; summary: string | null; createdAt: number;
}
interface LineView {
  line: { phoneNumber: string | null; configuredAt: number | null; lastError: string | null } | null;
  blandReady: boolean;
  demo: boolean;
  recent: RecentCall[];
}

const STATE_LABEL: Record<string, string> = {
  pending: 'Ça sonne',
  auto: 'Mode auto',
  accepted: 'Répondu',
  declined: 'Message pris',
  timeout: 'Pris par l’IA (pas de réponse)',
};

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function PhoneLinePanel({ companyId, autoOn }: { companyId: string; autoOn?: boolean }) {
  const [view, setView] = useState<LineView | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [number, setNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await commsJson<LineView>(`/api/companies/${encodeURIComponent(companyId)}/inbound-line`);
      setView(d);
      setLocked(null);
      setNumber((n) => n || d.line?.phoneNumber || '');
    } catch (e: any) {
      if (e?.status === 403) setLocked(e.message);
      else setMsg({ ok: false, text: e?.message || 'Chargement impossible' });
    }
  }, [companyId]);

  useEffect(() => { void load(); const iv = setInterval(() => void load(), 8000); return () => clearInterval(iv); }, [load]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const d = await commsJson<LineView>(`/api/companies/${encodeURIComponent(companyId)}/inbound-line`, { method: 'POST', body: { phoneNumber: number } });
      setView(d);
      setMsg({ ok: true, text: 'Ligne configurée : l’IA répond désormais à ce numéro.' });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Configuration impossible' });
    } finally { setSaving(false); }
  };

  const simulate = async () => {
    setSimulating(true); setMsg(null);
    try {
      await commsJson(`/api/inbound/simulate`, { method: 'POST', body: { companyId } });
      setMsg({ ok: true, text: autoOn ? 'Appel simulé : mode auto actif, l’IA décroche. Ouvre le chat du projet pour suivre.' : 'Appel simulé : la popup « Appel entrant » va apparaître.' });
      setTimeout(() => void load(), 1200);
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Simulation impossible' });
    } finally { setSimulating(false); }
  };

  if (locked) {
    return <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{locked}</p>;
  }
  if (!view) return <p className="text-[13px]" style={{ color: 'var(--text-faint)' }}>Chargement…</p>;

  const line = view.line;
  return (
    <div className="max-w-[640px]">
      {/* Comment ça marche */}
      <div className="flex items-start gap-3 mb-8">
        <div className="w-9 h-9 rounded-full grid place-items-center shrink-0" style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)' }}>
          <PhoneIncoming size={17} />
        </div>
        <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <div className="text-[15px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Appels entrants</div>
          Mode auto <b style={{ color: 'var(--text-secondary)' }}>{autoOn ? 'activé' : 'désactivé'}</b>.{' '}
          {autoOn
            ? 'Quand quelqu’un appelle, l’IA décroche directement et la conversation s’affiche dans le chat du projet.'
            : 'Quand quelqu’un appelle, une popup « Appel entrant » apparaît. Répondre : l’IA parle à la personne et tu suis en direct. Refuser : l’IA prend un message. Sans réponse en 25 s, l’IA décroche quand même.'}
        </div>
      </div>

      {/* Numéro */}
      <div className="text-[13px] mb-2" style={{ color: 'var(--text-faint)' }}>Numéro du projet</div>
      {view.demo ? (
        <p className="text-[13px] mb-6" style={{ color: 'var(--text-muted)' }}>Projet démo : tout est simulé, aucun vrai numéro.</p>
      ) : (
        <>
          <div className="flex gap-2 mb-2">
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="+33 1 23 45 67 89 (numéro Bland)"
              className="flex-1 h-10 px-3 rounded-lg text-[14px] outline-none"
              style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
            />
            <button
              type="button" onClick={() => void save()} disabled={saving || !number.trim()}
              className="h-10 px-4 rounded-lg text-[13px] font-medium disabled:opacity-50"
              style={{ background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)' }}
            >{saving ? '…' : line?.configuredAt ? 'Mettre à jour' : 'Brancher'}</button>
          </div>
          <p className="text-[12px] mb-6" style={{ color: 'var(--text-faint)' }}>
            {line?.configuredAt
              ? <>Actif sur {prettyPhone(line.phoneNumber)} depuis le {when(line.configuredAt)}.</>
              : view.blandReady ? 'Achète un numéro dans ton compte Bland, puis colle-le ici.' : 'Clé Bland absente : la ligne réelle n’est pas disponible, seule la simulation marche.'}
            {line?.lastError && <span style={{ color: '#ef4444' }}> Dernière erreur : {line.lastError}</span>}
          </p>
        </>
      )}

      {/* Test */}
      <button
        type="button" onClick={() => void simulate()} disabled={simulating}
        className="inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[13px] font-medium disabled:opacity-50"
        style={{ background: 'var(--surface-3)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
      >
        <Phone size={15} /> {simulating ? 'Appel en cours…' : 'Simuler un appel entrant'}
      </button>
      {msg && <p className="text-[12.5px] mt-3" style={{ color: msg.ok ? 'var(--text-muted)' : '#ef4444' }}>{msg.text}</p>}

      {/* Derniers appels */}
      <div className="text-[13px] mt-10 mb-2" style={{ color: 'var(--text-faint)' }}>Derniers appels reçus</div>
      {view.recent.length === 0 ? (
        <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>Aucun appel pour l’instant.</p>
      ) : (
        <div>
          {view.recent.map((c) => (
            <div key={c.id} className="py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div className="flex items-baseline gap-2 text-[13.5px]">
                <span style={{ color: 'var(--text-primary)' }}>{c.contactName || prettyPhone(c.phone)}</span>
                <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                  {when(c.createdAt)} · {STATE_LABEL[c.inboundState || ''] || c.status}{c.mode === 'sim' ? ' · simulation' : ''}
                </span>
              </div>
              {c.summary && <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{c.summary}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
