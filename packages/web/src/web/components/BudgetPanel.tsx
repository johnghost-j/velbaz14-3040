"use client";

/* ─────────────────────────────────────────────────────────────────────────
 * PANNEAU BUDGET — où est passé l'argent de l'entreprise.
 *
 * Complète la popup de demande d'argent du chat (MoneyRequestPopup) : ici on
 * ne demande rien, on RELIT. Tout vient de `GET /api/companies/:id/budget`,
 * donc de la base : solde, répartition par poste de dépense, plafonds,
 * demandes et mouvements. Aucun montant n'est calculé côté navigateur —
 * l'utilisateur doit pouvoir vérifier que chaque euro est allé exactement là
 * où la demande le disait.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from 'react';
import { AnimatedCounter } from './AnimatedCounter';
import { getAuthToken } from '../lib/token';

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
  divers: 'Divers',
};
const purposeLabel = (p?: string | null) =>
  !p ? 'Budget entreprise' : (PURPOSE_LABEL[p] || p.replace(/_/g, ' '));

/** Types de mouvements écrits par le serveur dans company_budget_events. */
const EVENT_LABEL: Record<string, string> = {
  topup: 'Budget crédité',
  spend: 'Dépense de l\'IA',
  refund: 'Remboursement',
  adjustment: 'Ajustement',
  external_paid: 'Payé en direct (hors Velbaz)',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'En attente',
  paid: 'Payée',
  refused: 'Refusée',
  negotiating: 'Négociation',
  canceled: 'Annulée',
  expired: 'Expirée',
  external_paid: 'Payée en direct',
};

const money = (n: number) => {
  const v = Number(n || 0);
  return `${v.toLocaleString('fr-FR', {
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
    maximumFractionDigits: 2,
  })} €`;
};

const when = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
};

interface BudgetData {
  balance: number;
  currency: string;
  byPurpose: Record<string, number>;
  paidLast30Days: number;
  caps: { perRequest: number; per30Days: number };
  requests: any[];
  events: any[];
}

