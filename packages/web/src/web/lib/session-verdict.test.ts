import { describe, expect, it } from 'bun:test';
import { classifySession } from './session-verdict';

describe('vérification de session', () => {
  it('confirme la session quand le serveur renvoie un utilisateur', () => {
    const v = classifySession(200, { user: { id: 'u1', email: 'a@b.c' } });
    expect(v.kind).toBe('ok');
    expect((v as any).user.id).toBe('u1');
  });

  it('ne déconnecte que sur un verdict explicite du serveur (401/403)', () => {
    expect(classifySession(401, { error: 'Unauthorized' }).kind).toBe('unauthorized');
    expect(classifySession(403, { error: 'Forbidden' }).kind).toBe('unauthorized');
  });

  it('ne déconnecte JAMAIS sur une panne passagère', () => {
    // Le bug d'origine : chacun de ces cas effaçait le token et affichait
    // « Sign In » alors que la session était intacte.
    expect(classifySession(0, { error: 'Failed to fetch' })).toEqual({ kind: 'transient', reason: 'network' });
    expect(classifySession(503, { error: 'indispo', transient: true })).toEqual({ kind: 'transient', reason: 'http_503' });
    expect(classifySession(500, { error: 'Internal Server Error' })).toEqual({ kind: 'transient', reason: 'http_500' });
    expect(classifySession(502, {})).toEqual({ kind: 'transient', reason: 'http_502' });
  });

  it('traite un 200 sans utilisateur comme douteux, pas comme une déconnexion', () => {
    expect(classifySession(200, {}).kind).toBe('transient');
    expect(classifySession(200, null).kind).toBe('transient');
  });
});
