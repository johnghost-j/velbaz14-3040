// Regroupe les exécutions d'une tâche par clé (ex. : le rebranchement du
// catalogue d'une company). Un appel pendant qu'une exécution tourne ne lance
// pas une 2e exécution concurrente : il demande UNE relance à la fin de la
// courante, pour que les changements arrivés entre-temps soient pris en compte.
export function coalescePerKey<A extends unknown[]>(
  task: (key: string, ...args: A) => Promise<void>,
): (key: string, ...args: A) => Promise<void> {
  const states = new Map<string, { again: boolean; args: A; running: Promise<void> }>();
  return (key, ...args) => {
    const current = states.get(key);
    if (current) {
      current.again = true;
      current.args = args;
      return current.running;
    }
    const state = { again: false, args, running: Promise.resolve() };
    state.running = (async () => {
      try {
        do {
          state.again = false;
          await task(key, ...state.args);
        } while (state.again);
      } finally {
        states.delete(key);
      }
    })();
    states.set(key, state);
    return state.running;
  };
}
