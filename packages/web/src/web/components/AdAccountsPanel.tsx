/**
 * AdAccountsPanel — connexion des comptes Google Ads / Meta Ads d'un projet.
 * L'utilisateur connecte SON compte (OAuth en popup), choisit le compte pub
 * (et la Page Facebook pour Meta), puis l'IA peut envoyer ses pubs dessus.
 * Toutes les campagnes sont créées EN PAUSE : rien ne dépense sans action
 * de l'utilisateur chez la régie.
 */

import { useCallback, useEffect, useState } from 'react';
import { getAuthToken } from '../lib/token';

type AdAccount = { id: string; name: string; currency?: string | null; manager?: boolean; status?: string | null };
type AdPage = { id: string; name: string };
type Connection = {
  provider: string;
  label: string;
  externalUser: string | null;
  accounts: AdAccount[];
  selectedAccountId: string | null;
  pages: AdPage[];
  selectedPageId: string | null;
  lastError: string | null;
  ready: boolean;
};
type ProviderState = {
  provider: 'google_ads' | 'meta_ads';
  label: string;
  configured: boolean;
  missingKeys: string[];
  connection: Connection | null;
};
type Push = {
  id: string;
  adId: string;
  provider: string;
  status: string;
  externalUrl: string | null;
  error: string | null;
  createdAt: number | null;
};

