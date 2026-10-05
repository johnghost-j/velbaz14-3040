import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { VOICES, _resetVoiceState, blandVoiceFor, callVoice, synthesize, ttsAllowed, ttsText, TTS_PER_HOUR } from './voice';

const saved = { key: process.env.BLAND_API_KEY, fr: process.env.BLAND_VOICE_FR };
beforeEach(() => { _resetVoiceState(); process.env.BLAND_API_KEY = 'test-key'; delete process.env.BLAND_VOICE_FR; });
afterEach(() => {
  if (saved.key === undefined) delete process.env.BLAND_API_KEY; else process.env.BLAND_API_KEY = saved.key;
  if (saved.fr === undefined) delete process.env.BLAND_VOICE_FR; else process.env.BLAND_VOICE_FR = saved.fr;
});

function wavFetch(calls: any[], status = 200) {
  return (async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status });
    return new Response(new Uint8Array(4000), { status: 200, headers: { 'content-type': 'audio/wav' } });
  }) as unknown as typeof fetch;
}

describe('voix Bland', () => {
  test('voix par rôle et par langue (jamais « maya »)', () => {
    expect(blandVoiceFor('ai', 'fr')).toBe(VOICES.fr.ai);
    expect(blandVoiceFor('contact', 'fr')).toBe(VOICES.fr.contact);
    expect(blandVoiceFor('ai', 'en')).toBe(VOICES.en.ai);
    expect(blandVoiceFor('contact', 'en-US')).toBe(VOICES.en.contact);
    expect(blandVoiceFor('ai', null)).toBe(VOICES.fr.ai);
    expect(VOICES.fr.ai).not.toBe(VOICES.fr.contact);
    expect(callVoice('fr')).toBe(VOICES.fr.ai);
    expect(callVoice('fr')).not.toBe('maya');
  });

  test('surcharge de la voix de l’IA par secret', () => {
    process.env.BLAND_VOICE_FR = 'abcd';
    expect(blandVoiceFor('ai', 'fr')).toBe('abcd');
    expect(blandVoiceFor('contact', 'fr')).toBe(VOICES.fr.contact);
  });

  test('ttsText nettoie et borne', () => {
    expect(ttsText('  **Bonjour**\n  Paul  ')).toBe('Bonjour Paul');
    expect(ttsText('a'.repeat(5000)).length).toBe(1200);
  });

  test('synthesize appelle /v2/tts avec la voix et met en cache', async () => {
    const calls: any[] = [];
    const f = wavFetch(calls);
    const a = await synthesize('Allô ?', VOICES.fr.contact, f);
    const b = await synthesize('Allô ?', VOICES.fr.contact, f);
    expect(a.ok && b.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.bland.ai/v2/tts');
    expect(calls[0].init.headers.authorization).toBe('test-key');
    expect(calls[0].body.voice).toBe(VOICES.fr.contact);
    expect(calls[0].body.text).toBe('Allô ?');
    expect(calls[0].body.audio.container).toBe('wav');
  });

  test('erreurs : pas de clé, voix invalide, Bland en échec', async () => {
    const calls: any[] = [];
    delete process.env.BLAND_API_KEY;
    const noKey = await synthesize('Bonjour', VOICES.fr.ai, wavFetch(calls));
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.status).toBe(503);
    process.env.BLAND_API_KEY = 'test-key';
    const bad = await synthesize('Bonjour', 'maya', wavFetch(calls));
    expect(bad.ok).toBe(false);
    const fail = await synthesize('Bonjour', VOICES.fr.ai, wavFetch(calls, 500));
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.status).toBe(502);
    expect(calls.length).toBe(1);
  });

  test('quota horaire par utilisateur', () => {
    const t = 1_000_000;
    for (let i = 0; i < TTS_PER_HOUR; i++) expect(ttsAllowed('u1', t)).toBe(true);
    expect(ttsAllowed('u1', t)).toBe(false);
    expect(ttsAllowed('u2', t)).toBe(true);
    expect(ttsAllowed('u1', t + 61 * 60_000)).toBe(true);
  });
});
