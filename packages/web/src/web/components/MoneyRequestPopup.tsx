"use client";

/* ─────────────────────────────────────────────────────────────────────────
 * MONEY REQUEST POPUP — l'IA demande de l'argent, dans le chat.
 *
 * [2026-09-22] Demande de l'utilisateur :
 *   « quand l'IA a besoin d'argent (améliorer l'entreprise, budget pub, un
 *     outil payant, la facture d'un partenaire), ça met une pop-up dans le
 *     chat avec le montant, pourquoi, et 4 boutons : Payer, Refuser, En
 *     savoir plus, Négocier le montant. Avec un beau style. »
 *   Et surtout : « l'argent doit aller au BON endroit, exactement comme
 *     écrit — jamais buggé, jamais payé pour rien, jamais ailleurs. »
 *
 * CE COMPOSANT N'EST QU'UN AFFICHAGE. Il ne calcule aucun montant et n'en
 * envoie aucun. Le montant, la devise, la cadence, le canal et la destination
 * viennent de la ligne en base (`money_requests`), figés à la création :
 *   • au montage, on RELIT l'état auprès du serveur (GET /money-requests/:id)
 *     → un rechargement de page affiche la vérité, jamais un vieux JSON ;
 *   • « Payer » ne transmet aucun montant : le serveur relit la demande et
 *     construit lui-même la session Stripe (POST /money-requests/:id/pay) ;
 *   • au retour de Stripe (?mr=…&session_id=…), on demande au serveur de
 *     vérifier la session auprès de Stripe (POST …/confirm). Le navigateur ne
 *     peut donc jamais « déclarer » un paiement.
 *
 * Canal `external` : Velbaz n'encaisse rien. On affiche le bénéficiaire exact
 * et son lien, et l'utilisateur confirme lui-même avoir payé.
 * ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import { AnimatedCounter } from './AnimatedCounter';
import { getAuthToken } from '../lib/token';

export interface MoneyRequestData {
  id?: string;
  companyId?: string;
  channel?: 'budget' | 'external' | string;
  amount?: number;
  currency?: string;
  cadence?: string;
  cadenceLabel?: string;
  title?: string;
  reason?: string;
  detail?: string | null;
  expectedReturn?: string | null;
  purpose?: string | null;
  payee?: string | null;
  payUrl?: string | null;
  payInstructions?: string | null;
  status?: string;
  refusedReason?: string | null;
  counterAmount?: number | null;
  counterNote?: string | null;
  amountPaid?: number;
  paidAt?: string | null;
  maxPerRequest?: number;
}

/** Libellés français des postes de dépense connus. */
const PURPOSE_LABEL: Record<string, string> = {
  ads_meta: 'Publicité Meta',
  ads_google: 'Publicité Google',
  ads_tiktok: 'Publicité TikTok',
  ads: 'Publicité',
  tool_subscription: 'Outil / abonnement',
  domain: 'Nom de domaine',
  hosting: 'Hébergement',
  design: 'Design / visuels',
  content: 'Contenu',
  stock: 'Stock / marchandise',
  partnership: 'Partenariat',
  freelance: 'Prestataire',
  legal: 'Juridique / administratif',
  shipping: 'Livraison',
  other: 'Divers',
};

const purposeLabel = (p?: string | null) =>
  !p ? 'Budget entreprise' : (PURPOSE_LABEL[p] || p.replace(/_/g, ' '));

const money = (n: number) =>
  `${Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })} €`;

