import { describe, expect, test } from 'bun:test';
import { ApprovalCancelledError, createApprovalGate, type ApprovalAnswer, type PendingApproval } from './approval-gate';

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeGate(enabled: boolean | (() => Promise<boolean>) = true) {
  const requested: PendingApproval[] = [];
  const resolved: Array<{ p: PendingApproval; a: ApprovalAnswer }> = [];
  let n = 0;
  const gate = createApprovalGate({
    isEnabled: typeof enabled === 'function' ? enabled : async () => enabled,
    onRequested: (p) => { requested.push(p); },
    onResolved: (p, a) => { resolved.push({ p, a }); },
    newId: () => `ap${++n}`,
  });
  return { gate, requested, resolved };
}

describe('approval-gate (mode approbation manuelle)', () => {
  test('mode désactivé : aucune attente, rien en file', async () => {
    const { gate, requested } = makeGate(false);
    const a = await gate.request({ companyId: 'c1', decision: 'Construire le site', agentRole: 'engineering', phase: 'build-web' });
    expect(a).toEqual({ approved: true });
    expect(gate.current('c1')).toBeNull();
    expect(requested.length).toBe(0);
  });

  test('mode actif : la tâche ATTEND réellement jusqu\'à Accept', async () => {
    const { gate, requested } = makeGate(true);
    let done = false;
    const p = gate.request({ companyId: 'c1', decision: 'Construire le site', agentRole: 'engineering', phase: 'build-web' }).then((a) => { done = true; return a; });
    await tick(); await tick();
    expect(done).toBe(false);
    expect(gate.current('c1')?.decision).toBe('Construire le site');
    expect(requested.length).toBe(1);
    expect(await gate.resolve('c1', 'ap1', { approved: true })).toBe(true);
    expect(await p).toEqual({ approved: true });
    expect(gate.current('c1')).toBeNull();
  });

  test('Decline : la raison est transmise à la tâche et au hook', async () => {
    const { gate, resolved } = makeGate(true);
    const p = gate.request({ companyId: 'c1', decision: 'Générer le logo', agentRole: 'design', phase: 'logo' });
    await tick();
    await gate.resolve('c1', 'ap1', { approved: false, reason: '  je veux un logo noir  ' });
    expect(await p).toEqual({ approved: false, reason: 'je veux un logo noir' });
    expect(resolved[0].a).toEqual({ approved: false, reason: 'je veux un logo noir' });
  });

  test('tâches parallèles : UNE seule demande visible à la fois, dans l\'ordre', async () => {
    const { gate } = makeGate(true);
    const a = gate.request({ companyId: 'c1', decision: 'A', agentRole: 'ceo', phase: 'a' });
    const b = gate.request({ companyId: 'c1', decision: 'B', agentRole: 'design', phase: 'b' });
    await tick(); await tick();
    expect(gate.current('c1')?.decision).toBe('A');
    expect(gate.queued('c1')).toBe(2);
    // La demande affichée ne change pas tant qu'on n'a pas répondu.
    await tick();
    expect(gate.current('c1')?.id).toBe('ap1');
    await gate.resolve('c1', 'ap1', { approved: true });
    expect(await a).toEqual({ approved: true });
    expect(gate.current('c1')?.decision).toBe('B');
    await gate.resolve('c1', 'ap2', { approved: true });
    expect(await b).toEqual({ approved: true });
  });

  test('id inconnu / déjà répondu : refusé, rien ne bouge', async () => {
    const { gate } = makeGate(true);
    const p = gate.request({ companyId: 'c1', decision: 'A', agentRole: 'ceo', phase: 'a' });
    await tick();
    expect(await gate.resolve('c1', 'nope', { approved: true })).toBe(false);
    expect(await gate.resolve('c2', 'ap1', { approved: true })).toBe(false);
    expect(gate.current('c1')?.id).toBe('ap1');
    await gate.resolve('c1', 'ap1', { approved: true });
    expect(await gate.resolve('c1', 'ap1', { approved: true })).toBe(false);
    await p;
  });

  test('Arrêter le projet libère l\'attente (ApprovalCancelledError)', async () => {
    const { gate } = makeGate(true);
    const p = gate.request({ companyId: 'c1', decision: 'A', agentRole: 'ceo', phase: 'a' });
    const other = gate.request({ companyId: 'c2', decision: 'X', agentRole: 'ceo', phase: 'x' });
    await tick();
    expect(gate.cancelCompany('c1')).toBe(1);
    await expect(p).rejects.toBeInstanceOf(ApprovalCancelledError);
    expect(gate.current('c1')).toBeNull();
    // Un autre projet n'est pas touché.
    expect(gate.current('c2')?.decision).toBe('X');
    await gate.resolve('c2', gate.current('c2')!.id, { approved: true });
    await other;
  });

  test('désactiver le mode accepte explicitement les demandes en attente', async () => {
    const { gate } = makeGate(true);
    const a = gate.request({ companyId: 'c1', decision: 'A', agentRole: 'ceo', phase: 'a' });
    const b = gate.request({ companyId: 'c1', decision: 'B', agentRole: 'ceo', phase: 'b' });
    await tick();
    expect(await gate.approveAllForCompanies(['c1'])).toBe(2);
    expect(await a).toEqual({ approved: true });
    expect(await b).toEqual({ approved: true });
  });

  test('réglage illisible : on demande la permission (jamais d\'action sans accord)', async () => {
    const { gate } = makeGate(async () => { throw new Error('socket hang up'); });
    let done = false;
    const p = gate.request({ companyId: 'c1', decision: 'A', agentRole: 'ceo', phase: 'a' }).then(() => { done = true; });
    await tick(); await tick();
    expect(done).toBe(false);
    expect(gate.current('c1')).not.toBeNull();
    await gate.resolve('c1', 'ap1', { approved: true });
    await p;
  });

  test('Arrêter prévient onCancelled pour chaque attente (la ligne « en attente » est mise à jour)', async () => {
    const cancelled: string[] = [];
    const gate = createApprovalGate({
      isEnabled: async () => true,
      onCancelled: (p) => { cancelled.push(p.phase); },
    });
    const a = gate.request({ companyId: 'c1', decision: 'A', agentRole: 'ceo', phase: 'a' });
    const b = gate.request({ companyId: 'c1', decision: 'B', agentRole: 'ceo', phase: 'b' });
    await tick();
    const settled = Promise.allSettled([a, b]);
    expect(gate.cancelCompany('c1')).toBe(2);
    const res = await settled;
    expect(res.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect((res[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalCancelledError);
    await tick();
    expect(cancelled).toEqual(['a', 'b']);
  });
});
