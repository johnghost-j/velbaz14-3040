// ─── « Crédits d'un compte » (onglet Credits de l'AdminPanel) ────────────────
//
// L'admin tape l'email d'un compte → liste de ses projets avec le coût IA de
// chacun depuis toujours → clic sur un projet → tout ce qu'il a consommé :
// crédits/USD, modèles utilisés, features, jours d'activité, runs et chaque
// appel (cliquable, ouvre la fiche détail du panneau parent).
//
// Données :
//   GET /api/admin/ai-usage/account?email=…
//   GET /api/admin/ai-usage/overview?companyId=…&days=all
//   GET /api/admin/ai-usage/events?companyId=…&days=all
// Les appels du compte sans projet rattaché sont listés à part
// (companyId=none&userId=…) : rien n'est masqué.

import { useState, useEffect, useCallback, type FormEvent } from 'react';
import {
  type EventRow, type Overview,
  CARD, TH, TD, SECTION_TITLE, HINT, C,
  usd, credits, num, ms, when, Money, Bar, adminFetch,
} from './ai-credits-shared';

type Ownership = 'owner' | 'shared' | 'deleted' | 'unassigned';

interface AccountProject {
  companyId: string | null; name: string | null; ownership: Ownership;
  status: string | null; projectType: string | null; createdAt: number | null;
  calls: number; costUsd: number; credits: number; totalTokens: number;
  errors: number; models: number; firstAt: number | null; lastAt: number | null;
}

interface AccountLookup {
  user: { id: string | null; email: string; name: string | null; createdAt: number | null; exists: boolean; plan: string | null; balance: number | null };
  totals: { calls: number; costUsd: number; credits: number; projects: number };
  projects: AccountProject[];
  creditsPerUsd: number;
}

const OWNERSHIP: Record<Ownership, { label: string; color: string }> = {
  owner: { label: 'propriétaire', color: C.green },
  shared: { label: 'co-édition', color: C.cyan },
  deleted: { label: 'projet supprimé', color: C.yellow },
  unassigned: { label: 'sans projet', color: '#666' },
};

const INPUT: React.CSSProperties = { background: '#0a0a12', color: '#ddd', border: '1px solid #1a1a28', borderRadius: 6, padding: '6px 10px', fontSize: 11, minWidth: 260, flex: '1 1 260px', outline: 'none' };
const BTN: React.CSSProperties = { background: '#1a1a28', color: '#ddd', border: '1px solid #2a2a3a', borderRadius: 6, padding: '6px 14px', fontSize: 11, cursor: 'pointer' };