async function callApi(path: string, body?: any): Promise<any> {
  const tok = getAuthToken();
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

type Panel = 'none' | 'detail' | 'negotiate';

export default function MoneyRequestPopup({ data }: { data: MoneyRequestData; companyId?: string | null }) {
  const id = data?.id ? String(data.id) : '';
  const [req, setReq] = useState<MoneyRequestData>(data);
  const [panel, setPanel] = useState<Panel>('none');
  const [busy, setBusy] = useState<'' | 'pay' | 'refuse' | 'negotiate' | 'external' | 'confirm'>('');
  const [error, setError] = useState('');
  const [counter, setCounter] = useState<string>('');
  const [counterNote, setCounterNote] = useState('');
  const [refuseNote, setRefuseNote] = useState('');
  // Le serveur a-t-il confirmé l'état ? 'ko' = on n'affiche que ce que disait
  // le message, donc on le DIT au lieu de laisser croire que c'est à jour.
  const [synced, setSynced] = useState<'wait' | 'ok' | 'ko'>('wait');
  const confirmedRef = useRef(false);

  const channel = req.channel === 'external' ? 'external' : 'budget';
  const status = String(req.status || 'pending');
  const amount = Number(req.amount || 0);
  const decided = status === 'paid' || status === 'refused' || status === 'canceled' || status === 'expired';

  // 1) État réel au montage : le JSON du message peut être vieux de plusieurs
  //    jours (historique du chat). Le serveur fait foi.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    callApi(`/money-requests/${id}`)
      .then((r) => {
        if (!alive) return;
        if (r?.request) { setReq(r.request); setSynced('ok'); }
        else setSynced('ko');
      })
      .catch(() => { if (alive) setSynced('ko'); });
    return () => { alive = false; };
  }, [id]);

  // 2) Retour de Stripe : c'est le SERVEUR qui vérifie la session.
  useEffect(() => {
    if (!id || confirmedRef.current) return;
    const url = new URL(window.location.href);
    const mr = url.searchParams.get('mr');
    const st = url.searchParams.get('mr_status');
    const sessionId = url.searchParams.get('session_id');
    if (mr !== id) return;
    confirmedRef.current = true;
    // On nettoie l'URL tout de suite : un rechargement ne doit pas rejouer.
    ['mr', 'mr_status', 'session_id'].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState({}, '', url.toString());
    if (st !== 'success' || !sessionId) return;
    setBusy('confirm');
    callApi(`/money-requests/${id}/confirm`, { sessionId })
      .then((r) => { if (r?.request) setReq(r.request); })
      .catch((e) => setError(e?.message || 'Paiement non confirmé'))
      .finally(() => setBusy(''));
  }, [id]);

  if (!id) return null;

  const act = async (
    kind: 'pay' | 'refuse' | 'negotiate' | 'external',
    path: string,
    body?: any,
  ) => {
    setError('');
    setBusy(kind);
    try {
      const r = await callApi(path, body ?? {});
      if (kind === 'pay' && r?.url) { window.location.href = r.url; return; }
      if (r?.request) setReq(r.request);
      setPanel('none');
    } catch (e: any) {
      setError(e?.message || 'Action impossible');
    } finally {
      setBusy('');
    }
  };

  const pay = () => act('pay', `/money-requests/${id}/pay`, { origin: window.location.origin });
  const refuse = () => act('refuse', `/money-requests/${id}/refuse`, { reason: refuseNote.trim() || undefined });
  const markExternal = () => act('external', `/money-requests/${id}/mark-external-paid`);
  const negotiate = () => {
    const v = Number(String(counter).replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0) { setError('Entre un montant valide.'); return; }
    if (req.maxPerRequest && v > req.maxPerRequest) { setError(`Maximum ${money(req.maxPerRequest)} par demande.`); return; }
    act('negotiate', `/money-requests/${id}/negotiate`, { amount: v, note: counterNote.trim() || undefined });
  };

  const cadence = req.cadenceLabel || (req.cadence === 'monthly' ? 'par mois' : req.cadence === 'weekly' ? 'par semaine' : req.cadence === 'quarterly' ? 'par trimestre' : 'une seule fois');
  const recurring = req.cadence && req.cadence !== 'once';
  // Forme courte pour les libellés serrés : « / mois », « Payer 49 €/mois ».
  const cadenceShort =
    req.cadence === 'monthly' ? 'mois'
    : req.cadence === 'weekly' ? 'semaine'
    : req.cadence === 'quarterly' ? 'trimestre'
    : cadence.replace(/^(chaque|par|tous les)\s+/i, '');

  return (
    <div className="mreq" data-status={status}>
      {/* ── En-tête ─────────────────────────────────────────────────────── */}
      <div className="mreq-head">
        <span className="mreq-ico" aria-hidden>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="6" width="19" height="12.5" rx="2.5" />
            <path d="M2.5 10.5h19" />
          </svg>
        </span>
        <div className="mreq-head-txt">
          <div className="mreq-kicker">
            {channel === 'external' ? 'À régler' : 'Budget'}
            {recurring && <span className="mreq-chip">/ {cadenceShort}</span>}
          </div>
          <div className="mreq-title">{req.title || 'Demande de financement'}</div>
        </div>
        <StatusPill status={status} />
      </div>

      {/* ── Montant + destination (ce qui est FIGÉ) ──────────────────────── */}
      <div className="mreq-amount-row">
        <div className="mreq-amount">
          <AnimatedCounter
            value={amount}
            decimals={Number.isInteger(amount) ? 0 : 2}
            suffix=" €"
            className="mreq-amount-num"
          />
          {recurring && <span className="mreq-amount-cad">/ {cadenceShort}</span>}
        </div>
        <div className="mreq-dest">
          <span className="mreq-dest-label">Destination</span>
          <span className="mreq-dest-value">
            {channel === 'external' ? req.payee : purposeLabel(req.purpose)}
          </span>
        </div>
      </div>

      {/* ── État non confirmé : on ne fait jamais passer un vieux JSON du
             message pour la vérité du serveur. Payer reste sûr (le serveur
             relit tout), mais l'utilisateur doit le savoir. ─────────────── */}
      {synced === 'ko' && (
        <p className="mreq-stale">
          <b>État non confirmé</b> — recharge la page. Rien ne peut être prélevé sans le serveur.
        </p>
      )}

      {/* ── Le pourquoi : une phrase, 2 lignes max (clamp CSS) ───────────── */}
      {req.reason && <p className="mreq-reason">{req.reason}</p>}

      {/* ── Panneaux dépliables : tout le détail vit ICI, pas sur la carte ── */}
      {panel === 'detail' && (
        <div className="mreq-panel">
          <p className="mreq-detail">{req.detail || req.reason || "Pas plus de détails."}</p>
          {channel === 'external' && req.payInstructions && (
            <p className="mreq-detail mreq-detail--sep">{req.payInstructions}</p>
          )}
          <ul className="mreq-facts">
            <li><span>Montant</span><b>{money(amount)}</b></li>
            <li><span>Fréquence</span><b>{cadence}</b></li>
            <li>
              <span>Destination</span>
              <b>{channel === 'external' ? `${req.payee} (direct)` : `Budget · ${purposeLabel(req.purpose)}`}</b>
            </li>
            {req.expectedReturn ? <li><span>Retour attendu</span><b>{req.expectedReturn}</b></li> : null}
            {req.maxPerRequest ? <li><span>Plafond / demande</span><b>{money(req.maxPerRequest)}</b></li> : null}
          </ul>
        </div>
      )}

      {panel === 'negotiate' && (
        <div className="mreq-panel">
          <label className="mreq-field">
            <span>Ton montant</span>
            <div className="mreq-input-wrap">
              <input
                type="number" min="1" step="1" inputMode="decimal"
                value={counter}
                onChange={(e) => setCounter(e.target.value)}
                placeholder={String(Math.max(1, Math.round(amount / 2)))}
                autoFocus
              />
              <span className="mreq-input-unit">€</span>
            </div>
          </label>
          <label className="mreq-field">
            <span>Pourquoi (facultatif)</span>
            <textarea
              rows={2}
              value={counterNote}
              onChange={(e) => setCounterNote(e.target.value)}
              placeholder="ex. commence avec moins"
            />
          </label>
          <p className="mreq-note">Rien n'est prélevé.</p>
          <div className="mreq-panel-actions">
            <button type="button" className="mreq-btn mreq-btn--primary" onClick={negotiate} disabled={busy === 'negotiate'}>
              {busy === 'negotiate' ? 'Envoi…' : 'Envoyer'}
            </button>
            <button type="button" className="mreq-btn" onClick={() => setPanel('none')}>Annuler</button>
          </div>
        </div>
      )}

      {/* ── États décidés ────────────────────────────────────────────────── */}
      {status === 'paid' && (
        <div className="mreq-result mreq-result--ok">
          {channel === 'external'
            ? <>Payé à <b>{req.payee}</b>.</>
            : <><b>{money(Number(req.amountPaid || amount))}</b> crédités sur « {purposeLabel(req.purpose)} ».</>}
        </div>
      )}
      {status === 'refused' && (
        <div className="mreq-result">
          Refusé{req.refusedReason ? ` — « ${req.refusedReason} »` : ''}.
        </div>
      )}
      {status === 'negotiating' && req.counterAmount != null && (
        <div className="mreq-result">
          Contre-proposition : <b>{money(req.counterAmount)}</b>
          {req.counterNote ? ` — « ${req.counterNote} »` : ''}.
        </div>
      )}
      {busy === 'confirm' && <div className="mreq-result">Vérification du paiement…</div>}
      {error && <div className="mreq-result mreq-result--err">{error}</div>}

      {/* ── Les 4 actions ────────────────────────────────────────────────── */}
      {!decided && (
        <>
          <div className="mreq-actions">
            {channel === 'external' ? (
              <>
                {req.payUrl && (
                  <a className="mreq-btn mreq-btn--primary" href={req.payUrl} target="_blank" rel="noreferrer">
                    Payer {money(amount)}
                  </a>
                )}
                <button type="button" className="mreq-btn mreq-btn--ok" onClick={markExternal} disabled={busy === 'external'}>
                  {busy === 'external' ? '…' : "J'ai payé"}
                </button>
              </>
            ) : (
              <button type="button" className="mreq-btn mreq-btn--primary" onClick={pay} disabled={busy === 'pay'}>
                {busy === 'pay' ? 'Ouverture…' : `Payer ${money(amount)}${recurring ? ` / ${cadenceShort}` : ''}`}
              </button>
            )}
            <button
              type="button"
              className="mreq-btn"
              onClick={() => setPanel(panel === 'negotiate' ? 'none' : 'negotiate')}
              aria-expanded={panel === 'negotiate'}
            >
              Négocier
            </button>
            <button
              type="button"
              className="mreq-btn"
              onClick={() => setPanel(panel === 'detail' ? 'none' : 'detail')}
              aria-expanded={panel === 'detail'}
            >
              Détails
            </button>
            <button type="button" className="mreq-btn mreq-btn--ghost" onClick={refuse} disabled={busy === 'refuse'}>
              {busy === 'refuse' ? '…' : 'Refuser'}
            </button>
          </div>
          {/* Une seule ligne de garantie : montant et destination sont figés. */}
          <p className="mreq-foot">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="4" y="10.5" width="16" height="10.5" rx="2" />
              <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
            </svg>
            {channel === 'external'
              ? <>Velbaz n'encaisse rien — tu paies {req.payee} en direct.</>
              : <>Montant et destination verrouillés · Stripe</>}
          </p>
        </>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: string }> = {
    pending: { label: 'En attente', tone: 'wait' },
    paid: { label: 'Payé', tone: 'ok' },
    refused: { label: 'Refusé', tone: 'off' },
    negotiating: { label: 'En négociation', tone: 'wait' },
    expired: { label: 'Expiré', tone: 'off' },
    canceled: { label: 'Annulé', tone: 'off' },
  };
  const s = map[status] || map.pending;
  return <span className="mreq-pill" data-tone={s.tone}>{s.label}</span>;
}
