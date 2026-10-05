import { describe, expect, test } from 'bun:test';
import { taskInstruction, taskResultMessage } from './autopilot';

describe('autopilot → chat', () => {
  test('le prompt précis = titre + description (sans doublon)', () => {
    expect(taskInstruction({ title: 'Ajoute une FAQ', description: 'Sur la page d\'accueil, 5 questions.' }))
      .toBe("Ajoute une FAQ\n\nSur la page d'accueil, 5 questions.");
    expect(taskInstruction({ title: 'Ajoute une FAQ', description: 'ajoute une faq' })).toBe('Ajoute une FAQ');
    expect(taskInstruction({ title: 'Ajoute une FAQ', description: null })).toBe('Ajoute une FAQ');
  });

  test('résultat lisible, jamais de JSON brut', () => {
    const a = taskResultMessage({ type: 'analyze_metrics', title: 'x', status: 'completed' },
      { summary: 'Peu de visites.', recommendations: ['Poster sur Instagram', 'SEO'] });
    expect(a).toContain('Peu de visites.');
    expect(a).toContain('- Poster sur Instagram');
    expect(a).not.toContain('{');
    const f = taskResultMessage({ type: 'create_post', title: 'Post', status: 'failed', error: '402 credits' }, null);
    expect(f).toContain('402 credits');
    const sk = taskResultMessage({ type: 'create_post', title: 'Post', status: 'completed' }, { skipped: true, reason: 'twitter not connected' });
    expect(sk).toContain('twitter not connected');
    const em = taskResultMessage({ type: 'send_email', title: 'Mail', status: 'completed' }, { drafted: true, sent: false, to: 'a@b.c', subject: 'Salut' });
    expect(em).toContain('Brouillon');
    expect(em).toContain('a@b.c');
  });
});