function day(ts: number | null | undefined): string {
  if (!ts) return '-';
  const d = new Date(Number(ts));
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function projectKey(p: AccountProject): string {
  return p.companyId ?? 'none';
}

function projectTitle(p: AccountProject): string {
  if (p.ownership === 'unassigned') return 'Appels sans projet';
  return p.name || p.companyId || '—';
}

export default function AiCreditsAccountLookup({ onSelectEvent }: { onSelectEvent: (ev: EventRow) => void }) {
  const [email, setEmail] = useState('');
  const [account, setAccount] = useState<AccountLookup | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [project, setProject] = useState<AccountProject | null>(null);
  const [detail, setDetail] = useState<Overview | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  const search = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    const q = email.trim();
    if (!q) return;
    setSearching(true);
    setErr(null);
    setAccount(null);
    setProject(null);
    try {
      const d = await adminFetch(`/ai-usage/account?email=${encodeURIComponent(q)}`);
      if (d?.error) setErr(String(d.error));
      else setAccount(d as AccountLookup);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setSearching(false);
    }
  }, [email]);

  // Détail du projet choisi : toute la vie du projet (days=all).
  useEffect(() => {
    if (!project || !account) { setDetail(null); setEvents([]); return; }
    let cancelled = false;
    const qs = new URLSearchParams({ days: 'all' });
    qs.set('companyId', project.companyId ?? 'none');
    // « Sans projet » : seulement les appels de CE compte.
    if (!project.companyId && account.user.id) qs.set('userId', account.user.id);
    setDetailLoading(true);
    setDetailErr(null);
    Promise.all([
      adminFetch(`/ai-usage/overview?${qs.toString()}&bucket=day`),
      adminFetch(`/ai-usage/events?${qs.toString()}&limit=500`),
    ]).then(([ov, ev]) => {
      if (cancelled) return;
      if (ov?.error) { setDetailErr(String(ov.error)); setDetail(null); }
      else setDetail(ov as Overview);
      setEvents(ev?.rows || []);
      setEventsTotal(ev?.total || 0);
    }).catch(ex => {
      if (!cancelled) setDetailErr((ex as Error).message);
    }).finally(() => {
      if (!cancelled) setDetailLoading(false);
    });
    return () => { cancelled = true; };
  }, [project, account]);

  const s = detail?.summary;
  const total = s?.costUsd || 0;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  const maxDay = (detail?.timeline || []).reduce((m, b) => Math.max(m, b.costUsd), 0) || 1;

  return (
    <div style={{ ...CARD, marginBottom: 12, borderColor: '#22223a' }}>
      <div style={SECTION_TITLE}>
        Crédits d'un compte
        <span style={HINT}>email du compte → ses projets → tout ce que chaque projet a consommé (depuis toujours)</span>
      </div>

      <form onSubmit={search} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: account || err ? 10 : 0 }}>
        <input
          type="email"
          aria-label="Email du compte"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="email du compte (ex. nom@gmail.com)"
          style={INPUT}
          autoComplete="off"
        />
        <button type="submit" disabled={searching || !email.trim()} style={{ ...BTN, opacity: searching || !email.trim() ? 0.5 : 1 }}>
          {searching ? 'Recherche…' : 'Rechercher'}
        </button>
        {account && (
          <button type="button" onClick={() => { setAccount(null); setProject(null); setErr(null); }} style={{ ...BTN, background: 'transparent', color: '#666', borderColor: '#1a1a28' }}>
            Effacer
          </button>
        )}
      </form>

      {err && <div style={{ fontSize: 11, color: C.red }}>{err}</div>}

      {account && (
        <>
          {/* ─── En-tête du compte ─── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 10 }}>
            <div style={{ ...CARD, background: '#0e0e16' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#ddd', wordBreak: 'break-all' }}>{account.user.email}</div>
              <div style={{ fontSize: 9, color: '#4a4a5a', marginTop: 3 }}>
                {account.user.exists
                  ? <>{account.user.name || '—'} · plan {account.user.plan || '—'} · inscrit le {day(account.user.createdAt)}</>
                  : <span style={{ color: C.yellow }}>compte supprimé — il reste des appels IA à son nom</span>}
              </div>
            </div>
            {[
              { label: 'Total dépensé', main: usd(account.totals.costUsd), sub: credits(account.totals.credits), color: C.green },
              { label: 'Appels IA', main: num(account.totals.calls), sub: `${num(account.totals.projects)} projet(s)`, color: C.blue },
              { label: 'Solde actuel', main: account.user.balance == null ? '—' : credits(account.user.balance), sub: account.user.balance == null ? '' : usd(account.user.balance / account.creditsPerUsd), color: C.yellow },
            ].map(k => (
              <div key={k.label} style={{ ...CARD, background: '#0e0e16', textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: k.color }}>{k.main}</div>
                <div style={{ fontSize: 9, color: '#4a4a5a', marginTop: 3 }}>{k.sub}</div>
                <div style={{ fontSize: 9, color: '#444', marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          {/* ─── Projets du compte ─── */}
          {account.projects.length === 0 ? (
            <div style={{ fontSize: 10, color: '#3a3a48' }}>Ce compte n'a aucun projet ni aucun appel IA.</div>
          ) : (
            <div style={{ overflowX: 'auto', marginBottom: project ? 12 : 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={TH}>Projet</th><th style={TH}>Créé le</th><th style={TH}>Part</th><th style={TH}>Dépensé</th>
                  <th style={TH}>Appels</th><th style={TH}>Modèles</th><th style={TH}>Tokens</th><th style={TH}>Err</th><th style={TH}>Dernier appel</th>
                </tr></thead>
                <tbody>
                  {account.projects.map(p => {
                    const active = project && projectKey(project) === projectKey(p);
                    const share = account.totals.costUsd > 0 ? (p.costUsd / account.totals.costUsd) * 100 : 0;
                    return (
                      <tr key={projectKey(p)} onClick={() => setProject(active ? null : p)}
                        style={{ cursor: 'pointer', background: active ? '#1a1a2a' : 'transparent' }}>
                        <td style={{ ...TD, color: '#ddd', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ fontWeight: 700 }}>{active ? '▾ ' : '▸ '}{projectTitle(p)}</span>
                          <div style={{ fontSize: 8, color: OWNERSHIP[p.ownership].color }}>
                            {OWNERSHIP[p.ownership].label}
                            {p.projectType && <span style={{ color: '#3a3a48' }}> · {p.projectType}</span>}
                            {p.companyId && <span style={{ color: '#2e2e3c' }}> · {p.companyId.slice(0, 8)}</span>}
                          </div>
                        </td>
                        <td style={TD}>{day(p.createdAt ?? p.firstAt)}</td>
                        <td style={{ ...TD, width: 70 }}><Bar pct={share} color={C.green} /><span style={{ fontSize: 8, color: '#3a3a48' }}>{share.toFixed(1)}%</span></td>
                        <td style={TD}><Money u={p.costUsd} c={p.credits} color={p.calls ? undefined : '#444'} /></td>
                        <td style={TD}>{num(p.calls)}</td>
                        <td style={TD}>{num(p.models)}</td>
                        <td style={TD}>{num(p.totalTokens)}</td>
                        <td style={{ ...TD, color: p.errors > 0 ? C.red : '#333' }}>{num(p.errors)}</td>
                        <td style={TD}>{p.lastAt ? when(p.lastAt) : <span style={{ color: '#3a3a48' }}>jamais</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ─── Détail du projet choisi ─── */}
          {project && (
            <div style={{ borderTop: '1px solid #1a1a28', paddingTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#eee' }}>{projectTitle(project)}</div>
                <span style={{ fontSize: 9, color: OWNERSHIP[project.ownership].color }}>{OWNERSHIP[project.ownership].label}</span>
                <button onClick={() => setProject(null)} style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #1a1a28', color: '#666', borderRadius: 6, padding: '2px 10px', fontSize: 11, cursor: 'pointer' }}>✕</button>
              </div>

              {detailLoading && <div style={{ color: '#444', fontSize: 11 }}>Chargement…</div>}
              {detailErr && <div style={{ color: C.red, fontSize: 11 }}>Erreur : {detailErr}</div>}
              {!detailLoading && s && s.calls === 0 && (
                <div style={{ fontSize: 10, color: '#3a3a48' }}>Aucun appel IA enregistré pour ce projet.</div>
              )}

              {!detailLoading && detail && s && s.calls > 0 && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 12 }}>
                    {[
                      { label: 'Crédits dépensés', main: credits(s.credits), sub: usd(s.costUsd), color: C.green },
                      { label: 'Appels IA', main: num(s.calls), sub: `${num(s.runs)} runs · ${num(s.models)} modèles`, color: C.blue },
                      { label: 'Tokens', main: num(s.totalTokens), sub: `${num(s.inputTokens)} in / ${num(s.outputTokens)} out`, color: C.purple },
                      { label: 'Images', main: num(s.images), sub: `cache lu ${num(s.cacheReadTokens)}`, color: C.cyan },
                      { label: 'Temps de travail IA', main: ms(s.busyMs), sub: `moy ${ms(s.avgMs)}`, color: C.cyan },
                      { label: 'Échecs', main: num(s.errors), sub: `${credits(s.wastedCredits)} perdus`, color: s.errors > 0 ? C.red : '#333' },
                      { label: 'Période', main: day(s.firstAt), sub: `→ ${day(s.lastAt)}`, color: '#aaa' },
                    ].map(k => (
                      <div key={k.label} style={{ ...CARD, background: '#0e0e16', textAlign: 'center' }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: k.color }}>{k.main}</div>
                        <div style={{ fontSize: 9, color: '#4a4a5a', marginTop: 3 }}>{k.sub}</div>
                        <div style={{ fontSize: 9, color: '#444', marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k.label}</div>
                      </div>
                    ))}
                  </div>

                  {s.estimated > 0 && (
                    <div style={{ ...CARD, padding: '8px 12px', marginBottom: 12, borderColor: 'rgba(250,173,20,0.25)', fontSize: 10, color: C.yellow }}>
                      ⚠ {num(s.estimated)} appel(s) facturés au tarif par défaut (modèle absent de la table de prix) : coût estimé.
                    </div>
                  )}

                  {/* Modèles utilisés */}
                  <div style={{ ...CARD, background: '#0e0e16', marginBottom: 12 }}>
                    <div style={SECTION_TITLE}>Modèles utilisés <span style={HINT}>{num(detail.byModel.length)} modèle(s)</span></div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr>
                          <th style={TH}>Modèle</th><th style={TH}>Part</th><th style={TH}>Coût</th><th style={TH}>Appels</th>
                          <th style={TH}>Tokens in</th><th style={TH}>Tokens out</th><th style={TH}>Cache lu</th><th style={TH}>Images</th><th style={TH}>Moy</th><th style={TH}>Err</th>
                        </tr></thead>
                        <tbody>
                          {detail.byModel.map(m => (
                            <tr key={`${m.model}-${m.provider}-${m.routedVia}`}>
                              <td style={{ ...TD, color: '#ccc' }}>
                                <div style={{ fontWeight: 600 }}>{m.model}</div>
                                <div style={{ fontSize: 8, color: '#3a3a48' }}>
                                  {m.routedVia === 'direct-key' ? 'clé perso' : 'gateway'}
                                  {m.estimated > 0 && <span style={{ color: C.yellow }}> · {m.estimated} estimé(s)</span>}
                                </div>
                              </td>
                              <td style={{ ...TD, width: 70 }}><Bar pct={pct(m.costUsd)} color={C.green} /><span style={{ fontSize: 8, color: '#3a3a48' }}>{pct(m.costUsd).toFixed(1)}%</span></td>
                              <td style={TD}><Money u={m.costUsd} c={m.credits} /></td>
                              <td style={TD}>{num(m.calls)}</td>
                              <td style={TD}>{num(m.inputTokens)}</td>
                              <td style={TD}>{num(m.outputTokens)}</td>
                              <td style={TD}>{num(m.cacheReadTokens)}</td>
                              <td style={TD}>{num(m.images)}</td>
                              <td style={TD}>{ms(m.avgMs)}</td>
                              <td style={{ ...TD, color: m.errors > 0 ? C.red : '#333' }}>{num(m.errors)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Usages (features) + jours */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8, marginBottom: 12 }}>
                    <div style={{ ...CARD, background: '#0e0e16' }}>
                      <div style={SECTION_TITLE}>Usages <span style={HINT}>à quoi ont servi les crédits</span></div>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead><tr><th style={TH}>Usage</th><th style={TH}>Part</th><th style={TH}>Coût</th><th style={TH}>Appels</th><th style={TH}>Temps IA</th><th style={TH}>Err</th></tr></thead>
                          <tbody>
                            {detail.byFeature.map(f => (
                              <tr key={f.feature}>
                                <td style={{ ...TD, color: f.feature === 'unknown' ? C.yellow : '#ccc', fontWeight: 600 }}>{f.feature}</td>
                                <td style={{ ...TD, width: 70 }}><Bar pct={pct(f.costUsd)} color={C.purple} /><span style={{ fontSize: 8, color: '#3a3a48' }}>{pct(f.costUsd).toFixed(1)}%</span></td>
                                <td style={TD}><Money u={f.costUsd} c={f.credits} /></td>
                                <td style={TD}>{num(f.calls)}</td>
                                <td style={TD}>{ms(f.busyMs)}</td>
                                <td style={{ ...TD, color: f.errors > 0 ? C.red : '#333' }}>{num(f.errors)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div style={{ ...CARD, background: '#0e0e16' }}>
                      <div style={SECTION_TITLE}>Par jour <span style={HINT}>hauteur = coût · rouge = échecs</span></div>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 90, overflowX: 'auto', paddingBottom: 2 }}>
                        {detail.timeline.map(b => (
                          <div key={b.slot} title={`${b.slot}\n${usd(b.costUsd)} · ${credits(b.credits)}\n${num(b.calls)} appels · ${num(b.errors)} échecs`}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 16, maxWidth: 48, flex: '1 0 16px' }}>
                            <div style={{ width: '100%', height: Math.max(2, (b.costUsd / maxDay) * 70), background: b.errors > 0 ? C.red : C.blue, opacity: 0.8, borderRadius: '3px 3px 0 0' }} />
                            <div style={{ fontSize: 8, color: '#3a3a48', whiteSpace: 'nowrap' }}>{b.slot.slice(5)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Runs */}
                  {detail.runs.length > 0 && (
                    <div style={{ ...CARD, background: '#0e0e16', marginBottom: 12 }}>
                      <div style={SECTION_TITLE}>Runs <span style={HINT}>un run = un travail complet (build, chat, QA…)</span></div>
                      <div style={{ overflowX: 'auto', maxHeight: 220 }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead><tr><th style={TH}>Début</th><th style={TH}>Usage</th><th style={TH}>Appels</th><th style={TH}>Durée</th><th style={TH}>Temps IA</th><th style={TH}>Coût</th><th style={TH}>Err</th></tr></thead>
                          <tbody>
                            {detail.runs.map(r => (
                              <tr key={`${r.runId}-${r.feature}`}>
                                <td style={TD}>{when(r.startedAt)}</td>
                                <td style={{ ...TD, color: '#ccc', fontWeight: 600 }}>{r.feature}{r.label && <div style={{ fontSize: 8, color: '#3a3a48', fontWeight: 400 }}>{r.label}</div>}</td>
                                <td style={TD}>{num(r.calls)}</td>
                                <td style={TD}>{ms(r.wallMs)}</td>
                                <td style={TD}>{ms(r.busyMs)}</td>
                                <td style={TD}><Money u={r.costUsd} c={r.credits} /></td>
                                <td style={{ ...TD, color: r.errors > 0 ? C.red : '#333' }}>{num(r.errors)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Chaque appel */}
                  <div style={{ ...CARD, background: '#0e0e16' }}>
                    <div style={SECTION_TITLE}>
                      Tous les appels
                      <span style={HINT}>{eventsTotal > events.length ? `${num(events.length)} plus récents sur ${num(eventsTotal)}` : `${num(eventsTotal)} au total`} · clic pour le détail</span>
                    </div>
                    <div style={{ overflowX: 'auto', maxHeight: 360 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr>
                          <th style={TH}>Quand</th><th style={TH}>Usage</th><th style={TH}>Modèle</th><th style={TH}>Par</th>
                          <th style={TH}>Tokens</th><th style={TH}>Durée</th><th style={TH}>Coût</th><th style={TH}>Statut</th>
                        </tr></thead>
                        <tbody>
                          {events.map(ev => (
                            <tr key={ev.id} onClick={() => onSelectEvent(ev)} style={{ cursor: 'pointer' }}>
                              <td style={TD}>{when(ev.startedAt)}</td>
                              <td style={{ ...TD, color: ev.feature === 'unknown' ? C.yellow : '#ccc', fontWeight: 600 }}>
                                {ev.feature}
                                {ev.label && <div style={{ fontSize: 8, color: '#3a3a48', fontWeight: 400 }}>{ev.label}</div>}
                              </td>
                              <td style={TD}>{ev.model}<div style={{ fontSize: 8, color: '#3a3a48' }}>{ev.kind}</div></td>
                              <td style={{ ...TD, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.userEmail || ev.userId || <span style={{ color: '#3a3a48' }}>système</span>}</td>
                              <td style={TD}>{num(ev.totalTokens)}<div style={{ fontSize: 8, color: '#3a3a48' }}>{num(ev.inputTokens)}/{num(ev.outputTokens)}</div></td>
                              <td style={TD}>{ms(ev.durationMs)}</td>
                              <td style={TD}><Money u={ev.costUsd} c={ev.credits} /></td>
                              <td style={{ ...TD, color: ev.status === 'error' ? C.red : C.green, fontWeight: 600 }}>{ev.status === 'error' ? 'ERREUR' : 'ok'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
