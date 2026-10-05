// ─── Sentry : capture des erreurs de Velbaz ─────────────────────────────────
//
// Deux rôles, distincts :
//
//   1. CAPTURE — toute erreur non rattrapée part chez Sentry (groupement,
//      historique, alertes, erreurs du navigateur incluses). C'est le tableau
//      de bord que l'utilisateur consulte.
//   2. DÉCLENCHEMENT — les nouvelles anomalies Sentry sont relues par l'API et
//      passées à l'auto-réparation. Choix de la relecture (polling) plutôt que
//      du webhook : un webhook exige de créer une « internal integration »
//      Sentry + un secret de signature + une URL publique, alors que la
//      relecture ne demande qu'UN jeton. Moins de configuration à la main,
//      donc moins de manières de se tromper. Latence : une minute.
//
// Sans clé Sentry, TOUT ce fichier est inerte : l'auto-réparation continue de
// fonctionner sur le flux d'erreurs interne (error_logs). Sentry est un plus,
// pas une dépendance.
//
import { getSecret } from '../secret-store';
import { slog } from '../observability';
import type { RawError } from './triage';

let sdk: typeof import('@sentry/node') | null = null;
let initialized = false;
let initFailed: string | null = null;

/** DSN : secret-store chiffré d'abord (panneau admin), puis variable d'env. */
export function sentryDsn(): string {
  return (getSecret('SENTRY_DSN') || process.env.SENTRY_DSN || '').trim();
}
function sentryToken(): string {
  return (getSecret('SENTRY_AUTH_TOKEN') || process.env.SENTRY_AUTH_TOKEN || '').trim();
}
function sentryOrg(): string {
  return (getSecret('SENTRY_ORG') || process.env.SENTRY_ORG || '').trim();
}
function sentryProject(): string {
  return (getSecret('SENTRY_PROJECT') || process.env.SENTRY_PROJECT || '').trim();
}

/**
 * Base de l'API Sentry. Les comptes hébergés en Europe répondent sur
 * `de.sentry.io` et renvoient 403 sur `sentry.io` — une erreur de permission
 * trompeuse alors que le jeton est bon. La région est inscrite dans les jetons
 * d'organisation (`sntrys_<base64>`) : on la lit là, ce qui évite de la
 * demander à l'utilisateur. `SENTRY_API_URL` reste prioritaire si fourni.
 */
export function sentryApiBase(): string {
  const explicit = (getSecret('SENTRY_API_URL') || process.env.SENTRY_API_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const token = sentryToken();
  if (token.startsWith('sntrys_')) {
    try {
      const b64 = token.slice('sntrys_'.length).split('_')[0];
      const payload = JSON.parse(
        Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8'),
      );
      const region = String(payload?.region_url || '').trim();
      if (/^https:\/\/[\w.-]+sentry\.io$/.test(region)) return region;
    } catch { /* jeton d'un autre format : base par défaut */ }
  }
  return 'https://sentry.io';
}

export function isSentryConfigured(): boolean {
  return sentryDsn().length > 0;
}
export function isSentryApiConfigured(): boolean {
  return !!(sentryToken() && sentryOrg() && sentryProject());
}

/**
 * Démarre le SDK. Idempotent, jamais bloquant : si Sentry est mal configuré,
 * Velbaz tourne exactement comme avant.
 */
export async function initSentry(): Promise<{ ok: boolean; reason: string }> {
  if (initialized) return { ok: true, reason: 'déjà initialisé' };
  const dsn = sentryDsn();
  if (!dsn) return { ok: false, reason: 'aucun SENTRY_DSN configuré' };

  try {
    // `@sentry/bun` ne s'initialise que sous le runtime Bun ; ici l'API est
    // évaluée par Vite dans un contexte Node, où le global `Bun` n'existe pas
    // et où ce SDK lève « Bun is not defined ». On choisit donc le SDK selon
    // le runtime réellement en place, avec `@sentry/node` comme repli — il
    // fonctionne dans les deux cas.
    sdk = typeof (globalThis as any).Bun !== 'undefined'
      ? ((await import('@sentry/bun')) as unknown as typeof import('@sentry/node'))
      : await import('@sentry/node');
    sdk.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      // Échantillonnage des traces à 0 : on veut les erreurs, pas une facture
      // de performance monitoring.
      tracesSampleRate: 0,
      // Les erreurs déjà classées « bruit opérationnel » par le tri n'ont rien
      // à faire dans Sentry non plus : elles noieraient les vrais bugs.
      beforeSend(event) {
        const msg = event.exception?.values?.[0]?.value || event.message || '';
        if (/\b(429|rate ?limit|ECONNRESET|ETIMEDOUT|fetch failed|AbortError)\b/i.test(msg)) return null;
        return event;
      },
    });
    initialized = true;
    slog('info', 'sentry.initialized', { environment: process.env.NODE_ENV });
    return { ok: true, reason: 'Sentry actif' };
  } catch (e: any) {
    initFailed = e?.message || String(e);
    slog('warn', 'sentry.init_failed', { reason: initFailed });
    return { ok: false, reason: `initialisation Sentry en échec : ${initFailed}` };
  }
}

