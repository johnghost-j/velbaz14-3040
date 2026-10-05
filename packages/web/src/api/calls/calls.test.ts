import { afterAll, describe, expect, test } from 'bun:test';
// Jamais de vrai appel en test, même si une clé Bland est chargée.
process.env.CALLS_FORCE_SIM = '1';
import { client } from '../database/client';
import { normalizePhone, createLiveCall, handleCallHook, contextForHook, instructCall, hangUp, TERMINAL } from './live-calls';
import { applyCommsBlocks, hasCommsBlocks, stripCommsBlocks } from './blocks';
import { getCall, listCallEvents } from './store';
import { parseCallPayload } from './bland';

const CO = `test_calls_${Date.now()}`;
const USER = `test_calls_user_${Date.now()}`;

afterAll(async () => {
  await client.execute({ sql: 'DELETE FROM live_call_events WHERE call_id IN (SELECT id FROM live_calls WHERE company_id = ?)', args: [CO] });
  await client.execute({ sql: 'DELETE FROM live_calls WHERE company_id = ?', args: [CO] });
  await client.execute({ sql: 'DELETE FROM sms_messages WHERE thread_id IN (SELECT id FROM sms_threads WHERE company_id = ?)', args: [CO] });
  await client.execute({ sql: 'DELETE FROM sms_threads WHERE company_id = ?', args: [CO] });
  await client.execute({ sql: 'DELETE FROM inbound_lines WHERE company_id = ?', args: [CO] }).catch(() => {});
});

describe('normalizePhone', () => {
  test('numéros français', () => {
    expect(normalizePhone('06 12 34 56 78')).toBe('+33612345678');
    expect(normalizePhone('0033612345678')).toBe('+33612345678');
    expect(normalizePhone('+33 6.12.34.56.78')).toBe('+33612345678');
  });
  test('international et invalide', () => {
    expect(normalizePhone('+1 (415) 555-0123')).toBe('+14155550123');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('+0612345678')).toBeNull();
  });
});

describe('blocs [CALL] / [SMS]', () => {
  test('détection et retrait', () => {
    const t = 'Je l’appelle. [CALL]{"to":"+33612345678","goal":"rdv"}[/CALL] Voilà.';
    expect(hasCommsBlocks(t)).toBe(true);
    const stripped = stripCommsBlocks(t);
    expect(stripped).not.toContain('[CALL]');
    expect(stripped).toContain('Voilà');
    expect(stripCommsBlocks(t)).not.toContain('[CALL]');
    expect(stripCommsBlocks(t, 'Non autorisé')).toContain('[ALERT_VIEW]');
    expect(stripCommsBlocks('Ok [SMS]{"to":"+3361')).toBe('Ok');
  });
  test('bloc invalide → alerte, jamais de faux « envoyé »', async () => {
    const out = await applyCommsBlocks('A [CALL]{"to":"12","goal":"test"}[/CALL] [SMS]pas du json[/SMS]', { companyId: CO, userId: USER });
    expect(out).not.toContain('[CALL_VIEW]');
    expect(out).not.toContain('[SMS_VIEW]');
    expect((out.match(/\[ALERT_VIEW\]/g) || []).length).toBe(2);
  });
  test('SMS valide en simulation → [SMS_VIEW] avec ids', async () => {
    const out = await applyCommsBlocks('[SMS]{"to":"0612345678","name":"Test","message":"Bonjour","goal":"test"}[/SMS]', { companyId: CO, userId: USER });
    const m = out.match(/\[SMS_VIEW\]([\s\S]*?)\[\/SMS_VIEW\]/);
    expect(m).not.toBeNull();
    const d = JSON.parse(m![1]);
    expect(d.id).toMatch(/^st_/);
    expect(d.messageId).toBeTruthy();
  });
});