export default function BudgetPanel({ companyId }: { companyId: string }) {
  const [data, setData] = useState<BudgetData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const tok = getAuthToken();
      const res = await fetch(`/api/companies/${companyId}/budget`, {
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Erreur ${res.status}`);
      setData(json as BudgetData);
    } catch (e: any) {
      // On n'invente jamais un solde : pas de réponse serveur = pas de chiffre.
      setData(null);
      setError(e?.message || 'Impossible de lire le budget');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 p-10 justify-center" style={{ color: 'var(--text-dim)' }}>
        <div className="flex gap-1"><div className="typing-dot" /><div className="typing-dot" /><div className="typing-dot" /></div>
        <span className="text-[13px]">Lecture du budget…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 rounded-xl" style={{ background: 'var(--red-subtle-bg)', border: '1px solid var(--red-subtle-border)' }}>
        <p className="text-[13px] mb-3" style={{ color: 'var(--red-text)' }}>
          Le serveur n'a pas répondu — aucun solde n'est affiché plutôt qu'un chiffre faux. ({error})
        </p>
        <button onClick={load} className="text-[12px] font-medium px-3 py-1.5 rounded-lg"
          style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
          Réessayer
        </button>
      </div>
    );
  }

  const purposes = Object.entries(data.byPurpose || {}).filter(([, v]) => Number(v) !== 0);
  const capLeft = Math.max(0, Number(data.caps?.per30Days || 0) - Number(data.paidLast30Days || 0));
  const capPct = data.caps?.per30Days
    ? Math.min(100, Math.round((Number(data.paidLast30Days || 0) / Number(data.caps.per30Days)) * 100))
    : 0;
  const pending = (data.requests || []).filter((r) => r.status === 'pending' || r.status === 'negotiating');

  return (
    <div>
      {/* ── Chiffres clés ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-dim)' }}>Solde disponible</div>
          <div className="text-lg font-semibold" style={{ color: Number(data.balance || 0) > 0 ? 'var(--green-text)' : 'var(--text-secondary)' }}>
            <AnimatedCounter value={Number(data.balance || 0)} suffix=" €" fontSize={18} />
          </div>
          <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-ghost)' }}>dépensable par l'IA</div>
        </div>
        <div className="p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-dim)' }}>Payé sur 30 jours</div>
          <div className="text-lg font-semibold" style={{ color: 'var(--text-secondary)' }}>
            <AnimatedCounter value={Number(data.paidLast30Days || 0)} suffix=" €" fontSize={18} />
          </div>
          <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-ghost)' }}>plafond {money(data.caps?.per30Days || 0)}</div>
        </div>
        <div className="p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-dim)' }}>Demandes en attente</div>
          <div className="text-lg font-semibold" style={{ color: pending.length ? '#F59E0B' : 'var(--text-secondary)' }}>
            <AnimatedCounter value={pending.length} fontSize={18} />
          </div>
          <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-ghost)' }}>max {money(data.caps?.perRequest || 0)} / demande</div>
        </div>
      </div>

      {/* ── Plafond 30 jours ──────────────────────────────────────────────── */}
      <div className="p-3 rounded-lg mb-4" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-muted)' }}>Plafond glissant · 30 jours</span>
          <span className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
            il reste {money(capLeft)}
          </span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-4)' }}>
          <div className="h-full rounded-full transition-all"
            style={{ width: `${capPct}%`, background: capPct >= 90 ? 'var(--red-text)' : capPct >= 60 ? '#F59E0B' : 'var(--text-faint)' }} />
        </div>
      </div>

      {/* ── Répartition par poste ─────────────────────────────────────────── */}
      {purposes.length > 0 && (
        <div className="mb-4">
          <h4 className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-dim)' }}>
            Par poste de dépense
          </h4>
          <div className="space-y-1.5">
            {purposes.map(([k, v]) => (
              <div key={k} className="p-2.5 rounded-lg flex items-center gap-3"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
                <span className="text-[12.5px] flex-1" style={{ color: 'var(--text-muted)' }}>{purposeLabel(k)}</span>
                <span className="text-[13px] font-semibold" style={{ color: Number(v) > 0 ? 'var(--text-primary)' : 'var(--text-dim)' }}>
                  {money(Number(v))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Demandes ──────────────────────────────────────────────────────── */}
      <div className="mb-4">
        <h4 className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-dim)' }}>
          Demandes de l'IA ({(data.requests || []).length})
        </h4>
        {(data.requests || []).length === 0 ? (
          <div className="p-6 rounded-xl text-center" style={{ background: 'var(--surface-2)', border: '1px dashed var(--border-default)' }}>
            <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
              Rien demandé pour l'instant.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {(data.requests || []).map((r: any) => (
              <div key={r.id} className="p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>{r.title || 'Demande'}</span>
                  <span className="text-[9.5px] px-1.5 py-0.5 rounded"
                    style={{
                      background: r.status === 'paid' ? 'var(--green-subtle-bg)' : r.status === 'refused' ? 'var(--red-subtle-bg)' : 'var(--surface-4)',
                      color: r.status === 'paid' ? 'var(--green-text)' : r.status === 'refused' ? 'var(--red-text)' : 'var(--text-dim)',
                    }}>
                    {STATUS_LABEL[r.status] || r.status}
                  </span>
                  {r.cadence && r.cadence !== 'once' && (
                    <span className="text-[9.5px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-4)', color: 'var(--text-dim)' }}>
                      {r.cadenceLabel || r.cadence}
                    </span>
                  )}
                  <span className="text-[13px] font-semibold ml-auto" style={{ color: 'var(--text-primary)' }}>{money(r.amount)}</span>
                </div>
                <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-dim)' }}>
                  {r.channel === 'external'
                    ? <>Direct à <b style={{ color: 'var(--text-muted)' }}>{r.payee}</b></>
                    : <>Budget · {purposeLabel(r.purpose)}</>}
                  {r.counterAmount ? <> · contre-proposition {money(r.counterAmount)}</> : null}
                  {r.createdAt ? <> · {when(r.createdAt)}</> : null}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Mouvements ────────────────────────────────────────────────────── */}
      <div>
        <h4 className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-dim)' }}>
          Mouvements ({(data.events || []).length})
        </h4>
        {(data.events || []).length === 0 ? (
          <div className="p-6 rounded-xl text-center" style={{ background: 'var(--surface-2)', border: '1px dashed var(--border-default)' }}>
            <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>Aucun mouvement pour l'instant.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {(data.events || []).map((e: any) => {
              const out = e.type === 'spend' || e.type === 'external_paid';
              return (
                <div key={e.id} className="p-3 rounded-lg flex items-center gap-3"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
                  <div className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: e.type === 'topup' ? 'var(--green-text)' : e.type === 'refund' ? 'var(--red-text)' : 'var(--text-faint)' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] font-medium" style={{ color: 'var(--text-muted)' }}>
                      {EVENT_LABEL[e.type] || e.type}
                    </div>
                    <p className="text-[11.5px] truncate" style={{ color: 'var(--text-dim)' }}>
                      {e.label || purposeLabel(e.purpose)}
                    </p>
                  </div>
                  <span className="text-[13px] font-semibold shrink-0"
                    style={{ color: e.type === 'topup' ? 'var(--green-text)' : e.type === 'refund' ? 'var(--red-text)' : 'var(--text-secondary)' }}>
                    {out ? '−' : '+'}{money(Math.abs(Number(e.amount || 0)))}
                  </span>
                  <span className="text-[10px] shrink-0" style={{ color: 'var(--text-ghost)' }}>{when(e.createdAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px] mt-4 px-1" style={{ color: 'var(--text-ghost)' }}>
        Tous ces chiffres viennent du serveur, pas du navigateur. Un montant et sa destination sont figés
        à la création de la demande : ils ne peuvent plus être modifiés, ni par l'IA, ni par la page.
      </p>
    </div>
  );
}
