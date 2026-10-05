import { describe, it, expect, beforeEach } from 'bun:test';
import {
  markBuildLaunched,
  isBuildLaunched,
  clearBuildLaunched,
  LAUNCH_TTL_MS,
} from './build-launch-lock';

/* Verrou anti-double « 🚀 Je prépare ton projet… ».
   Les scénarios ci-dessous reproduisent EXACTEMENT les chemins qui
   doublaient la bulle dans le chat (cf. lib/build-launch-lock.ts). */

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}

const CO = 'd6b85bee-8eae-4fe1-99bd-fbee25298b8a';
const OTHER = '7ef4ebed-817f-47fa-a5f2-581ba107429d';

beforeEach(() => {
  const s = fakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: s });
});

describe('verrou de lancement de build', () => {
  it('est ouvert avant tout lancement', () => {
    expect(isBuildLaunched(CO)).toBe(false);
  });

  it('se ferme au lancement et ne concerne QUE ce projet', () => {
    markBuildLaunched(CO);
    expect(isBuildLaunched(CO)).toBe(true);
    expect(isBuildLaunched(OTHER)).toBe(false);
  });

  it('ignore un projet absent (premier message, aucune company encore créée)', () => {
    markBuildLaunched(null);
    expect(isBuildLaunched(null)).toBe(false);
    expect(isBuildLaunched(undefined)).toBe(false);
  });

  it('SURVIT à un remontage du composant (refs perdues, localStorage gardé)', () => {
    markBuildLaunched(CO);
    // Un remontage ne réinitialise que la mémoire du composant : le verrou,
    // lui, est relu depuis le stockage.
    expect(isBuildLaunched(CO)).toBe(true);
  });

  it("reste fermé quand l'objet `user` est recréé (solde de crédits) — le cas qui doublait la bulle", () => {
    markBuildLaunched(CO);
    // L'effet de restauration de la porte de marque se rejoue à chaque
    // nouvel objet `user` : il doit voir le verrou fermé et NE PAS
    // réinstaller de lanceur.
    for (let i = 0; i < 20; i++) expect(isBuildLaunched(CO)).toBe(true);
  });

  it("s'ouvre quand l'utilisateur envoie un nouveau message", () => {
    markBuildLaunched(CO);
    clearBuildLaunched(CO);
    expect(isBuildLaunched(CO)).toBe(false);
  });

  it('expire après 45 min pour ne jamais bloquer un vrai relancement', () => {
    const t0 = 1_789_643_099_000;
    markBuildLaunched(CO, t0);
    expect(isBuildLaunched(CO, t0 + LAUNCH_TTL_MS - 1000)).toBe(true);
    expect(isBuildLaunched(CO, t0 + LAUNCH_TTL_MS + 1000)).toBe(false);
  });

  it('ne lève jamais quand le stockage est indisponible (navigation privée)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError'); },
    });
    expect(() => markBuildLaunched(CO)).not.toThrow();
    expect(isBuildLaunched(CO)).toBe(false);
    expect(() => clearBuildLaunched(CO)).not.toThrow();
  });

  it('ignore une valeur corrompue au lieu de bloquer', () => {
    localStorage.setItem(`velbaz_build_launch_${CO}`, 'nope');
    expect(isBuildLaunched(CO)).toBe(false);
  });
});
