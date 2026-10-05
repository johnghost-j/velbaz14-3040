import { describe, expect, test } from 'bun:test';
import { streamText } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { streamWithFirstPartDeadline, type StreamPartLike } from './stream-deadline';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });

/** Flux qui reste muet (comme la requête bloquée du 2026-10-04) jusqu'à l'annulation. */
async function* muteStream(signal: AbortSignal): AsyncIterable<StreamPartLike> {
  yield { type: 'start' }; // émis localement par le SDK, ne prouve rien
  await sleep(60_000, signal);
}

async function* okStream(signal: AbortSignal, words: string[], gapMs = 5): AsyncIterable<StreamPartLike> {
  yield { type: 'start' };
  yield { type: 'start-step' };
  for (const w of words) {
    await sleep(gapMs, signal);
    yield { type: 'text-delta', text: w };
  }
  yield { type: 'finish' };
}

describe('streamWithFirstPartDeadline', () => {
  test('un flux muet est coupé puis relancé, et la relance répond', async () => {
    let calls = 0;
    const out: string[] = [];
    const logs: string[] = [];
    const t0 = Date.now();
    const r = await streamWithFirstPartDeadline({
      label: 'test',
      firstPartMs: 50,
      totalMs: 10_000,
      start: (signal) => (++calls === 1 ? muteStream(signal) : okStream(signal, ['Bon', 'jour'])),
      onText: (c) => out.push(c),
      log: (m) => logs.push(m),
    });
    expect(calls).toBe(2);
    expect(r).toEqual({ text: 'Bonjour', stalled: false, error: expect.anything() });
    expect(out.join('')).toBe('Bonjour');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(logs.some((l) => l.includes('aucune réponse du fournisseur'))).toBe(true);
  });

  test('toutes les tentatives muettes → stalled, sans attendre le plafond global', async () => {
    let calls = 0;
    const t0 = Date.now();
    const r = await streamWithFirstPartDeadline({
      label: 'test',
      firstPartMs: 40,
      totalMs: 60_000,
      start: (signal) => { calls++; return muteStream(signal); },
      onText: () => {},
      log: () => {},
    });
    expect(calls).toBe(2);
    expect(r.text).toBe('');
    expect(r.stalled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("un modèle lent mais VIVANT n'est jamais coupé par le délai du premier morceau", async () => {
    let calls = 0;
    async function* slowButAlive(signal: AbortSignal): AsyncIterable<StreamPartLike> {
      yield { type: 'start' };
      yield { type: 'reasoning-start' }; // le fournisseur a répondu : il réfléchit
      await sleep(150, signal);          // bien plus long que firstPartMs
      yield { type: 'text-delta', text: 'ok' };
    }
    const r = await streamWithFirstPartDeadline({
      label: 'test',
      firstPartMs: 30,
      totalMs: 10_000,
      start: (signal) => { calls++; return slowButAlive(signal); },
      onText: () => {},
      log: () => {},
    });
    expect(calls).toBe(1);
    expect(r.text).toBe('ok');
  });

  test("un flux terminé vide (non muet) n'est pas relancé : l'appelant passe aux secours", async () => {
    let calls = 0;
    async function* empty(): AsyncIterable<StreamPartLike> {
      yield { type: 'start' };
      yield { type: 'error', error: new Error('boom') };
    }
    const r = await streamWithFirstPartDeadline({
      label: 'test',
      firstPartMs: 1_000,
      totalMs: 10_000,
      start: () => { calls++; return empty(); },
      onText: () => {},
      log: () => {},
    });
    expect(calls).toBe(1);
    expect(r).toEqual({ text: '', stalled: false, error: 'boom' });
  });

  test('le plafond global coupe un flux qui a démarré mais ne finit jamais', async () => {
    async function* hangsAfterStart(signal: AbortSignal): AsyncIterable<StreamPartLike> {
      yield { type: 'start-step' };
      yield { type: 'text-delta', text: 'début' };
      await sleep(60_000, signal);
    }
    const t0 = Date.now();
    const r = await streamWithFirstPartDeadline({
      label: 'test',
      firstPartMs: 20,
      totalMs: 100,
      start: (signal) => hangsAfterStart(signal),
      onText: () => {},
      log: () => {},
    });
    expect(r.text).toBe('début');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

// Avec le VRAI streamText du SDK : la requête HTTP qui ne rend jamais ses
// en-têtes (doStream ne se résout pas) est bien coupée par le signal, et la
// relance sur un modèle qui répond produit le texte.
describe('streamWithFirstPartDeadline + streamText (SDK réel)', () => {
  test('doStream bloqué → coupé au délai, relance OK', async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        calls++;
        if (calls === 1) {
          await sleep(60_000, abortSignal); // fournisseur muet
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: 'Salut' },
              { type: 'text-end', id: '1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ] as any,
          }),
        };
      },
    });
    const t0 = Date.now();
    const r = await streamWithFirstPartDeadline({
      label: 'mock',
      firstPartMs: 80,
      totalMs: 10_000,
      start: (signal) => streamText({ model, prompt: 'x', maxRetries: 0, abortSignal: signal }).fullStream,
      onText: () => {},
      log: () => {},
    });
    expect(calls).toBe(2);
    expect(r.text).toBe('Salut');
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});