describe('appel simulé', () => {
  test('création, consigne, contexte Bland, raccrochage', async () => {
    const r = await createLiveCall({ companyId: CO, userId: USER, to: '+33612345678', contactName: 'Test', goal: 'Prendre un rendez-vous', language: 'fr' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.call.mode).toBe('sim');
    const ins = await instructCall(r.call, 'Propose jeudi 10h');
    expect(ins.ok).toBe(true);
    const ctx = await contextForHook(r.call.hookToken);
    expect(ctx.status).toBe(200);
    expect(ctx.body.instructions).toContain('jeudi');
    expect((await contextForHook('nope')).status).toBe(404);
    const h = await hangUp((await getCall(r.call.id))!);
    expect(h.ok).toBe(true);
    const row = await getCall(r.call.id);
    expect(TERMINAL.has(row!.status)).toBe(true);
    const kinds = (await listCallEvents(r.call.id)).map((e) => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('directive');
  });
  test('webhook : jeton inconnu refusé, call_id étranger refusé', async () => {
    expect((await handleCallHook('inconnu', { message: 'Agent speech: hi' })).status).toBe(404);
    const r = await createLiveCall({ companyId: CO, userId: USER, to: '+33612345679', goal: 'Test webhook', language: 'fr' });
    if (!r.ok) throw new Error(r.error);
    await hangUp(r.call);
    // Le jeton existe mais l'appel n'a pas encore d'id fournisseur : le premier call_id est adopté.
    expect((await handleCallHook(r.call.hookToken, { call_id: 'abc', message: 'Agent speech: Bonjour' })).status).toBe(200);
    expect((await handleCallHook(r.call.hookToken, { call_id: 'autre', message: 'Agent speech: x' })).status).toBe(403);
  });
});

describe('parseCallPayload', () => {
  test('transcription Bland', () => {
    const st = parseCallPayload({
      queue_status: 'complete', completed: true, summary: 'ok', recording_url: 'https://x/r.mp3',
      transcripts: [
        { id: 1, user: 'assistant', text: 'Bonjour', created_at: '2026-10-01T10:00:00Z' },
        { id: 2, user: 'user', text: 'Allô', created_at: '2026-10-01T10:00:02Z' },
        { id: 3, user: 'agent-action', text: 'transfer', created_at: '2026-10-01T10:00:03Z' },
      ],
    });
    expect(st.ended).toBe(true);
    expect(st.lines.filter((l) => l.who === 'ai').length).toBe(1);
    expect(st.lines.filter((l) => l.who === 'contact').length).toBe(1);
    expect(st.recordingUrl).toBe('https://x/r.mp3');
  });

  test('réponse réelle Bland : queue_status "started" mais status "completed" → terminé', () => {
    const st = parseCallPayload({ queue_status: 'started', status: 'completed', completed: false, transcripts: [] });
    expect(st.ended).toBe(true);
    expect(st.live).toBe(false);
  });

  test('appel en cours', () => {
    const st = parseCallPayload({ queue_status: 'started', status: 'in-progress', completed: false });
    expect(st.live).toBe(true);
    expect(st.ended).toBe(false);
  });
});

// ── Appels ENTRANTS ─────────────────────────────────────────────────────────
import { answerInbound, inboundContext, setInboundDeps, startInboundCall } from './inbound';
import { listRingingInbound, listRecentDecidedInbound, upsertInboundLine } from './store';

describe('appel entrant (simulation)', () => {
  const posted: { companyId: string; content: string }[] = [];
  let auto = false;
  setInboundDeps({
    isAutoOn: async () => auto,
    companyName: async () => 'Test Co',
    postChat: async (companyId, content) => { posted.push({ companyId, content }); },
  });
  const caller = { name: 'Testeur Entrant', reason: 'veut un devis' };
  const cleanup = async (id: string) => { const r = await getCall(id); if (r) await hangUp(r); };

  test('mode auto → l’IA décroche sans popup', async () => {
    auto = true;
    const row = await startInboundCall({ companyId: CO, userId: USER, mode: 'sim', simCaller: caller });
    expect(row.direction).toBe('in');
    expect(row.inboundState).toBe('auto');
    expect(row.ringUntil).toBeNull();
    expect((await listRingingInbound(USER)).some((c) => c.id === row.id)).toBe(false);
    expect(posted.some((p) => p.content.includes(`[CALL_VIEW]{"id":"${row.id}"}`))).toBe(true);
    await cleanup(row.id);
  });

  test('mode auto off → sonne (popup), « Répondre » → l’IA parle', async () => {
    auto = false;
    const row = await startInboundCall({ companyId: CO, userId: USER, mode: 'sim', simCaller: caller });
    expect(row.inboundState).toBe('pending');
    expect(row.ringUntil).toBeGreaterThan(Date.now());
    const ringing = await listRingingInbound(USER);
    expect(ringing.some((c) => c.id === row.id)).toBe(true);
    // Un autre utilisateur ne voit pas la popup.
    expect((await listRingingInbound(`${USER}_autre`)).some((c) => c.id === row.id)).toBe(false);
    const r = await answerInbound(row, 'accept');
    expect(r.ok).toBe(true);
    expect(r.state).toBe('accepted');
    // Deuxième décision ignorée : la première gagne.
    const again = await answerInbound((await getCall(row.id))!, 'decline');
    expect(again.state).toBe('accepted');
    expect((await listRingingInbound(USER)).some((c) => c.id === row.id)).toBe(false);
    expect((await listRecentDecidedInbound(USER)).some((c) => c.id === row.id)).toBe(true);
    expect(posted.some((p) => p.content.includes(row.id) && p.content.includes('je lui réponds'))).toBe(true);
    // Le runner de simulation décroche et l'IA parle.
    let live = false;
    for (let i = 0; i < 20 && !live; i++) {
      await new Promise((res) => setTimeout(res, 300));
      const evs = await listCallEvents(row.id);
      live = evs.some((e) => e.kind === 'ai');
    }
    expect(live).toBe(true);
    expect((await getCall(row.id))!.status).toBe('live');
    await cleanup(row.id);
  });

  test('« Refuser » → l’IA prend un message', async () => {
    auto = false;
    const row = await startInboundCall({ companyId: CO, userId: USER, mode: 'sim', simCaller: caller });
    const r = await answerInbound(row, 'decline');
    expect(r.state).toBe('declined');
    expect(posted.some((p) => p.content.includes(row.id) && p.content.includes('je prends un message'))).toBe(true);
    await cleanup(row.id);
  });

  test('pas de réponse à temps → l’IA décroche quand même', async () => {
    auto = false;
    const row = await startInboundCall({ companyId: CO, userId: USER, mode: 'sim', simCaller: caller, ringMs: 600 });
    expect(row.inboundState).toBe('pending');
    await new Promise((res) => setTimeout(res, 1200));
    const after = await getCall(row.id);
    expect(after!.inboundState).toBe('timeout');
    expect(posted.some((p) => p.content.includes(row.id) && p.content.includes('pas répondu'))).toBe(true);
    await cleanup(row.id);
  });

  test('appel terminé → plus de décision possible', async () => {
    auto = false;
    const row = await startInboundCall({ companyId: CO, userId: USER, mode: 'sim', simCaller: caller });
    await cleanup(row.id);
    const r = await answerInbound((await getCall(row.id))!, 'accept');
    expect(r.ok).toBe(false);
  });

  test('contexte Bland : HOLD tant que ça sonne, ANSWER après « Répondre », jeton inconnu refusé', async () => {
    auto = false;
    const line = await upsertInboundLine(CO, USER, { phoneNumber: '+33100000000' });
    const unknown = await inboundContext('x'.repeat(32), { call_id: 'abc' });
    expect(unknown.status).toBe(404);
    const callId = `test-bland-${Date.now()}`;
    const first = await inboundContext(line.hookToken, { call_id: callId, from: '+33100000001' });
    expect(first.body.line_state).toMatch(/^HOLD/);
    const row = (await listRingingInbound(USER)).find((c) => c.providerCallId === callId)!;
    expect(row).toBeTruthy();
    expect(row.mode).toBe('bland');
    await answerInbound(row, 'accept');
    const next = await inboundContext(line.hookToken, { call_id: callId });
    expect(next.body.line_state).toMatch(/^ANSWER/);
    // Variables Bland non substituées → aucune création d'appel.
    const raw = await inboundContext(line.hookToken, { call_id: '{{call_id}}' });
    expect(raw.body.line_state).toMatch(/^ANSWER/);
    await client.execute({ sql: 'UPDATE live_calls SET status = ? WHERE id = ?', args: ['ended', row.id] });
  });
});
