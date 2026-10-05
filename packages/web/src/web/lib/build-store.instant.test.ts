/**
 * [2026-09-25] Validation du plan de pages → construction INSTANTANÉE.
 *
 * Bug corrigé : après le clic « valider le plan », l'écran ne montrait rien
 * pendant ~1,5 s (le chat attendait l'enregistrement des pages PUIS la marque
 * avant d'appeler `runBuild`, qui est le seul endroit posant `isBuilding`).
 *
 * Contrat testé ici, celui qui garantit l'absence de délai :
 *   1. `runBuild` pose l'état « en construction » de façon SYNCHRONE, même
 *      quand une promesse `waitFor` est fournie.
 *   2. L'appel serveur (build-website) n'est PAS envoyé avant que `waitFor`
 *      soit tenue — les pages validées doivent être en base avant.
 *   3. Une `waitFor` rejetée ne bloque pas le départ du build.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';

// ── Faux `api` : aucun réseau, on note juste les appels ────────────────────
const calls: string[] = [];
let jobsResponse: any = { jobs: [], executions: [], latestActivity: [] };

mock.module('./api', () => ({
  api: {
    companies: {
      initialize: async (id: string) => { calls.push(`initialize:${id}`); return {}; },
      buildWebsite: async (id: string) => { calls.push(`buildWebsite:${id}`); return { status: 'queued' }; },
      jobs: async (id: string) => { calls.push(`jobs:${id}`); return jobsResponse; },
      marketing: async () => ({ ready: false }),
      cancelBuild: async (id: string) => { calls.push(`cancelBuild:${id}`); return {}; },
    },
  },
}));

const { useBuildStore } = await import('./build-store');

const company = { id: 'c-instant', name: 'Instant Co' };
const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('runBuild — départ instantané après la validation du plan', () => {
  beforeEach(() => {
    calls.length = 0;
    jobsResponse = { jobs: [], executions: [], latestActivity: [] };
    useBuildStore.getState().reset();
  });

  it("pose l'état « en construction » dans la même image que l'appel, sans attendre", () => {
    let release: (() => void) | null = null;
    const waitFor = new Promise<void>(r => { release = r; });

    useBuildStore.getState().runBuild(company, undefined, waitFor);

    // Aucun await ici : c'est exactement ce que voit React au moment du clic.
    const st = useBuildStore.getState();
    expect(st.isBuilding).toBe(true);
    expect(st.companyId).toBe('c-instant');
    expect(st.companyName).toBe('Instant Co');
    expect(st.liveStatus).toBe('Starting up...');

    release?.();
    useBuildStore.getState().cancelBuild();
  });

  it("n'envoie l'appel serveur qu'une fois `waitFor` tenue (pages en base)", async () => {
    let release: (() => void) | null = null;
    const waitFor = new Promise<void>(r => { release = r; });

    useBuildStore.getState().runBuild(company, undefined, waitFor);
    await tick();
    // L'écran montre déjà la construction, mais rien n'est parti au serveur.
    expect(useBuildStore.getState().isBuilding).toBe(true);
    expect(calls).toEqual([]);

    release?.();
    await tick();
    await tick();
    expect(calls).toContain('buildWebsite:c-instant');
    expect(calls).toContain('initialize:c-instant');

    useBuildStore.getState().cancelBuild();
  });

  it('part immédiatement quand aucune attente n’est fournie', async () => {
    useBuildStore.getState().runBuild(company);
    expect(useBuildStore.getState().isBuilding).toBe(true);
    await tick();
    expect(calls).toContain('buildWebsite:c-instant');
    useBuildStore.getState().cancelBuild();
  });

  it('démarre quand même si l’attente échoue (enregistrement en erreur)', async () => {
    useBuildStore.getState().runBuild(company, undefined, Promise.reject(new Error('save failed')));
    expect(useBuildStore.getState().isBuilding).toBe(true);
    await tick();
    await tick();
    expect(calls).toContain('buildWebsite:c-instant');
    useBuildStore.getState().cancelBuild();
  });

  it('ne lance rien si le build a été annulé pendant l’attente', async () => {
    let release: (() => void) | null = null;
    const waitFor = new Promise<void>(r => { release = r; });

    useBuildStore.getState().runBuild(company, undefined, waitFor);
    useBuildStore.getState().cancelBuild();
    release?.();
    await tick();
    await tick();
    // Seule l'annulation a parlé au serveur : aucun build n'est parti.
    expect(calls).toEqual(['cancelBuild:c-instant']);
  });
});
