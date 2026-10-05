// ─── Routes HTTP : appels en direct + SMS ───────────────────────────────────
//
// Bêta ADMIN (comme le Growth Engine) : ces routes passent de vrais appels et
// envoient de vrais SMS dès que la clé Bland est là. Pour les autres comptes
// elles répondent 404 (la feature reste invisible).
//
// Sécurité :
//  - routes utilisateur : session obligatoire + propriétaire de l'appel/du fil ;
//  - routes /hooks/* (appelées par Bland, sans session) : authentifiées par un
//    jeton aléatoire de 192 bits propre à chaque appel / fil, jamais exposé au
//    navigateur ; un appel Bland qui ne correspond pas au call_id attendu est
//    refusé.

import type { Hono } from 'hono';
import { getCall, getInboundLine, listCallEvents, listInboundCalls, listRecentDecidedInbound, listRingingInbound, upsertInboundLine, waitFor } from './store';
import {
  TERMINAL, contextForHook, createLiveCall, handleCallHook, hangUp, instructCall, listenFor, maybeSyncRealCall, publicCall,
} from './live-calls';
import { getThread, handleSmsHook, listSmsMessages, publicThread, sendInThread, startSmsThread, syncThread } from './sms';
import { buildInboundTask, suggestSmsReply } from './brain';
import { blandCallsReady, configureInboundNumber, isDemoCompany } from './bland';
import { answerInbound, handleInboundHook, inboundContext, startInboundCall } from './inbound';
import { blandVoiceFor, synthesize, ttsAllowed } from './voice';

interface Deps {
  getUser: (c: any) => Promise<any>;
  isAdmin: (user: any) => boolean;
  /** Le compte a-t-il droit aux appels / SMS ? (plans payants + admins) */
  canUseComms: (user: any) => boolean;
  /** Entreprise si l'utilisateur en est propriétaire (ou admin), sinon null. */
  ownedCompany: (user: any, companyId: string) => Promise<{ id: string; name?: string | null } | null>;
}

export function originOf(c: any): string {
  const env = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  if (env) return env;
  const proto = c.req.header('x-forwarded-proto');
  const host = c.req.header('x-forwarded-host') || c.req.header('host');
  if (proto && host) return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
  try { return new URL(c.req.url).origin; } catch { return ''; }
}

