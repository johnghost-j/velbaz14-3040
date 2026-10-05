// ─── Routes HTTP : connexion Google Ads / Meta Ads + envoi des pubs ──────────

import type { Hono } from 'hono';
import { encryptSecret, decryptSecret, getSecret } from '../secret-store';
import {
  AD_PROVIDERS, AD_PROVIDER_LABEL, AdApiError, isAdProvider, missingAdKeys,
  googleAuthUrl, metaAuthUrl, googleExchangeCode, metaExchangeCode,
  type AdProvider,
} from './providers';
import { listConnections, getConnection, setSelection, deleteConnection, listPushes } from './store';
import { syncAccounts, freshToken, publicConnection, pushAdDraft } from './service';

const STATE_TTL_MS = 15 * 60 * 1000;

type AdState = { c: string; p: AdProvider; u: string; t: number; r: string };

function encodeState(s: AdState): string {
  return Buffer.from(encryptSecret(JSON.stringify(s)), 'utf8').toString('base64url');
}
function decodeState(raw: string): AdState | null {
  try {
    const plain = decryptSecret(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!plain) return null;
    const s = JSON.parse(plain) as AdState;
    if (!s.c || !s.p || !s.r || Date.now() - (s.t || 0) > STATE_TTL_MS) return null;
    return s;
  } catch {
    return null;
  }
}

