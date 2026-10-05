// ─── Briques partagées des vues « Credits » de l'AdminPanel ─────────────────
//
// Types (miroir de src/api/ai-usage/queries.ts), style sombre, formatage
// USD/crédits et adminFetch. Utilisé par AiCreditsPanel et
// AiCreditsAccountLookup pour garder exactement le même rendu.

import { getAuthToken } from '../lib/token';

// ─── Types (miroir des réponses de src/api/ai-usage/queries.ts) ──────────────

export interface Summary {
  calls: number; costUsd: number; credits: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; reasoningTokens: number; totalTokens: number;
  images: number; busyMs: number; avgMs: number; maxMs: number;
  errors: number; wastedUsd: number; wastedCredits: number; estimated: number;
  firstAt: number | null; lastAt: number | null;
  users: number; companiesCount: number; models: number; runs: number;
  creditsPerUsd: number; errorRate: number; avgCostUsd: number;
}

export interface Bucket { slot: string; calls: number; costUsd: number; credits: number; totalTokens: number; busyMs: number; avgMs: number; errors: number; }
export interface FeatureRow { feature: string; calls: number; costUsd: number; credits: number; totalTokens: number; images: number; busyMs: number; avgMs: number; errors: number; wastedUsd: number; }
export interface ModelRow { model: string; provider: string; routedVia: string; calls: number; costUsd: number; credits: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; images: number; avgMs: number; errors: number; estimated: number; }
export interface UserRow { userId: string | null; userEmail: string | null; calls: number; costUsd: number; credits: number; totalTokens: number; images: number; busyMs: number; errors: number; wastedUsd: number; features: number; lastAt: number | null; }
export interface CompanyRow { companyId: string | null; companyName: string | null; calls: number; costUsd: number; credits: number; totalTokens: number; images: number; busyMs: number; errors: number; wastedUsd: number; lastAt: number | null; }
export interface FailureRow { feature: string; model: string; errors: number; wastedUsd: number; wastedCredits: number; lastAt: number | null; sampleError: string | null; }
export interface Failures { calls: number; errors: number; errorRate: number; wastedUsd: number; wastedCredits: number; byFeature: FailureRow[]; }
export interface RunRow { runId: string; feature: string; label: string | null; userEmail: string | null; companyId: string | null; calls: number; costUsd: number; credits: number; totalTokens: number; busyMs: number; errors: number; startedAt: number; endedAt: number; wallMs: number; concurrency: number; }

export interface EventRow {
  id: string; startedAt: string; endedAt: string; durationMs: number;
  model: string; provider: string; routedVia: string; kind: string;
  feature: string; label: string | null; route: string | null; runId: string | null;
  userId: string | null; userEmail: string | null; companyId: string | null; projectId: string | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  reasoningTokens: number; totalTokens: number; images: number;
  costUsd: number; credits: number; priced: string; status: string;
  errorMessage: string | null; finishReason: string | null; meta: unknown;
}

export interface Overview {
  summary: Summary; timeline: Bucket[]; byFeature: FeatureRow[]; byModel: ModelRow[];
  byUser: UserRow[]; byCompany: CompanyRow[]; failures: Failures; runs: RunRow[];
}

// ─── Style (aligné sur le reste de l'AdminPanel : terminal sombre) ───────────

export const CARD: React.CSSProperties = { background: '#111119', border: '1px solid #1a1a28', borderRadius: 10, padding: 12 };
export const TH: React.CSSProperties = { textAlign: 'left', fontSize: 9, color: '#444', fontWeight: 600, padding: '5px 8px', borderBottom: '1px solid #1a1a28', textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' };
export const TD: React.CSSProperties = { fontSize: 10, color: '#8c8c8c', padding: '5px 8px', borderBottom: '1px solid #12121c', whiteSpace: 'nowrap' };
export const SECTION_TITLE: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#bbb', marginBottom: 8 };
export const HINT: React.CSSProperties = { fontSize: 9, color: '#3a3a48', fontWeight: 400, marginLeft: 6 };

export const C = { blue: '#1890ff', purple: '#b37feb', green: '#52c41a', yellow: '#faad14', red: '#ff4d4f', cyan: '#36cfc9' };

// ─── Formatage ──────────────────────────────────────────────────────────────

export function usd(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(6)}`;
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function credits(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v === 0) return '0 cr';
  if (v < 1) return `${v.toFixed(2)} cr`;
  return `${Math.round(v).toLocaleString('en-US')} cr`;
}

export function num(n: number | null | undefined): string {
  return (Number(n) || 0).toLocaleString('en-US');
}

export function ms(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3_600_000) return `${Math.floor(v / 60_000)}m ${Math.round((v % 60_000) / 1000)}s`;
  return `${Math.floor(v / 3_600_000)}h ${Math.round((v % 3_600_000) / 60_000)}m`;
}

export function when(ts: number | string | null | undefined): string {
  if (!ts) return '-';
  const d = new Date(typeof ts === 'string' ? ts : Number(ts));
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Coût affiché toujours en double unité : USD au-dessus, crédits en dessous. */
export function Money({ u, c, color }: { u: number; c: number; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.25 }}>
      <span style={{ color: color || '#ccc', fontWeight: 600 }}>{usd(u)}</span>
      <span style={{ color: '#4a4a5a', fontSize: 9 }}>{credits(c)}</span>
    </span>
  );
}

/** Barre de proportion (part du coût total). */
export function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ background: '#0a0a12', borderRadius: 3, height: 5, overflow: 'hidden', minWidth: 50 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', background: color, borderRadius: 3 }} />
    </div>
  );
}

export function adminFetch(path: string): Promise<any> {
  const token = getAuthToken();
  return fetch(`/api/admin${path}`, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(r => r.json());
}