export function registerCallRoutes(app: Hono<any>, deps: Deps) {
  async function gate(c: any): Promise<{ ok: true; user: any } | { ok: false; res: Response }> {
    const user = await deps.getUser(c);
    if (!user) return { ok: false, res: c.json({ error: 'Unauthorized' }, 401) };
    if (!deps.canUseComms(user)) {
      return { ok: false, res: c.json({ error: 'Les appels et SMS de l’IA sont réservés aux plans Business et Enterprise.', code: 'plan_required', upgradeTo: 'business' }, 403) };
    }
    return { ok: true, user };
  }
  const owns = (user: any, row: { userId: string }) => String(row.userId) === String(user.id) || deps.isAdmin(user);

  async function loadCall(c: any) {
    const g = await gate(c);
    if (!g.ok) return g;
    const row = await getCall(String(c.req.param('id') || ''));
    if (!row || !owns(g.user, row)) return { ok: false as const, res: c.json({ error: 'Appel introuvable' }, 404) };
    return { ok: true as const, user: g.user, row };
  }
  async function loadThread(c: any) {
    const g = await gate(c);
    if (!g.ok) return g;
    const row = await getThread(String(c.req.param('id') || ''));
    if (!row || !owns(g.user, row)) return { ok: false as const, res: c.json({ error: 'Conversation introuvable' }, 404) };
    return { ok: true as const, user: g.user, row };
  }

  // ── Appels ────────────────────────────────────────────────────────────────

  app.post('/live-calls', async (c) => {
    const g = await gate(c);
    if (!g.ok) return g.res;
    const b = await c.req.json().catch(() => ({} as any));
    const company = await deps.ownedCompany(g.user, String(b.companyId || ''));
    if (!company) return c.json({ error: 'Projet introuvable' }, 404);
    const r = await createLiveCall({
      companyId: company.id, userId: g.user.id, companyName: company.name || undefined,
      to: b.to, contactName: b.name, goal: b.goal, language: b.language, origin: originOf(c),
    });
    if (!r.ok) return c.json({ error: r.error, code: r.code }, 400);
    return c.json({ call: publicCall(r.call) }, 201);
  });

  app.get('/live-calls/:id', async (c) => {
    const got = await loadCall(c);
    if (!got.ok) return got.res;
    await maybeSyncRealCall(got.row).catch(() => {});
    const row = (await getCall(got.row.id)) || got.row;
    return c.json({ call: publicCall(row), events: await listCallEvents(row.id) }, 200);
  });

  // Flux SSE : état + événements au fil de l'eau. Le client lit ce flux avec
  // fetch() (en-tête Authorization), pas EventSource. `after` = dernier id reçu,
  // pour reprendre sans doublon après une coupure.
  app.get('/live-calls/:id/stream', async (c) => {
    const got = await loadCall(c);
    if (!got.ok) return got.res;
    const id = got.row.id;
    let after = Math.max(0, Number(c.req.query('after') || 0) || 0);
    const enc = new TextEncoder();
    const abort = c.req.raw.signal;
    const stream = new ReadableStream({
      async start(ctrl) {
        let closed = false;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try { ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; }
        };
        abort?.addEventListener('abort', () => { closed = true; });
        const started = Date.now();
        let lastState = '';
        let lastPing = Date.now();
        try {
          while (!closed && Date.now() - started < 35 * 60_000) {
            let row = await getCall(id);
            if (!row) break;
            await maybeSyncRealCall(row).catch(() => {});
            row = (await getCall(id)) || row;
            const evs = await listCallEvents(id, after);
            for (const e of evs) { send('event', e); after = e.id; }
            const sig = `${row.status}|${row.updatedAt}`;
            if (sig !== lastState) { lastState = sig; send('state', publicCall(row)); }
            if (TERMINAL.has(row.status) && !evs.length && Date.now() - (row.endedAt || 0) > 8000) { send('end', { id }); break; }
            if (Date.now() - lastPing > 15_000) { lastPing = Date.now(); try { ctrl.enqueue(enc.encode(': ping\n\n')); } catch { closed = true; } }
            await waitFor(id, 900);
          }
        } catch (e: any) {
          send('error', { error: String(e?.message || e) });
        }
        try { ctrl.close(); } catch { /* déjà fermé */ }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
    });
  });

  app.post('/live-calls/:id/instruct', async (c) => {
    const got = await loadCall(c);
    if (!got.ok) return got.res;
    const b = await c.req.json().catch(() => ({} as any));
    const r = await instructCall(got.row, String(b.text || ''));
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json(r, 200);
  });

  // Voix Bland d'une réplique de l'appel (WAV). Seules les répliques déjà
  // présentes dans le journal de CET appel sont lisibles : l'endpoint ne peut
  // pas servir de synthèse vocale libre.
  app.post('/live-calls/:id/tts', async (c) => {
    const got = await loadCall(c);
    if (!got.ok) return got.res;
    const b = await c.req.json().catch(() => ({} as any));
    const eventId = Number(b?.eventId);
    if (!Number.isFinite(eventId) || eventId <= 0) return c.json({ error: 'eventId manquant' }, 400);
    const ev = (await listCallEvents(got.row.id, eventId - 1)).find((e) => e.id === eventId);
    if (!ev || (ev.kind !== 'ai' && ev.kind !== 'contact')) return c.json({ error: 'Réplique introuvable' }, 404);
    if (!ttsAllowed(String(got.user.id))) return c.json({ error: 'Trop de lectures, réessaie dans un moment.', code: 'tts_rate' }, 429);
    const r = await synthesize(ev.text, blandVoiceFor(ev.kind, got.row.language));
    if (!r.ok) return c.json({ error: r.error, code: 'tts_failed' }, r.status as any);
    return new Response(r.audio, { status: 200, headers: { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=3600' } });
  });

  app.post('/live-calls/:id/stop', async (c) => {
    const got = await loadCall(c);
    if (!got.ok) return got.res;
    const r = await hangUp(got.row);
    if (!r.ok) return c.json({ error: r.error || 'Impossible de raccrocher' }, 502);
    const row = (await getCall(got.row.id)) || got.row;
    return c.json({ call: publicCall(row) }, 200);
  });

  app.post('/live-calls/:id/listen', async (c) => {
    const got = await loadCall(c);
    if (!got.ok) return got.res;
    const r = await listenFor(got.row);
    if (!r.ok) return c.json({ error: r.error, code: (r as any).code }, (r as any).code === 'sim' ? 409 : 400);
    return c.json({ url: r.url, format: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } }, 200);
  });

  // ── Webhooks Bland (publics, authentifiés par jeton) ─────────────────────
  app.post('/hooks/live-calls/:token', async (c) => {
    const body = await c.req.json().catch(() => null);
    const r = await handleCallHook(String(c.req.param('token') || ''), body);
    return c.json({ ok: r.ok }, r.status as any);
  });
  const ctxHandler = async (c: any) => {
    const r = await contextForHook(String(c.req.param('token') || ''));
    return c.json(r.body, r.status as any);
  };
  app.get('/hooks/live-calls/:token/context', ctxHandler);
  app.post('/hooks/live-calls/:token/context', ctxHandler);

  app.post('/hooks/sms/:token', async (c) => {
    const body = await c.req.json().catch(() => null);
    const status = await handleSmsHook(String(c.req.param('token') || ''), body);
    return c.json({ ok: status === 200 }, status as any);
  });

  // ── Appels ENTRANTS ───────────────────────────────────────────────────────

  // Popup globale : appels entrants qui sonnent chez l'utilisateur (sondé ~2 s).
  // Volontairement limité aux projets de l'utilisateur, même pour un admin.
  app.get('/inbound/ringing', async (c) => {
    const g = await gate(c);
    if (!g.ok) return g.res;
    const rows = await listRingingInbound(String(g.user.id), false);
    const calls = await Promise.all(rows.map(async (r) => {
      const company = await deps.ownedCompany(g.user, r.companyId).catch(() => null);
      return { ...publicCall(r), companyName: company?.name || null };
    }));
    const recent = (await listRecentDecidedInbound(String(g.user.id))).map((r) => ({ id: r.id, companyId: r.companyId, inboundState: r.inboundState, status: r.status }));
    return c.json({ calls, recent, now: Date.now() }, 200);
  });

  app.post('/live-calls/:id/answer', async (c) => {
    const got = await loadCall(c);
    if (!got.ok) return got.res;
    const b = await c.req.json().catch(() => ({} as any));
    const action = b.action === 'decline' ? 'decline' : b.action === 'accept' ? 'accept' : null;
    if (!action) return c.json({ error: 'Action inconnue' }, 400);
    const r = await answerInbound(got.row, action);
    if (!r.ok) return c.json({ error: r.error }, 409);
    const row = (await getCall(got.row.id)) || got.row;
    return c.json({ call: publicCall(row) }, 200);
  });

  // Simulation d'un appel entrant (bouton de test, projet démo).
  app.post('/inbound/simulate', async (c) => {
    const g = await gate(c);
    if (!g.ok) return g.res;
    const b = await c.req.json().catch(() => ({} as any));
    const company = await deps.ownedCompany(g.user, String(b.companyId || ''));
    if (!company) return c.json({ error: 'Projet introuvable' }, 404);
    const ringing = await listRingingInbound(String(g.user.id), false);
    if (ringing.length >= 2) return c.json({ error: 'Deux appels sonnent déjà, réponds d’abord.' }, 429);
    const row = await startInboundCall({ companyId: company.id, userId: String(g.user.id), mode: 'sim' });
    return c.json({ call: publicCall(row) }, 201);
  });

  const lineView = async (companyId: string) => {
    const line = await getInboundLine(companyId);
    const recent = await listInboundCalls(companyId, 10);
    return {
      line: line ? { phoneNumber: line.phoneNumber, configuredAt: line.configuredAt, lastError: line.lastError } : null,
      blandReady: blandCallsReady(),
      demo: isDemoCompany(companyId),
      recent: recent.map((r) => publicCall(r)),
    };
  };

  app.get('/companies/:id/inbound-line', async (c) => {
    const g = await gate(c);
    if (!g.ok) return g.res;
    const company = await deps.ownedCompany(g.user, String(c.req.param('id') || ''));
    if (!company) return c.json({ error: 'Projet introuvable' }, 404);
    return c.json(await lineView(company.id), 200);
  });

  // Enregistre le numéro Bland du projet et configure l'agent qui y répond.
  app.post('/companies/:id/inbound-line', async (c) => {
    const g = await gate(c);
    if (!g.ok) return g.res;
    const company = await deps.ownedCompany(g.user, String(c.req.param('id') || ''));
    if (!company) return c.json({ error: 'Projet introuvable' }, 404);
    const b = await c.req.json().catch(() => ({} as any));
    const raw = String(b.phoneNumber || '').replace(/[\s.\-()]/g, '');
    const phone = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return c.json({ error: 'Numéro invalide : format international, ex. +33…' }, 400);
    if (!blandCallsReady()) return c.json({ error: 'Clé Bland absente : impossible de configurer la ligne.' }, 400);
    const origin = originOf(c);
    if (!/^https:\/\//.test(origin)) return c.json({ error: 'Il faut une adresse publique en https (PUBLIC_APP_URL) pour recevoir les appels.' }, 400);
    const line = await upsertInboundLine(company.id, String(g.user.id), { phoneNumber: phone });
    const hook = `${origin}/api/hooks/inbound/${line.hookToken}`;
    const r = await configureInboundNumber({
      number: phone,
      prompt: buildInboundTask({ companyName: company.name || undefined, language: 'fr' }),
      language: 'fr',
      webhookUrl: hook,
      contextUrl: `${hook}/context`,
    });
    await upsertInboundLine(company.id, String(g.user.id), r.ok ? { configuredAt: Date.now(), lastError: null } : { lastError: r.error });
    if (!r.ok) return c.json({ error: `Bland a refusé : ${r.error}`, ...(await lineView(company.id)) }, 502);
    return c.json(await lineView(company.id), 200);
  });

  // Webhooks Bland de la ligne entrante (publics, authentifiés par jeton).
  app.post('/hooks/inbound/:token', async (c) => {
    const body = await c.req.json().catch(() => null);
    const r = await handleInboundHook(String(c.req.param('token') || ''), body);
    return c.json({ ok: r.ok }, r.status as any);
  });
  const inboundCtx = async (c: any) => {
    const q = c.req.query() as Record<string, string>;
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => ({})) : {};
    const r = await inboundContext(String(c.req.param('token') || ''), { call_id: q.call_id || body?.call_id, from: q.from || body?.from });
    return c.json(r.body, r.status as any);
  };
  app.get('/hooks/inbound/:token/context', inboundCtx);
  app.post('/hooks/inbound/:token/context', inboundCtx);

  // ── SMS ───────────────────────────────────────────────────────────────────

  app.post('/sms-threads', async (c) => {
    const g = await gate(c);
    if (!g.ok) return g.res;
    const b = await c.req.json().catch(() => ({} as any));
    const company = await deps.ownedCompany(g.user, String(b.companyId || ''));
    if (!company) return c.json({ error: 'Projet introuvable' }, 404);
    const r = await startSmsThread({ companyId: company.id, userId: g.user.id, to: b.to, contactName: b.name, message: b.message, context: b.goal, origin: originOf(c) });
    if (!r.ok) return c.json({ error: r.error, code: r.code }, 400);
    return c.json(publicThread(r.thread, await listSmsMessages(r.thread.id)), 201);
  });

  app.get('/sms-threads/:id', async (c) => {
    const got = await loadThread(c);
    if (!got.ok) return got.res;
    await syncThread(got.row).catch(() => {});
    const row = (await getThread(got.row.id)) || got.row;
    return c.json(publicThread(row, await listSmsMessages(row.id)), 200);
  });

  app.post('/sms-threads/:id/messages', async (c) => {
    const got = await loadThread(c);
    if (!got.ok) return got.res;
    const b = await c.req.json().catch(() => ({} as any));
    const r = await sendInThread(got.row, b.body, originOf(c));
    if (!r.ok) return c.json({ error: r.error, code: r.code }, 400);
    const row = (await getThread(got.row.id)) || got.row;
    return c.json(publicThread(row, await listSmsMessages(row.id)), 201);
  });

  app.post('/sms-threads/:id/suggest', async (c) => {
    const got = await loadThread(c);
    if (!got.ok) return got.res;
    const company = await deps.ownedCompany(got.user, got.row.companyId);
    const history = (await listSmsMessages(got.row.id)).map((m) => ({ direction: m.direction, body: m.body }));
    const text = await suggestSmsReply({ companyName: company?.name || undefined, contactName: got.row.contactName, context: got.row.context, history });
    return c.json({ text }, 200);
  });
}
