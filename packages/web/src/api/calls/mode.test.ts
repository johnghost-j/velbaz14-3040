import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { callModeFor, isExampleNumber, smsModeFor } from './bland';

const saved = { key: process.env.BLAND_API_KEY, from: process.env.BLAND_FROM, sim: process.env.CALLS_FORCE_SIM };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
beforeEach(() => { delete process.env.CALLS_FORCE_SIM; process.env.BLAND_API_KEY = 'k'; delete process.env.BLAND_FROM; });
afterEach(() => { restore('BLAND_API_KEY', saved.key); restore('BLAND_FROM', saved.from); restore('CALLS_FORCE_SIM', saved.sim); });

describe('vrai ou simulé', () => {
  test('clé Bland présente → vrai appel, même sans numéro d’envoi', () => {
    expect(callModeFor('+32470112233')).toEqual({ real: true });
  });
  test('numéros d’exemple : toujours simulés', () => {
    expect(isExampleNumber('+33 6 11 22 33 44')).toBe(true);
    const m = callModeFor('+33611223344');
    expect(m.real).toBe(false);
    expect(!m.real && m.sim).toBe(true);
    expect(smsModeFor('+33612345678').real).toBe(false);
  });
  test('sans clé : ni vrai ni faux appel, une raison claire', () => {
    delete process.env.BLAND_API_KEY;
    const m = callModeFor('+32470112233');
    expect(m.real).toBe(false);
    if (!m.real) { expect(m.sim).toBe(false); expect(m.reason).toContain('BLAND_API_KEY'); }
  });
  test('SMS : sans numéro Bland, pas de simulation (pas de fausse réponse)', () => {
    const m = smsModeFor('+32470112233');
    expect(m.real).toBe(false);
    if (!m.real) { expect(m.sim).toBe(false); expect(m.reason).toContain('BLAND_FROM'); }
    process.env.BLAND_FROM = '+15550001111';
    expect(smsModeFor('+32470112233')).toEqual({ real: true });
  });
  test('CALLS_FORCE_SIM garde tout en simulation', () => {
    process.env.CALLS_FORCE_SIM = '1';
    process.env.BLAND_FROM = '+15550001111';
    expect(callModeFor('+32470112233').real).toBe(false);
    expect(smsModeFor('+32470112233').real).toBe(false);
  });
});