function safeOrigin(value?: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Base des URL de retour OAuth : origine réelle du navigateur, comme pour les réseaux sociaux. */
function baseUrl(c: any, clientOrigin?: string | null): string {
  const forced = getSecret('OAUTH_REDIRECT_BASE');
  if (forced) return forced.replace(/\/$/, '');
  const fromClient = safeOrigin(clientOrigin);
  if (fromClient && !/\/\/(localhost|127\.0\.0\.1)(:|$)/.test(fromClient)) return fromClient;
  const ref = safeOrigin(c.req.header('referer'));
  if (ref && !/\/\/(localhost|127\.0\.0\.1)(:|$)/.test(ref)) return ref;
  const host = c.req.header('x-forwarded-host') || c.req.header('host');
  if (host && !/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) return `${c.req.header('x-forwarded-proto') || 'https'}://${host}`;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return fromClient || new URL(c.req.url).origin;
}

const callbackPath = (p: AdProvider) => `/api/ad-accounts/callback/${p}`;

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function resultPage(ok: boolean, provider: string, companyId: string | null, message: string): string {
  const label = isAdProvider(provider) ? AD_PROVIDER_LABEL[provider] : provider;
  const payload = JSON.stringify({ type: ok ? 'ad-oauth-success' : 'ad-oauth-error', provider, error: ok ? null : message });
  const back = companyId ? `/company/${encodeURIComponent(companyId)}?tab=ads` : '/';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(label)}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}.c{text-align:center;padding:2rem;max-width:420px}.ok{color:#22c55e;font-size:28px}.ko{color:#ef4444;font-size:28px}p{line-height:1.5}small{color:#888}</style></head>
<body><div class="c"><div class="${ok ? 'ok' : 'ko'}">${ok ? '&#10003;' : '&#10007;'}</div>
<p>${ok ? `${esc(label)} connecté.` : `Connexion ${esc(label)} impossible.`}</p><small>${esc(message)}</small>
<p><a href="${back}" style="color:#4EAADC">Retour au projet</a></p></div>
<script>try{if(window.opener){window.opener.postMessage(${payload},'*');setTimeout(function(){window.close()},1800);}else{setTimeout(function(){location.href=${JSON.stringify(back)}},2500);}}catch(e){}</script>
</body></html>`;
}

export function registerAdAccountRoutes(
  app: Hono<any>,
  deps: {
    getUser: (c: any) => Promise<any>;
    accessibleCompany: (companyId: string, user: any) => Promise<any>;
    isAdminUser: (user: any) => boolean;
  },
) {
  const { getUser, accessibleCompany, isAdminUser } = deps;

  async function load(c: any, ownerOnly: boolean): Promise<{ user: any; company: any } | Response> {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const company = await accessibleCompany(c.req.param('id'), user);
    if (!company) return c.json({ error: 'Not found' }, 404);
    if (ownerOnly && company.userId !== user.id && !isAdminUser(user)) {
      return c.json({ error: 'Seul le propriétaire du projet peut gérer les comptes publicitaires.' }, 403);
    }
    return { user, company };
  }

  function providerParam(c: any): AdProvider | null {
    const p = String(c.req.param('provider') || '');
    return isAdProvider(p) ? p : null;
  }

  /** Quelles régies sont configurées (clés) et l'URL de retour exacte à déclarer. */
  app.get('/ad-accounts/config', (c) => {
    const base = baseUrl(c, c.req.query('origin'));
    return c.json({
      providers: AD_PROVIDERS.map((p) => ({
        provider: p,
        label: AD_PROVIDER_LABEL[p],
        configured: missingAdKeys(p).length === 0,
        missingKeys: missingAdKeys(p),
        callbackUrl: `${base}${callbackPath(p)}`,
      })),
    });
  });

  /** État des connexions du projet + historique des envois. */
  app.get('/companies/:id/ad-accounts', async (c) => {
    const ctx = await load(c, false);
    if (ctx instanceof Response) return ctx;
    const conns = await listConnections(ctx.company.id);
    const pushes = await listPushes(ctx.company.id);
    return c.json({
      providers: AD_PROVIDERS.map((p) => {
        const conn = conns.find((x) => x.provider === p);
        return {
          provider: p,
          label: AD_PROVIDER_LABEL[p],
          configured: missingAdKeys(p).length === 0,
          missingKeys: missingAdKeys(p),
          connection: conn ? publicConnection(conn) : null,
        };
      }),
      pushes: pushes.map((x) => ({ ...x, createdAt: x.createdAt ? x.createdAt.getTime() : null })),
    });
  });

  /** Démarre l'OAuth de la régie (renvoie l'URL à ouvrir en popup). */
  app.post('/companies/:id/ad-accounts/connect', async (c) => {
    const ctx = await load(c, true);
    if (ctx instanceof Response) return ctx;
    const body = await c.req.json().catch(() => ({} as any));
    const provider = String(body?.provider || '');
    if (!isAdProvider(provider)) return c.json({ error: 'Régie inconnue (google_ads ou meta_ads).' }, 400);
    const missing = missingAdKeys(provider);
    if (missing.length) {
      return c.json({
        error: 'not_configured',
        message: `${AD_PROVIDER_LABEL[provider]} n'est pas encore configuré : il manque ${missing.join(', ')} dans Admin → API Keys.`,
        missingKeys: missing,
      }, 501);
    }
    const redirectUri = `${baseUrl(c, body?.origin)}${callbackPath(provider)}`;
    const state = encodeState({ c: ctx.company.id, p: provider, u: ctx.user.id, t: Date.now(), r: redirectUri });
    const authUrl = provider === 'google_ads' ? googleAuthUrl(state, redirectUri) : metaAuthUrl(state, redirectUri);
    return c.json({ authUrl, redirectUri });
  });

  /** Retour OAuth (popup) : échange du code, lecture des comptes, enregistrement. */
  app.get('/ad-accounts/callback/:provider', async (c) => {
    const provider = String(c.req.param('provider') || '');
    const state = decodeState(String(c.req.query('state') || ''));
    if (!state || state.p !== provider || !isAdProvider(provider)) {
      return c.html(resultPage(false, provider, state?.c || null, 'Lien de connexion invalide ou expiré (15 min) — relance la connexion.'));
    }
    const denied = c.req.query('error_description') || c.req.query('error_message') || c.req.query('error');
    if (denied) return c.html(resultPage(false, provider, state.c, `Autorisation refusée : ${denied}`));
    const code = String(c.req.query('code') || '');
    if (!code) return c.html(resultPage(false, provider, state.c, 'Code d\'autorisation absent.'));
    try {
      const tokens = provider === 'google_ads'
        ? await googleExchangeCode(code, state.r)
        : await metaExchangeCode(code, state.r);
      const { accounts } = await syncAccounts(state.c, provider, tokens);
      const usable = accounts.filter((a) => !a.manager).length;
      const msg = accounts.length
        ? `${accounts.length} compte(s) trouvé(s)${usable === 1 ? ', sélectionné automatiquement' : usable > 1 ? ' — choisis celui à utiliser dans Velbaz' : ''}.`
        : 'Connecté, mais aucun compte publicitaire n\'est accessible avec ce profil.';
      return c.html(resultPage(true, provider, state.c, msg));
    } catch (e: any) {
      const msg = e instanceof AdApiError ? e.message : `Erreur réseau : ${e?.message || 'inconnue'}`;
      console.error(`[ad-accounts] callback ${provider} failed:`, msg);
      return c.html(resultPage(false, provider, state.c, msg));
    }
  });

  /** Relit la liste des comptes (après en avoir créé un, par ex.). */
  app.post('/companies/:id/ad-accounts/:provider/refresh', async (c) => {
    const ctx = await load(c, true);
    if (ctx instanceof Response) return ctx;
    const provider = providerParam(c);
    if (!provider) return c.json({ error: 'Régie inconnue.' }, 400);
    const conn = await getConnection(ctx.company.id, provider);
    if (!conn) return c.json({ error: 'Compte non connecté.' }, 404);
    try {
      const token = await freshToken(conn);
      await syncAccounts(ctx.company.id, provider, {
        accessToken: token, refreshToken: conn.refreshToken, expiresAt: conn.tokenExpiresAt, externalUser: conn.externalUser,
      });
      const updated = await getConnection(ctx.company.id, provider);
      return c.json({ ok: true, connection: updated ? publicConnection(updated) : null });
    } catch (e: any) {
      return c.json({ error: e instanceof AdApiError ? e.message : String(e?.message || e) }, e instanceof AdApiError && e.status < 500 ? e.status as any : 502);
    }
  });

  /** Choix du compte publicitaire (et de la Page Facebook pour Meta). */
  app.post('/companies/:id/ad-accounts/:provider/select', async (c) => {
    const ctx = await load(c, true);
    if (ctx instanceof Response) return ctx;
    const provider = providerParam(c);
    if (!provider) return c.json({ error: 'Régie inconnue.' }, 400);
    const conn = await getConnection(ctx.company.id, provider);
    if (!conn) return c.json({ error: 'Compte non connecté.' }, 404);
    const body = await c.req.json().catch(() => ({} as any));
    const patch: { accountId?: string | null; pageId?: string | null } = {};
    if (body.accountId !== undefined) {
      const acc = conn.accounts.find((a) => a.id === String(body.accountId));
      if (body.accountId && !acc) return c.json({ error: 'Compte inconnu.' }, 400);
      if (acc?.manager) return c.json({ error: 'Un compte administrateur (MCC) ne peut pas porter de campagne : choisis un compte client.' }, 400);
      patch.accountId = body.accountId ? String(body.accountId) : null;
    }
    if (body.pageId !== undefined) {
      if (body.pageId && !conn.pages.some((p) => p.id === String(body.pageId))) return c.json({ error: 'Page inconnue.' }, 400);
      patch.pageId = body.pageId ? String(body.pageId) : null;
    }
    await setSelection(ctx.company.id, provider, patch);
    const updated = await getConnection(ctx.company.id, provider);
    return c.json({ ok: true, connection: updated ? publicConnection(updated) : null });
  });

  /** Déconnexion (supprime les jetons ; rien n'est touché chez la régie). */
  app.delete('/companies/:id/ad-accounts/:provider', async (c) => {
    const ctx = await load(c, true);
    if (ctx instanceof Response) return ctx;
    const provider = providerParam(c);
    if (!provider) return c.json({ error: 'Régie inconnue.' }, 400);
    const removed = await deleteConnection(ctx.company.id, provider);
    return c.json({ ok: true, removed });
  });

  /** Envoie une pub générée sur la régie : campagne créée EN PAUSE. */
  app.post('/companies/:id/ads/:adId/push', async (c) => {
    const ctx = await load(c, true);
    if (ctx instanceof Response) return ctx;
    const body = await c.req.json().catch(() => ({} as any));
    const provider = body?.provider && isAdProvider(String(body.provider)) ? String(body.provider) as AdProvider : null;
    const res = await pushAdDraft({
      companyId: ctx.company.id,
      adId: c.req.param('adId'),
      provider,
      dailyBudget: body?.dailyBudget != null ? Number(body.dailyBudget) : null,
    });
    if (!res.ok) return c.json({ error: res.error, code: res.code }, res.status as any);
    return c.json(res);
  });
}
