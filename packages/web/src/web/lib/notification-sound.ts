/**
 * Sons de notification.
 *
 * Deux fichiers distincts (et non plus un seul fichier joué à deux vitesses) :
 *  - `notification.mp3` : "build terminé".
 *  - `question.mp3` : "l'IA attend une réponse" — un vrai son différent,
 *    demandé explicitement par l'utilisateur ("un peu différent" pour les
 *    questions), pas juste une variation de hauteur du même clip.
 *
 * Trois pièges, corrigés ici :
 *
 *  1. **Autoplay policy** — un navigateur refuse tout son avant la première
 *     interaction de l'utilisateur sur la page. Si la notification arrive
 *     pendant ce laps de temps, `play()` est rejeté et rien ne sort. On garde
 *     donc le son "en attente" et on le rejoue au premier clic / touche.
 *  2. **Ne jamais marquer une notif comme sonnée si le son n'est pas sorti** —
 *     sinon elle est perdue pour toujours (c'était le bug : le son bloqué par
 *     le navigateur était quand même marqué comme joué).
 *  3. **AudioContext suspendu** — Chrome crée le contexte en état `suspended`
 *     jusqu'à une interaction ; on appelle `resume()` à chaque interaction.
 *
 * Lecture via Web Audio (buffer décodé, en mémoire) avec repli sur un simple
 * <audio> si Web Audio n'est pas disponible.
 */

const SEEN_KEY = 'velbaz-notif-sounded';
const MAX_SEEN = 200;
const VOLUME = 0.6;

type Ctx = AudioContext & { resume: () => Promise<void> };

type Sound = {
  src: string;
  buffer: AudioBuffer | null;
  loading: Promise<void> | null;
  el: HTMLAudioElement | null;
  pending: boolean;
};

const BUILD_DONE: Sound = { src: '/sounds/notification.mp3', buffer: null, loading: null, el: null, pending: false };
const QUESTION: Sound = { src: '/sounds/question.mp3', buffer: null, loading: null, el: null, pending: false };

let ctx: Ctx | null = null;
let armed = false;

function audioContext(): Ctx | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor() as Ctx;
    } catch {
      return null;
    }
  }
  return ctx;
}

/** Télécharge et décode le fichier d'un son donné, une seule fois. */
function preload(s: Sound): Promise<void> {
  if (s.buffer) return Promise.resolve();
  if (s.loading) return s.loading;
  const c = audioContext();
  if (!c) return Promise.resolve();
  s.loading = fetch(s.src)
    .then(r => r.arrayBuffer())
    .then(b => c.decodeAudioData(b))
    .then(decoded => {
      s.buffer = decoded;
    })
    .catch(() => {
      /* on retombera sur <audio> */
    });
  return s.loading;
}

function fallbackEl(s: Sound): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null;
  if (!s.el) {
    s.el = new Audio(s.src);
    s.el.preload = 'auto';
    s.el.volume = VOLUME;
  }
  return s.el;
}

/** Tente de jouer tout de suite. Renvoie true si le son est bien parti. */
function tryPlay(s: Sound): boolean {
  const c = audioContext();
  if (c && s.buffer) {
    if (c.state === 'suspended') {
      void c.resume().catch(() => {});
      // Contexte encore bloqué : on rejouera à la prochaine interaction.
      if (c.state === 'suspended') return false;
    }
    try {
      const src = c.createBufferSource();
      src.buffer = s.buffer;
      const gain = c.createGain();
      gain.gain.value = VOLUME;
      src.connect(gain).connect(c.destination);
      src.start(0);
      return true;
    } catch {
      /* on tente le repli */
    }
  }

  const a = fallbackEl(s);
  if (!a) return false;
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.then === 'function') {
      // On ne sait pas encore : optimiste, mais on repasse en attente si rejeté.
      p.catch(() => {
        s.pending = true;
      });
    }
    return true;
  } catch {
    return false;
  }
}

function play(s: Sound): void {
  if (!s.buffer) {
    // Pas encore décodé : on charge puis on joue dès que possible.
    void preload(s).then(() => {
      if (!tryPlay(s)) s.pending = true;
    });
    s.pending = true;
    return;
  }
  if (!tryPlay(s)) s.pending = true;
  else s.pending = false;
}

/**
 * Prépare les deux sons et branche le déverrouillage sur la première
 * interaction. À appeler une fois au montage.
 */
export function armNotificationSound(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  void preload(BUILD_DONE);
  void preload(QUESTION);

  const unlock = () => {
    const c = audioContext();
    if (c && c.state === 'suspended') void c.resume().catch(() => {});
    for (const s of [BUILD_DONE, QUESTION]) {
      void preload(s).then(() => {
        // Une notif est arrivée pendant que le navigateur nous bloquait : on la joue.
        if (s.pending) {
          s.pending = false;
          tryPlay(s);
        }
      });
    }
  };

  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  window.addEventListener('touchstart', unlock);
  document.addEventListener('visibilitychange', unlock);
}

/**
 * Joue le son "build terminé". Si le navigateur refuse (pas encore
 * d'interaction), le son est mis en attente et sortira à la première
 * interaction.
 */
export function playNotificationSound(): void {
  play(BUILD_DONE);
}

/**
 * Son "l'IA attend une réponse" — fichier audio distinct de
 * `playNotificationSound` (pas une simple variation de hauteur), pour qu'on
 * les reconnaisse sans regarder l'écran.
 */
export function playQuestionSound(): void {
  play(QUESTION);
}

function readSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Filtre les ids qui n'ont jamais fait sonner le son, et les marque comme
 * sonnés. Renvoie true s'il y en avait au moins un (→ il faut jouer le son).
 */
export function markSoundedAndCheck(ids: string[]): boolean {
  if (ids.length === 0) return false;
  const seen = readSeen();
  const set = new Set(seen);
  const fresh = ids.filter(id => !set.has(id));
  if (fresh.length === 0) return false;
  const next = [...seen, ...fresh].slice(-MAX_SEEN);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch { /* quota / mode privé : on jouera peut-être deux fois, pas grave */ }
  return true;
}

/** Bouton "tester le son" : joue sans passer par la mémoire des ids. */
export function testNotificationSound(): void {
  playNotificationSound();
}

/** Bouton "tester le son de question", si besoin côté réglages. */
export function testQuestionSound(): void {
  playQuestionSound();
}
