// ─── Routes admin de l'auto-réparation ─────────────────────────────────────
//
// Montées sur l'app Hono depuis index.ts via registerSelfHealRoutes(app, deps).
// Toutes protégées par requireAdmin : ces routes peuvent déclencher l'écriture
// de code source, elles ne sont jamais ouvertes.
//
import {
  listAttempts, selfHealStatus, scanAndHeal, healError,
  startSelfHealWatcher, stopSelfHealWatcher,
} from './healer';
import { setSelfHealEnabled, resetCircuitBreaker } from './guard';
import { initSentry, fetchSentryErrors, isSentryApiConfigured, sentryState, checkSentryApi } from './sentry';

type RequireAdmin = (c: any) => Promise<any | null>;

export function registerSelfHealRoutes(app: any, deps: { requireAdmin: RequireAdmin }) {
  const { requireAdmin } = deps;

  /** État global : interrupteur, veille, Sentry, quotas, historique par statut. */
  app.get('/admin/selfheal', async (c: any) => {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: 'Forbidden' }, 403);
    const [status, attempts] = await Promise.all([selfHealStatus(), listAttempts(50)]);
    return c.json({ ...status, attempts }, 200);
  });

  /** Interrupteur d'arrêt d'urgence. */
  app.post('/admin/selfheal/toggle', async (c: any) => {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const enabled = !!body?.enabled;
    await setSelfHealEnabled(enabled, admin?.id);
    if (enabled) startSelfHealWatcher(); else stopSelfHealWatcher();
    return c.json({ ok: true, enabled }, 200);
  });

  /** Réarme le coupe-circuit après une série d'annulations. */
  app.post('/admin/selfheal/reset-breaker', async (c: any) => {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: 'Forbidden' }, 403);
    const cleared = await resetCircuitBreaker(admin?.id);
    return c.json({ ok: true, cleared }, 200);
  });

  /** Balayage immédiat, sans attendre le prochain passage de la veille. */
  app.post('/admin/selfheal/scan', async (c: any) => {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: 'Forbidden' }, 403);
    const result = await scanAndHeal();
    return c.json({ ok: true, result }, 200);
  });

  /**
   * Réparation d'une erreur fournie à la main (ou relance forcée d'une erreur
   * déjà traitée, via force=true). Sert aussi à tester la chaîne complète.
   */
  app.post('/admin/selfheal/heal', async (c: any) => {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const message = (body?.message || '').toString().trim();
    if (!message) return c.json({ error: 'message required' }, 400);
    const result = await healError({
      id: `manual-${Date.now()}`,
      source: (body?.source || 'manual').toString(),
      level: 'error',
      message,
      stack: body?.stack ? String(body.stack) : null,
      companyId: null,
    }, { force: !!body?.force });
    return c.json({ ok: true, result }, 200);
  });

  /** Diagnostic de la liaison Sentry (sans exposer les clés). */
  app.get('/admin/selfheal/sentry', async (c: any) => {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: 'Forbidden' }, 403);
    const state = sentryState();
    let issues: any[] = [];
    let apiCheck: { ok: boolean; reason: string } | null = null;
    if (isSentryApiConfigured()) {
      // Sonder la liaison avant de lister : sans ça, une liste vide ne dit pas
      // si tout va bien ou si le jeton est refusé.
      apiCheck = await checkSentryApi();
      if (apiCheck.ok) {
        issues = (await fetchSentryErrors(24 * 60)).map(e => ({
          sentryIssueId: e.id ?? null,
          message: e.message,
          hasStack: !!e.stack,
        }));
      }
    }
    return c.json({ ...state, apiCheck, issues }, 200);
  });

  /** Relance l'init du SDK après avoir collé le DSN dans le panneau secrets. */
  app.post('/admin/selfheal/sentry/init', async (c: any) => {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: 'Forbidden' }, 403);
    const res = await initSentry();
    return c.json({ ...res, state: sentryState() }, 200);
  });
}