const AD_PUSHED_EVENT = 'velbaz:ad-pushed';

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${getAuthToken() || ''}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function call(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(`/api${path}`, { ...init, headers: { ...headers(!!init.body), ...(init.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, data: { error: `Réseau : ${e?.message || 'injoignable'}` } };
  }
}

const COLORS: Record<string, string> = { google_ads: '#4285F4', meta_ads: '#1877F2' };

const LIMITS: Record<string, string> = {
  google_ads: 'Google exige un « developer token » avec accès Basic (demande à faire dans le Centre API de Google Ads) pour créer des campagnes sur de vrais comptes.',
  meta_ads: 'Meta exige que l\'app passe l\'App Review pour « ads_management » avant que d\'autres personnes que les admins de l\'app puissent se connecter.',
};

export function AdAccountsPanel({ companyId }: { companyId: string }) {
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [pushes, setPushes] = useState<Push[]>([]);
  const [callbacks, setCallbacks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [st, cfg] = await Promise.all([
      call(`/companies/${companyId}/ad-accounts`),
      call(`/ad-accounts/config?origin=${encodeURIComponent(window.location.origin)}`),
    ]);
    if (st.ok) {
      setProviders(st.data.providers || []);
      setPushes(st.data.pushes || []);
    } else {
      setMsg({ ok: false, text: st.data?.error || `Erreur ${st.status}` });
    }
    if (cfg.ok) {
      const map: Record<string, string> = {};
      for (const p of cfg.data.providers || []) map[p.provider] = p.callbackUrl;
      setCallbacks(map);
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onPushed = () => { load(); };
    window.addEventListener(AD_PUSHED_EVENT, onPushed);
    return () => window.removeEventListener(AD_PUSHED_EVENT, onPushed);
  }, [load]);

  async function connect(p: ProviderState) {
    setMsg(null);
    setBusy(p.provider);
    const r = await call(`/companies/${companyId}/ad-accounts/connect`, {
      method: 'POST',
      body: JSON.stringify({ provider: p.provider, origin: window.location.origin }),
    });
    if (!r.ok || !r.data?.authUrl) {
      setBusy(null);
      setMsg({ ok: false, text: r.data?.message || r.data?.error || `Erreur ${r.status}` });
      return;
    }
    const w = window.open(r.data.authUrl, `ads_${p.provider}`, 'width=620,height=720,left=200,top=80');
    if (!w) {
      setBusy(null);
      setMsg({ ok: false, text: 'Popup bloquée par le navigateur : autorise les popups pour ce site et réessaie.' });
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      setBusy(null);
      load();
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (!d || (d.type !== 'ad-oauth-success' && d.type !== 'ad-oauth-error') || d.provider !== p.provider) return;
      setMsg(d.type === 'ad-oauth-success'
        ? { ok: true, text: `${p.label} connecté.` }
        : { ok: false, text: d.error || `Connexion ${p.label} impossible.` });
      finish();
    };
    window.addEventListener('message', onMessage);
    const timer = setInterval(() => { if (w.closed) finish(); }, 800);
  }

  async function select(p: ProviderState, patch: { accountId?: string; pageId?: string }) {
    setBusy(p.provider);
    const r = await call(`/companies/${companyId}/ad-accounts/${p.provider}/select`, { method: 'POST', body: JSON.stringify(patch) });
    setBusy(null);
    if (!r.ok) setMsg({ ok: false, text: r.data?.error || `Erreur ${r.status}` });
    load();
  }

  async function refresh(p: ProviderState) {
    setBusy(p.provider);
    const r = await call(`/companies/${companyId}/ad-accounts/${p.provider}/refresh`, { method: 'POST', body: '{}' });
    setBusy(null);
    setMsg(r.ok ? { ok: true, text: 'Liste des comptes mise à jour.' } : { ok: false, text: r.data?.error || `Erreur ${r.status}` });
    load();
  }

  async function disconnect(p: ProviderState) {
    if (!window.confirm(`Déconnecter ${p.label} de ce projet ? (rien n'est supprimé chez ${p.label})`)) return;
    setBusy(p.provider);
    await call(`/companies/${companyId}/ad-accounts/${p.provider}`, { method: 'DELETE' });
    setBusy(null);
    load();
  }

  if (loading) {
    return <div className="p-3 mb-4 rounded-lg text-[12px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)', color: 'var(--text-dim)' }}>Chargement des comptes pub…</div>;
  }

  return (
    <div className="mb-4 space-y-2" data-testid="ad-accounts-panel">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>Comptes publicitaires</div>
        <div className="text-[10px]" style={{ color: 'var(--text-ghost)' }}>Les campagnes sont toujours créées en pause</div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {providers.map((p) => {
          const conn = p.connection;
          const color = COLORS[p.provider] || '#888';
          return (
            <div key={p.provider} data-testid={`ad-provider-${p.provider}`} className="p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>{p.label}</span>
                <span className="text-[10px] ml-auto font-mono" style={{ color: conn?.ready ? '#4EAADC' : conn ? '#e6b450' : 'var(--text-faint)' }}>
                  {!p.configured ? 'non configuré' : conn?.ready ? 'prêt' : conn ? 'compte à choisir' : 'non connecté'}
                </span>
              </div>

              {!p.configured && (
                <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }} data-testid={`ad-missing-${p.provider}`}>
                  Clés manquantes dans Admin → API Keys : <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{p.missingKeys.join(', ')}</span>.
                  {callbacks[p.provider] && (
                    <div className="mt-1">URL de retour à déclarer chez {p.label} : <span className="font-mono break-all" style={{ color: 'var(--text-muted)' }}>{callbacks[p.provider]}</span></div>
                  )}
                </div>
              )}

              {p.configured && !conn && (
                <button onClick={() => connect(p)} disabled={busy === p.provider}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium disabled:opacity-40"
                  style={{ background: color, color: '#fff' }}>
                  {busy === p.provider ? 'Connexion…' : `Connecter ${p.label}`}
                </button>
              )}

              {p.configured && conn && (
                <div className="space-y-2">
                  {conn.externalUser && <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>Connecté : {conn.externalUser}</div>}
                  {conn.accounts.length === 0 ? (
                    <div className="text-[11px]" style={{ color: '#e6b450' }}>Aucun compte pub accessible avec ce profil. Crée-en un chez {p.label} puis clique « Relire ».</div>
                  ) : (
                    <label className="block text-[11px]" style={{ color: 'var(--text-dim)' }}>
                      Compte utilisé
                      <select value={conn.selectedAccountId || ''} disabled={busy === p.provider}
                        onChange={(e) => select(p, { accountId: e.target.value })}
                        className="mt-1 w-full px-2 py-1 rounded text-[12px]"
                        style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                        <option value="">— choisir —</option>
                        {conn.accounts.map((a) => (
                          <option key={a.id} value={a.id} disabled={!!a.manager}>
                            {a.name} ({a.id}{a.currency ? ` · ${a.currency}` : ''}){a.manager ? ' — MCC' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {p.provider === 'meta_ads' && (
                    conn.pages.length === 0 ? (
                      <div className="text-[11px]" style={{ color: '#e6b450' }}>Aucune Page Facebook trouvée : Meta en exige une pour diffuser une pub.</div>
                    ) : (
                      <label className="block text-[11px]" style={{ color: 'var(--text-dim)' }}>
                        Page Facebook
                        <select value={conn.selectedPageId || ''} disabled={busy === p.provider}
                          onChange={(e) => select(p, { pageId: e.target.value })}
                          className="mt-1 w-full px-2 py-1 rounded text-[12px]"
                          style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                          <option value="">— choisir —</option>
                          {conn.pages.map((pg) => <option key={pg.id} value={pg.id}>{pg.name}</option>)}
                        </select>
                      </label>
                    )
                  )}
                  {conn.lastError && <div className="text-[11px]" style={{ color: '#ff6b6b' }}>Dernière erreur : {conn.lastError}</div>}
                  <div className="flex gap-2">
                    <button onClick={() => refresh(p)} disabled={busy === p.provider} className="px-2.5 py-1 rounded text-[11px] disabled:opacity-40"
                      style={{ background: 'var(--surface-3)', color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}>Relire</button>
                    <button onClick={() => disconnect(p)} disabled={busy === p.provider} className="px-2.5 py-1 rounded text-[11px] disabled:opacity-40"
                      style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--border-default)' }}>Déconnecter</button>
                  </div>
                </div>
              )}

              <div className="mt-2 text-[10px] leading-relaxed" style={{ color: 'var(--text-ghost)' }}>{LIMITS[p.provider]}</div>
            </div>
          );
        })}
      </div>

      {msg && (
        <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)', color: msg.ok ? '#4EAADC' : '#ff6b6b' }}>{msg.text}</div>
      )}

      {pushes.length > 0 && (
        <div className="p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)' }}>
          <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-dim)' }}>Envois récents</div>
          <div className="space-y-1">
            {pushes.slice(0, 8).map((x) => (
              <div key={x.id} className="flex items-center gap-2 text-[11px]">
                <span style={{ color: COLORS[x.provider] || '#888' }}>{x.provider === 'google_ads' ? 'Google' : 'Meta'}</span>
                <span className="font-mono" style={{ color: x.status === 'failed' ? '#ff6b6b' : '#e6b450' }}>{x.status === 'failed' ? 'échec' : 'en pause'}</span>
                {x.error && <span className="truncate" style={{ color: 'var(--text-dim)' }}>{x.error}</span>}
                {x.externalUrl && <a href={x.externalUrl} target="_blank" rel="noreferrer" className="ml-auto underline" style={{ color: 'var(--text-muted)' }}>Ouvrir</a>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Bouton « Envoyer sur Google/Meta (en pause) » d'une pub générée. */
export function AdPushButton({ companyId, ad, onPushed }: { companyId: string; ad: { id: string; platform: string; dailyBudget?: number }; onPushed?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; text: string; url?: string | null } | null>(null);
  const platform = String(ad.platform || '').toLowerCase();
  const provider = platform === 'google' ? 'google_ads' : (platform === 'meta' || platform === 'facebook' || platform === 'instagram') ? 'meta_ads' : null;
  if (!provider) return null;
  const label = provider === 'google_ads' ? 'Google Ads' : 'Meta Ads';

  async function push() {
    setBusy(true);
    setRes(null);
    const r = await call(`/companies/${companyId}/ads/${ad.id}/push`, { method: 'POST', body: JSON.stringify({ provider }) });
    setBusy(false);
    if (r.ok && r.data?.ok) {
      setRes({ ok: true, text: `Campagne créée en pause sur ${label} — active-la chez ${label} quand tu veux.`, url: r.data.externalUrl });
      window.dispatchEvent(new Event(AD_PUSHED_EVENT));
      onPushed?.();
    } else {
      setRes({ ok: false, text: r.data?.error || `Erreur ${r.status}` });
    }
  }

  return (
    <div className="mt-2">
      <button onClick={push} disabled={busy} data-testid={`ad-push-${ad.id}`}
        className="px-2.5 py-1 rounded text-[11px] font-medium disabled:opacity-40"
        style={{ background: 'var(--surface-3)', color: COLORS[provider], border: '1px solid var(--border-default)' }}>
        {busy ? 'Envoi…' : `Envoyer sur ${label} (en pause)`}
      </button>
      {res && (
        <div className="mt-1 text-[11px]" style={{ color: res.ok ? '#4EAADC' : '#ff6b6b' }}>
          {res.text}{res.url && <> · <a href={res.url} target="_blank" rel="noreferrer" className="underline">ouvrir</a></>}
        </div>
      )}
    </div>
  );
}
