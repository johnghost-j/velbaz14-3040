import { describe, expect, it } from 'bun:test';
import { pickBuildEndMessages } from './build-end-messages';

const C = 'c-123';
const since = new Date('2026-10-04T10:00:00Z');
const at = (iso: string) => new Date(iso).toISOString();

describe('pickBuildEndMessages', () => {
  const history = [
    { id: 'u1', role: 'user', content: 'fais-moi une boutique', createdAt: at('2026-10-04T09:59:00Z') },
    { id: 'build-end-old', role: 'assistant', content: 'ancienne stratégie [FILE:marketing/a.md|a]', createdAt: at('2026-10-01T10:00:00Z') },
    { id: 'a-chat', role: 'assistant', content: 'réponse de chat pendant le build', createdAt: at('2026-10-04T10:01:00Z') },
    { id: `build-recap-${C}`, role: 'assistant', content: '✅ **X est prêt**', model: 'velbaz', createdAt: at('2026-10-04T10:05:00Z') },
    { id: 'build-end-mk', role: 'assistant', content: 'Stratégie [FILE:marketing/plan.md|plan]', model: 'openai/gpt-5.4-mini', createdAt: at('2026-10-04T10:04:00Z') },
    { id: `demo-notice-${C}`, role: 'assistant', content: 'contenu d’exemple', createdAt: at('2026-10-04T10:03:00Z') },
    { id: 'build-end-vis', role: 'assistant', content: 'Pack [FILE:visibilite/cp.md|cp]', createdAt: at('2026-10-04T10:05:00Z') },
    { id: 'demo-notice-other', role: 'assistant', content: 'autre projet', createdAt: at('2026-10-04T10:03:00Z') },
  ];

  it('reprend les messages de fin de CE build, récap en dernier', () => {
    const r = pickBuildEndMessages(history, C, since, new Set());
    expect(r.map((m) => m.id)).toEqual([`demo-notice-${C}`, 'build-end-mk', 'build-end-vis', `build-recap-${C}`]);
    // Même seconde que le pack visibilité : le récap passe quand même après.
    expect(r[3].time.getTime()).toBeGreaterThan(r[2].time.getTime());
  });

  it('ignore les messages déjà affichés, les anciens builds et le chat ordinaire', () => {
    const r = pickBuildEndMessages(history, C, since, new Set(['build-end-mk']));
    const ids = r.map((m) => m.id);
    expect(ids).not.toContain('build-end-mk');
    expect(ids).not.toContain('build-end-old');
    expect(ids).not.toContain('a-chat');
    expect(ids).not.toContain('u1');
  });

  it('sans date de départ connue, ne reprend que le récap', () => {
    expect(pickBuildEndMessages(history, C, null, new Set()).map((m) => m.id)).toEqual([`build-recap-${C}`]);
  });

  it('applique l’étiquette de modèle et lit created_at en secondes', () => {
    const r = pickBuildEndMessages(
      [{ id: 'build-end-x', role: 'assistant', content: 'x', model: 'openai/gpt-5.4-mini', created_at: Math.floor(since.getTime() / 1000) + 5 }],
      C, since, new Set(), (m) => (m === 'openai/gpt-5.4-mini' ? 'openai/gpt-6-luna' : m || undefined),
    );
    expect(r).toHaveLength(1);
    expect(r[0].model).toBe('openai/gpt-6-luna');
    expect(r[0].time.getTime()).toBe(since.getTime() + 5000);
  });
});
