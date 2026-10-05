/**
 * PayoutsPanel — argent encaissé par le Stripe Velbaz pour ce site.
 *
 * Sans Stripe connecté, chaque vente est encaissée par Velbaz : la commission
 * est prélevée et le reste attend ici (« waiting for you ») jusqu'à ce que le
 * propriétaire connecte son Stripe. Une fois connecté, l'attente est versée et
 * les ventes suivantes arrivent directement sur son compte (commission déduite).
 * Statuts lisibles au TEXTE (jamais à la couleur seule).
 */

import { useCallback, useEffect, useState } from 'react';
import { getAuthToken } from '../lib/token';

interface CurrencyTotals { held: number; paidOut: number; fees: number; gross: number; costs?: number; heldCount: number }
interface Payouts {
  platformReady: boolean;
  feePercent: number;
  stripe: { accountId: string | null; onboardingCompleted: boolean; payoutsEnabled: boolean };
  currencies: Record<string, CurrencyTotals>;
  sales: number;
  lastError: string | null;
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function money(cents: number, cur: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur.toUpperCase()}`;
  }
}

export default function PayoutsPanel({ companyId }: { companyId: string }) {
  const [data, setData] = useState<Payouts | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/companies/${companyId}/payouts`, { headers: authHeaders() });
      if (!res.ok) return;
      setData(await res.json());
    } catch { /* hors ligne : on garde le dernier état */ }
  }, [companyId]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, [load]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('stripe');
    if (q === 'return') setNote('Back from Stripe — checking your account…');
    if (q === 'refresh') setNote('The Stripe link expired. Click "Connect Stripe" again.');
  }, []);

  async function connect() {
    setBusy(true); setNote(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/payouts/connect`, { method: 'POST', headers: authHeaders() });
      const d = await res.json().catch(() => ({}));
      if (d?.url) { window.location.href = d.url; return; }
      setNote(`✗ ${d?.error || `HTTP ${res.status}`}`);
    } catch (e: any) {
      setNote(`✗ ${e?.message || 'network'}`);
    } finally { setBusy(false); }
  }

  async function retry() {
    setBusy(true); setNote(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/payouts/release`, { method: 'POST', headers: authHeaders() });
      const d = await res.json().catch(() => ({}));
      setNote(d?.released ? `✓ ${d.released} payout(s) sent to your Stripe` : d?.skipped === 'not_connected' ? 'Stripe payouts are not active yet on your account.' : 'Nothing to send right now.');
    } finally { setBusy(false); load(); }
  }

  if (!data || !data.platformReady) return null;

  const curs = Object.entries(data.currencies);
  const held = curs.filter(([, t]) => t.held > 0);
  const connected = data.stripe.payoutsEnabled;
  const started = !!data.stripe.accountId && !connected;

  const box: React.CSSProperties = {
    border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 14, marginBottom: 12,
    background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 8,
  };
  const btn: React.CSSProperties = {
    padding: '7px 14px', fontSize: 12, fontWeight: 700, borderRadius: 7, cursor: 'pointer',
    border: '1px solid var(--border-subtle)', background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)',
    alignSelf: 'flex-start',
  };

  return (
    <div style={box} data-testid="payouts-panel">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>Payouts</strong>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-subtle)' }}>
          {connected ? '✓ STRIPE CONNECTED' : started ? '▶ STRIPE SETUP UNFINISHED' : '▶ STRIPE NOT CONNECTED'}
        </span>
      </div>

      {held.length > 0 ? (
        <div style={{ fontSize: 13 }}>
          <span style={{ fontSize: 20, fontWeight: 800 }}>{held.map(([c, t]) => money(t.held, c)).join(' + ')}</span>
          {' '}waiting for you ({held.reduce((s, [, t]) => s + t.heldCount, 0)} sale{held.reduce((s, [, t]) => s + t.heldCount, 0) > 1 ? 's' : ''}).
          {!connected && ' Connect your Stripe to receive it.'}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          {connected
            ? 'Sales go straight to your Stripe account.'
            : 'Your site already accepts payments. Money from sales waits here until you connect Stripe.'}
        </div>
      )}

      {curs.some(([, t]) => t.paidOut > 0) && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Paid out to you: {curs.filter(([, t]) => t.paidOut > 0).map(([c, t]) => money(t.paidOut, c)).join(' + ')}
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Velbaz fee: {data.feePercent}% of your margin (sale price − production cost − Stripe fees)
        {curs.some(([, t]) => t.fees > 0) && ` · ${curs.map(([c, t]) => money(t.fees, c)).join(' + ')} so far`}
      </div>
      {curs.some(([, t]) => (t.costs || 0) > 0) && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Product costs paid for you (production + shipping, Stripe fees): {curs.filter(([, t]) => (t.costs || 0) > 0).map(([c, t]) => money(t.costs || 0, c)).join(' + ')}
        </div>
      )}

      {!connected && (
        <button type="button" style={btn} onClick={connect} disabled={busy}>
          {busy ? 'Opening Stripe…' : started ? 'Finish Stripe setup' : 'Connect Stripe'}
        </button>
      )}
      {connected && held.length > 0 && (
        <button type="button" style={btn} onClick={retry} disabled={busy}>
          {busy ? 'Sending…' : 'Send waiting money now'}
        </button>
      )}
      {data.lastError && held.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Last payout attempt failed: {data.lastError}</div>
      )}
      {note && <div style={{ fontSize: 12, fontWeight: 600 }}>{note}</div>}
    </div>
  );
}