/** Envoie une erreur à Sentry. Sans effet si Sentry n'est pas actif. */
export function captureError(err: unknown, context?: Record<string, any>): void {
  if (!initialized || !sdk) return;
  try {
    sdk.withScope((scope) => {
      if (context) {
        for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
        if (context.route) scope.setTag('route', String(context.route));
      }
      sdk!.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch { /* la capture ne doit jamais casser la requête */ }
}

export function sentryState() {
  return {
    captureConfigured: isSentryConfigured(),
    captureActive: initialized,
    apiConfigured: isSentryApiConfigured(),
    org: sentryOrg() || null,
    project: sentryProject() || null,
    apiBase: sentryApiBase(),
    initError: initFailed,
  };
}

/**
 * Vérifie réellement la liaison de lecture : un appel authentifié au projet.
 * Distingue les trois pannes qu'on confond sinon — jeton absent, mauvaise
 * région, portées insuffisantes.
 */
export async function checkSentryApi(): Promise<{ ok: boolean; reason: string }> {
  if (!sentryToken()) return { ok: false, reason: 'aucun SENTRY_AUTH_TOKEN configuré' };
  const org = sentryOrg(), project = sentryProject();
  if (!org || !project) return { ok: false, reason: 'SENTRY_ORG ou SENTRY_PROJECT manquant' };

  const base = sentryApiBase();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    const res = await fetch(`${base}/api/0/projects/${org}/${project}/`, {
      headers: { Authorization: `Bearer ${sentryToken()}` },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (res.ok) return { ok: true, reason: `lecture Sentry opérationnelle (${base}, ${org}/${project})` };
    if (res.status === 403) {
      return { ok: false, reason: `jeton refusé par ${base} : portées de lecture manquantes (event:read + project:read)` };
    }
    if (res.status === 404) {
      return { ok: false, reason: `projet ${org}/${project} introuvable sur ${base} — slug ou région incorrects` };
    }
    return { ok: false, reason: `HTTP ${res.status} depuis ${base}` };
  } catch (e: any) {
    return { ok: false, reason: `API Sentry injoignable : ${e?.message || e}` };
  }
}

// ── Relecture des anomalies via l'API Sentry ────────────────────────────────

interface SentryIssue {
  id: string;
  title: string;
  culprit?: string;
  metadata?: { type?: string; value?: string; filename?: string };
  lastSeen?: string;
  count?: string;
  permalink?: string;
}

async function sentryFetch(pathname: string): Promise<any | null> {
  const token = sentryToken();
  if (!token) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    const res = await fetch(`${sentryApiBase()}/api/0${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      // 403 sur un jeton valide = portées manquantes : les jetons créés par
      // l'assistant d'installation n'ont que `project:releases` et ne peuvent
      // pas relire les anomalies. Le dire explicitement, sinon on cherche la
      // panne du mauvais côté.
      const hint = res.status === 403
        ? ' — jeton sans portée de lecture (event:read + project:read requis)'
        : '';
      slog('warn', 'sentry.api_error', {
        pathname, status: res.status, base: sentryApiBase(),
        body: (await res.text()).slice(0, 300) + hint,
      });
      return null;
    }
    return await res.json();
  } catch (e: any) {
    slog('warn', 'sentry.api_unreachable', { pathname, reason: e?.message || String(e) });
    return null;
  }
}

/**
 * Reconstruit une pile d'appel exploitable depuis le dernier événement d'une
 * anomalie. Sans ça, l'auto-réparation n'a qu'un titre et ne peut rien
 * localiser : c'est l'étape qui rend le déclenchement Sentry utilisable.
 */
async function stackForIssue(issueId: string): Promise<string | null> {
  const ev = await sentryFetch(`/issues/${issueId}/events/latest/`);
  if (!ev) return null;
  const exc = (ev.entries || []).find((e: any) => e.type === 'exception');
  const frames: string[] = [];
  for (const val of exc?.data?.values || []) {
    for (const f of val?.stacktrace?.frames || []) {
      const file = f.absPath || f.filename;
      if (!file) continue;
      frames.push(`    at ${f.function || '<anonyme>'} (${file}:${f.lineNo ?? 0}:${f.colNo ?? 0})`);
    }
  }
  // Sentry range les frames de la plus ancienne à la plus récente : on inverse
  // pour retrouver l'ordre d'une pile JavaScript (la cause en premier).
  return frames.length ? frames.reverse().join('\n') : null;
}

/** Anomalies non résolues vues récemment, converties au format du tri interne. */
export async function fetchSentryErrors(sinceMinutes = 15): Promise<RawError[]> {
  if (!isSentryApiConfigured()) return [];
  const org = sentryOrg(), project = sentryProject();
  const data = await sentryFetch(
    `/projects/${org}/${project}/issues/?query=${encodeURIComponent('is:unresolved')}&statsPeriod=24h&limit=25`,
  );
  if (!Array.isArray(data)) return [];

  const cutoff = Date.now() - sinceMinutes * 60_000;
  const out: RawError[] = [];
  for (const issue of data as SentryIssue[]) {
    const seen = issue.lastSeen ? new Date(issue.lastSeen).getTime() : 0;
    if (seen < cutoff) continue;
    const type = issue.metadata?.type || '';
    const value = issue.metadata?.value || issue.title || '';
    const stack = await stackForIssue(issue.id);
    out.push({
      id: issue.id,
      source: 'sentry',
      level: 'error',
      message: [type, value].filter(Boolean).join(': ').slice(0, 4000) || issue.title,
      stack,
      metadata: JSON.stringify({ permalink: issue.permalink, count: issue.count, culprit: issue.culprit }),
    });
  }
  return out;
}
