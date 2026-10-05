import { describe, expect, test, afterEach } from 'bun:test';
import { isPlatformEnabled, enabledPlatforms, getPlatform } from './platforms';
import { planSocialSend, socialPlatformQuestionObj, platformListLabel } from './send-intent';

const KEYS = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
const clear = () => { for (const k of KEYS) delete process.env[k]; };

describe('Reddit masqué sans clés API', () => {
  test('sans clés : Reddit et Instagram absents, X et Discord restent (mode démo)', () => {
    clear();
    expect(isPlatformEnabled('reddit')).toBe(false);
    expect(isPlatformEnabled('instagram')).toBe(false);
    expect(enabledPlatforms()).toEqual(['twitter', 'discord']);
    // Pas d'adaptateur démo pour les plateformes masquées.
    expect(() => getPlatform('reddit', { allowDemo: true })).toThrow();
    expect(() => getPlatform('instagram', { allowDemo: true })).toThrow();
  });

  test('Instagram réapparaît avec ses deux clés', () => {
    clear();
    process.env.INSTAGRAM_CLIENT_ID = '123';
    process.env.INSTAGRAM_CLIENT_SECRET = 'xyz';
    expect(enabledPlatforms()).toEqual(['twitter', 'discord', 'instagram']);
  });

  test('une seule clé ne suffit pas', () => {
    clear();
    process.env.REDDIT_CLIENT_ID = 'abc';
    delete process.env.REDDIT_CLIENT_SECRET;
    expect(isPlatformEnabled('reddit')).toBe(false);
  });

  test('avec les deux clés : Reddit réapparaît', () => {
    clear();
    process.env.REDDIT_CLIENT_ID = 'abc';
    process.env.REDDIT_CLIENT_SECRET = 'def';
    expect(isPlatformEnabled('reddit')).toBe(true);
    expect(enabledPlatforms()).toContain('reddit');
  });

  test('plateforme inconnue jamais activée', () => {
    expect(isPlatformEnabled('linkedin')).toBe(false);
  });
});

describe('envoi social : plateformes disponibles', () => {
  const available = ['twitter', 'discord', 'instagram'];

  test('« poste sur reddit » ne choisit jamais Reddit quand il est masqué', () => {
    const plan = planSocialSend('poste sur reddit : bonjour à tous', [], ['reddit', 'twitter', 'discord'], { available });
    expect(plan.platforms).not.toContain('reddit');
    expect(plan.connected).not.toContain('reddit');
  });

  test('sans `available`, comportement inchangé', () => {
    const plan = planSocialSend('poste sur reddit : bonjour', [], []);
    expect(plan.platforms).toEqual(['reddit']);
  });

  test('la question de plateforme ne propose pas Reddit', () => {
    const q = JSON.parse(socialPlatformQuestionObj([], true, available));
    expect(q.options.map((o: any) => o.id)).toEqual(['twitter', 'discord', 'instagram', 'all']);
  });

  test('liste lisible', () => {
    expect(platformListLabel(available, true)).toBe('X, Discord ou Instagram');
    expect(platformListLabel(['twitter', 'discord', 'reddit', 'instagram'], false)).toBe('X, Discord, Reddit or Instagram');
  });
});
