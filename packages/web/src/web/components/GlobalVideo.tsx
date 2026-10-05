import { useEffect, useRef, type CSSProperties } from 'react';
import { isBackgroundedByLoginAs } from '../lib/token';

// Servie par Velbaz (public/videos) : aucune adresse de stockage tierce dans l'onglet réseau.
const VIDEO_MAIN = '/videos/synaps-bg.mp4';

// ── Image de secours ──
// Une image fixe extraite de la vidéo, posée SOUS les deux couches vidéo.
// Elle ne se voit jamais quand la vidéo joue (les couches sont opaques), mais
// elle couvre tous les cas où le navigateur ne dessine pas la vidéo :
//  • la vignette d'aperçu de l'onglet (survol de la barre des tâches) : Chrome
//    y redessine la page sans les couches vidéo composées par le GPU, et on
//    voyait alors le vide à la place de la vidéo ;
//  • un onglet en arrière-plan dont le décodeur a été libéré ;
//  • le tout début du chargement, un réseau coupé, un format refusé.
// Sans elle, cette zone se découvrait en clair au lieu de rester noire.
const VIDEO_STILL = '/images/video-bg-still.webp';

// Dark: white dunes → warm beige dunes
const DARK_FILTER = 'none';
const DARK_OPACITY = '1';

// ── Bouclage sans micro-gel ──
// Un `loop` natif rembobine l'élément vidéo : le navigateur refait un seek en
// début de fichier, redécode une image clé et parfois rappelle le réseau si le
// début du flux a été évincé du buffer. Résultat : une saccade d'une fraction
// de seconde, exactement au raccord de la boucle.
// On garde donc DEUX couches vidéo identiques : pendant que la première finit,
// la seconde redémarre depuis zéro et prend le relais en fondu par-dessus. Le
// seek coûteux se produit sur une couche cachée, jamais sur celle qu'on voit.
const HANDOFF_SECONDS = 0.4; // durée du relais, juste avant la fin

// Le thème clair inverse l'image (dunes blanches). On applique exactement le
// même filtre à l'image de secours qu'aux couches vidéo, sinon le fond de
// secours jurerait avec le reste de la page.
function applyTheme(v: HTMLElement) {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  v.style.filter = isLight ? 'invert(1)' : DARK_FILTER;
}

// Calque de secours : image fixe + aplat noir en dessous, pour qu'aucune
// couleur claire ne puisse apparaître même si l'image ne se charge pas.
let still: HTMLDivElement | null = null;

function getStill(): HTMLDivElement {
  if (still) return still;
  const d = document.createElement('div');
  Object.assign(d.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '0',
    backgroundColor: '#000',
    backgroundImage: `url(${VIDEO_STILL})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    pointerEvents: 'none',
    userSelect: 'none',
  } as CSSStyleDeclaration);
  d.setAttribute('aria-hidden', 'true');
  applyTheme(d);
  still = d;
  return d;
}

// `overlay` = couche de dessus. La couche de dessous reste dans le flux : c'est
// elle qui donne sa hauteur au conteneur (exactement comme la vidéo unique
// d'avant), la couche de dessus vient se superposer à ce même cadrage. Les deux
// gardent `position` non statique pour que leur `z-index` compte lors du relais.
function createVideo(src: string, overlay: boolean): HTMLVideoElement {
  const v = document.createElement('video');
  v.src = src;
  // Filet de sécurité : si le relais entre les deux couches échoue (iOS qui
  // refuse une seconde lecture simultanée, durée inconnue…), la vidéo boucle
  // toute seule comme avant au lieu de s'arrêter net.
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  // Seule la couche de dessous démarre d'elle-même : la doublure reste en
  // attente sur sa première image jusqu'au relais.
  v.autoplay = !overlay;
  v.preload = 'auto';
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.setAttribute('muted', '');
  // Purely decorative background — must never be selectable, draggable, or
  // clickable (no text-selection highlight, no "save video as" drag-out, no
  // right-click-and-drag selection box around it).
  v.setAttribute('disablePictureInPicture', '');
  v.setAttribute('controlsList', 'nodownload noplaybackrate nofullscreen');
  v.draggable = false;
  Object.assign(v.style, {
    position: overlay ? 'absolute' : 'relative',
    top: overlay ? '0' : undefined,
    left: overlay ? '0' : undefined,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    willChange: 'transform, opacity',
    transform: 'translateZ(0)',
    backfaceVisibility: 'hidden',
    transition: 'none',
    pointerEvents: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitUserDrag: 'none',
  } as CSSStyleDeclaration);
  return v;
}

// Les deux couches : [0] et [1] jouent la même source, à tour de rôle.
let layers: HTMLVideoElement[] | null = null;
let activeIdx = 0;
let handingOff = false;
let mainReady = false;
// Génération du relais en cours. Tout callback (fondu, validation) né d'un
// relais périmé compare sa génération à celle-ci et se désarme tout seul :
// c'est ce qui empêche un fondu gelé par un changement d'onglet de se réveiller
// plusieurs secondes plus tard et d'allumer les deux couches en même temps.
let handoffGen = 0;
let handoffTimer = 0;

function activeLayer(): HTMLVideoElement | null {
  return layers ? layers[activeIdx] : null;
}

// Couche mise en attente : invisible, en pause, rembobinée, sous l'autre.
function standby(v: HTMLVideoElement) {
  v.style.transition = 'none';
  v.style.opacity = '0';
  v.style.zIndex = '1';
  v.pause();
  try { v.currentTime = 0; } catch { /* noop */ }
}

// Annule le relais en cours : la génération change (les callbacks en vol
// deviennent inertes) et le minuteur de validation est désarmé.
function cancelHandoff() {
  handoffGen++;
  if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = 0; }
  handingOff = false;
}

// ── Remise en état ──
// Le seul état valide hors relais : la couche active visible et en lecture, la
// doublure invisible et en pause. On le réimpose au retour d'onglet (et
// périodiquement), donc quelle que soit la façon dont l'affichage a dérivé
// pendant que l'onglet était caché, la vidéo revient exactement comme avant :
// une seule couche à l'écran, jamais deux images superposées qui délavent
// l'image et son dégradé.
function normalizeLayers() {
  if (!layers || !mainReady || handingOff) return;
  const active = layers[activeIdx];
  const idle = layers[1 - activeIdx];

  if (idle.style.opacity !== '0' || idle.style.zIndex !== '1' || !idle.paused) standby(idle);

  if (active.style.transition !== 'none') active.style.transition = 'none';
  if (active.style.opacity !== DARK_OPACITY) active.style.opacity = DARK_OPACITY;
  if (active.style.zIndex !== '2') active.style.zIndex = '2';

  applyTheme(active);
  applyTheme(idle);
  if (still) applyTheme(still);
}

// ── Readiness subscription ──
// Lets React components reveal the page only once the background video is
// actually ready to play, so the site never appears "loaded" before the video.
const readySubscribers = new Set<() => void>();

export function isMainVideoReady(): boolean {
  return mainReady;
}

export function subscribeMainVideoReady(cb: () => void): () => void {
  if (mainReady) {
    // Fire on next tick so callers can rely on unsubscribe being returned first.
    Promise.resolve().then(cb);
    return () => {};
  }
  readySubscribers.add(cb);
  return () => readySubscribers.delete(cb);
}

function markReady(v: HTMLVideoElement) {
  if (mainReady) return;
  mainReady = true;
  applyTheme(v);
  if (still) applyTheme(still);
  readySubscribers.forEach((cb) => cb());
  readySubscribers.clear();
}

// ── Vidéo figée au retour d'onglet ──
// [2026-10-01] Bug signalé : onglet quitté longtemps → au retour, la vidéo
// d'accueil reste FIGÉE sur une image et ne rejoue plus. Le garde-fou d'avant
// ne relançait que si la vidéo était en PAUSE. Or après un long passage en
// arrière-plan, le navigateur libère le décodeur et le tampon de la vidéo, et
// la connexion réseau qui la servait est fermée : au retour, la vidéo est
// toujours « en lecture » (`paused === false`) mais attend des données qui
// n'arrivent jamais (`waiting` / `stalled` sans fin), ou est passée en erreur.
// `play()` n'y fait rien : il n'y a pas de pause à lever. D'où l'image figée.
// On surveille donc la PROGRESSION réelle de la couche affichée et on la
// répare par paliers : relance douce, puis rechargement complet de l'élément
// (servi depuis le cache HTTP, sans coût réseau) en reprenant au même instant.
const STALL_NUDGE_MS = 2000;   // sans progression → relance douce (seek sur place)
const STALL_RELOAD_MS = 4500;  // toujours rien → rechargement de l'élément
const LONG_HIDDEN_MS = 30_000; // au-delà, on réveille le décodeur dès le retour

let lastProgressT = -1;
let lastProgressAt = 0;
let lastFrames = -1;
let nudged = false;
let hiddenSince = 0;
let lastWatcherTick = 0;
const reloading = new WeakSet<HTMLVideoElement>();

function decodedFrames(v: HTMLVideoElement): number {
  try { return v.getVideoPlaybackQuality?.().totalVideoFrames ?? -1; } catch { return -1; }
}

function resetProgress(v: HTMLVideoElement | null) {
  lastProgressT = v ? v.currentTime : -1;
  lastFrames = v ? decodedFrames(v) : -1;
  lastProgressAt = Date.now();
  nudged = false;
}

// Relance douce : un seek sur place force le navigateur à relire et redécoder
// à partir de la position courante (réveille un décodeur suspendu).
function nudge(v: HTMLVideoElement) {
  try { v.currentTime = v.currentTime; } catch { /* noop */ }
  v.play().catch(() => {});
}

// Rechargement complet de l'élément vidéo, en gardant sa place à l'écran.
// `src` réassignée = nouvelle requête (la précédente est morte), la reprise se
// fait au même instant pour ne pas faire de saut visible.
function reloadLayer(v: HTMLVideoElement, play: boolean) {
  if (reloading.has(v)) return;
  reloading.add(v);
  const at = Number.isFinite(v.currentTime) ? v.currentTime : 0;
  const done = () => { reloading.delete(v); };
  const onMeta = () => {
    try { if (at > 0 && Number.isFinite(v.duration) && at < v.duration) v.currentTime = at; } catch { /* noop */ }
    if (play) v.play().catch(() => {}); else v.pause();
    done();
  };
  v.addEventListener('loadedmetadata', onMeta, { once: true });
  v.addEventListener('error', done, { once: true });
  // Garde-fou : on ne bloque jamais une nouvelle tentative plus de 8 s.
  window.setTimeout(done, 8000);
  v.src = VIDEO_MAIN;
  v.load();
  if (play) v.play().catch(() => {});
}

// Vérifie que la couche affichée avance vraiment ; la répare sinon.
function checkProgress() {
  if (!layers || !mainReady || document.hidden || handingOff) return;
  if (isBackgroundedByLoginAs()) return;
  const v = layers[activeIdx];
  const idle = layers[1 - activeIdx];
  // Doublure cassée (erreur) : rechargée en silence, elle doit être prête au
  // prochain relais sinon c'est elle qui se figerait à l'écran.
  if (idle.error && !reloading.has(idle)) reloadLayer(idle, false);
  if (reloading.has(v)) { resetProgress(v); return; }
  if (v.error) { reloadLayer(v, true); resetProgress(v); return; }
  if (v.paused || v.ended) { tryResume(); resetProgress(v); return; }
  const frames = decodedFrames(v);
  // Progression : le temps avance (ou a rebouclé) ET des images sont décodées
  // (quand le navigateur sait le dire). Un temps qui avance sans aucune image
  // décodée = décodeur mort, l'écran reste figé quand même.
  const timeMoved = Math.abs(v.currentTime - lastProgressT) > 0.05;
  const framesMoved = frames < 0 || lastFrames < 0 || frames !== lastFrames;
  if (timeMoved && framesMoved) { resetProgress(v); return; }
  const stuckFor = Date.now() - lastProgressAt;
  if (stuckFor >= STALL_RELOAD_MS) {
    reloadLayer(v, true);
    resetProgress(v);
  } else if (stuckFor >= STALL_NUDGE_MS && !nudged) {
    nudged = true;
    nudge(v);
  }
}

// ── Keep-alive ──
// iOS/Safari pauses background videos when the tab is backgrounded, when the
// device enters Low Power Mode, after a DOM move, or when the element scrolls
// off-screen — and never resumes on its own. This watchdog resumes playback
// whenever the video is unexpectedly paused/stalled so it never stays frozen.
let keepAliveStarted = false;

function tryResume() {
  if (document.hidden) return;
  // Pendant un relais, la couche sortante est volontairement arrêtée : on ne
  // réveille que celle qui est réellement à l'écran.
  const v = activeLayer();
  if (!v) return;
  if (v.paused || v.ended) {
    if (v.ended) { try { v.currentTime = 0; } catch { /* noop */ } }
    v.play().catch(() => {});
  }
}

function startKeepAlive(vs: HTMLVideoElement[]) {
  if (keepAliveStarted) return;
  keepAliveStarted = true;

  // Fenêtre "login-as" ouverte (ou frame d'emprunt) : on ne relance rien, l'app
  // reste en veille comme si elle n'était pas utilisée.
  const resume = () => { if (isBackgroundedByLoginAs()) return; tryResume(); };

  // The video itself signalling it stopped or stalled.
  for (const v of vs) {
    v.addEventListener('pause', resume);
    v.addEventListener('stalled', resume);
    v.addEventListener('waiting', resume);
    v.addEventListener('suspend', resume);
    v.addEventListener('ended', resume);
    // Erreur réseau / décodage (fréquente après un long arrière-plan) : sans
    // rechargement, l'élément ne rejouera plus jamais.
    v.addEventListener('error', () => {
      if (!mainReady || document.hidden || isBackgroundedByLoginAs()) return;
      reloadLayer(v, v === activeLayer());
    });
  }

  // ── Changement d'onglet ──
  // Un relais dure 0,4 s et repose sur `requestAnimationFrame`, que le
  // navigateur GÈLE dès que l'onglet passe en arrière-plan, alors que le
  // minuteur de validation continue, lui, de tourner. Un relais surpris par le
  // masquage de l'onglet restait donc à moitié fait, puis se terminait au
  // retour : les deux couches se retrouvaient allumées en même temps sur deux
  // images différentes, ce qui délavait la vidéo et son dégradé (effet
  // « blanchi », plus le fond noir d'avant). On annule donc franchement le
  // relais en partant, et on réimpose l'état propre en revenant.
  const onHide = () => {
    if (!hiddenSince) hiddenSince = Date.now();
    cancelHandoff();
    normalizeLayers();
  };
  const onShow = () => {
    const hiddenFor = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = 0;
    normalizeLayers();
    resume();
    if (!layers || document.hidden) return;
    // Long passage en arrière-plan : décodeur et tampon ont pu être libérés.
    // On réveille tout de suite la couche affichée (seek sur place) et on
    // recharge une couche en erreur, sans attendre que le gel se voie.
    if (hiddenFor >= LONG_HIDDEN_MS && !isBackgroundedByLoginAs()) {
      const v = layers[activeIdx];
      if (v.error) reloadLayer(v, true); else nudge(v);
      const idle = layers[1 - activeIdx];
      if (idle.error) reloadLayer(idle, false);
    }
    // La surveillance repart d'une base neuve : le temps passé caché ne compte
    // pas comme un gel.
    resetProgress(layers[activeIdx]);
    kickWatcher();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onHide();
    else onShow();
  });
  // Pas de `blur` ici : une fenêtre simplement défocalisée reste affichée, et
  // couper un relais en cours à ce moment-là provoquerait un saut d'image bien
  // visible. Seul un onglet réellement caché déclenche l'annulation.
  window.addEventListener('focus', onShow);
  window.addEventListener('pageshow', onShow);
  window.addEventListener('pagehide', onHide);
  // Chrome « gèle » carrément les onglets laissés de côté longtemps.
  document.addEventListener('freeze', onHide);
  document.addEventListener('resume', onShow);

  // Any user interaction is a valid gesture to re-kick playback on iOS.
  window.addEventListener('touchstart', resume, { passive: true });
  window.addEventListener('scroll', resume, { passive: true });

  // Periodic safety net for cases with no event at all (Low Power Mode).
  // La remise en état est idempotente : hors relais, elle ne touche à rien si
  // l'affichage est déjà correct, et le rattrape sinon (aucun événement reçu).
  window.setInterval(() => {
    if (isBackgroundedByLoginAs()) return;
    normalizeLayers();
    tryResume();
    checkProgress();
    // Surveillance du raccord morte (son callback d'image n'est jamais revenu,
    // ex. couche figée) → on la relance.
    if (!document.hidden && Date.now() - lastWatcherTick > 2500) kickWatcher();
  }, 1000);
}

// ── Surveillance du raccord ──
// On lit `currentTime` à chaque image affichée (`requestVideoFrameCallback`
// quand il existe, sinon `requestAnimationFrame`) : `timeupdate` ne se déclenche
// que 4 fois par seconde, bien trop grossier pour armer un relais de 0,4 s.
// Jeton de la boucle de surveillance : relancer la boucle (kickWatcher) rend
// l'ancienne inerte, il n'y en a donc jamais deux en parallèle.
let watcherToken = 0;

function kickWatcher() {
  if (!layers) return;
  startHandoffWatcher(layers);
}

function startHandoffWatcher(vs: HTMLVideoElement[]) {
  const token = ++watcherToken;
  lastWatcherTick = Date.now();
  const rvfc = (v: HTMLVideoElement) =>
    (v as any).requestVideoFrameCallback?.bind(v) as ((cb: () => void) => number) | undefined;

  const tick = () => {
    if (token !== watcherToken) return;
    lastWatcherTick = Date.now();
    if (!document.hidden) checkHandoff();
    schedule();
  };

  const schedule = () => {
    const v = activeLayer() ?? vs[0];
    // Une couche en pause ne produit plus d'image : son `requestVideoFrameCallback`
    // ne serait jamais rappelé et la surveillance mourrait pour de bon. Dans ce
    // cas on retombe sur `requestAnimationFrame`, qui repart au retour d'onglet.
    // (Une couche figée SANS être en pause est rattrapée par kickWatcher.)
    const req = v.paused ? undefined : rvfc(v);
    if (req) req(tick);
    else requestAnimationFrame(tick);
  };

  schedule();
}

function checkHandoff() {
  if (!layers || handingOff) return;
  // Onglet caché : `requestAnimationFrame` est gelé, donc un relais lancé ici ne
  // pourrait pas se terminer. On laisse le `loop` natif boucler tout seul.
  if (document.hidden) return;
  const current = layers[activeIdx];
  const next = layers[1 - activeIdx];
  const duration = current.duration;

  // Durée inconnue (flux non encore analysé) → on laisse le `loop` natif faire.
  if (!Number.isFinite(duration) || duration <= HANDOFF_SECONDS * 2) return;
  if (current.paused) return;
  if (current.currentTime < duration - HANDOFF_SECONDS) return;

  handingOff = true;
  const gen = ++handoffGen;
  const fadeMs = Math.max(120, (duration - current.currentTime) * 1000);

  // La couche entrante repart du début et passe AU-DESSUS de la sortante.
  // La sortante reste à pleine opacité pendant tout le fondu : à aucun moment
  // le fond de page ne peut apparaître entre les deux.
  try { next.currentTime = 0; } catch { /* noop */ }
  next.style.transition = 'none';
  next.style.opacity = '0';
  next.style.zIndex = '2';
  current.style.zIndex = '1';
  applyTheme(next);

  const started = next.play();

  const runFade = () => {
    // Deux images de la couche entrante suffisent à garantir qu'elle décode
    // vraiment avant qu'on la révèle.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Ces deux `requestAnimationFrame` sont gelés tant que l'onglet est
      // caché : sans ce garde ils se réveillaient au retour, des secondes plus
      // tard, et rallumaient la couche entrante alors que le relais avait déjà
      // été abandonné → deux images superposées, vidéo et dégradé délavés.
      if (gen !== handoffGen || document.hidden) return;
      next.style.transition = `opacity ${Math.round(fadeMs)}ms linear`;
      next.style.opacity = DARK_OPACITY;
    }));
  };

  const abort = () => {
    // La seconde lecture a été refusée : on annule proprement et le `loop`
    // natif reprend la main (micro-saccade, mais jamais d'image figée).
    if (gen !== handoffGen) return;
    next.style.transition = 'none';
    next.style.opacity = '0';
    next.style.zIndex = '1';
    current.style.zIndex = '2';
    handingOff = false;
  };

  if (started && typeof started.then === 'function') started.then(runFade).catch(abort);
  else runFade();

  handoffTimer = window.setTimeout(() => {
    // Relais annulé entre-temps (onglet caché) : la remise en état s'en occupe.
    if (!layers || gen !== handoffGen) return;
    handoffTimer = 0;
    // Le relais est terminé : la sortante est masquée, remise à zéro et mise en
    // attente. Son prochain seek se fera donc hors écran, sans rien geler.
    if (next.style.opacity !== '0') {
      activeIdx = 1 - activeIdx;
      standby(current);
    } else {
      // Le fondu n'a jamais démarré : la couche entrante avait déjà été lancée,
      // on la remet en attente pour ne pas laisser deux lectures en parallèle.
      // Et on périme la génération pour qu'un `requestAnimationFrame` encore en
      // vol ne puisse plus la rallumer après coup.
      handoffGen++;
      standby(next);
      current.style.zIndex = '2';
    }
    handingOff = false;
  }, Math.round(fadeMs) + 120);
}

function getLayers(): HTMLVideoElement[] {
  if (layers) return layers;

  const a = createVideo(VIDEO_MAIN, false);
  const b = createVideo(VIDEO_MAIN, true);
  a.style.opacity = '0';
  b.style.opacity = '0';
  a.style.zIndex = '2';
  b.style.zIndex = '1';

  // Attention : ne jamais réimposer l'opacité une fois la page révélée, sinon on
  // rallume la couche mise en attente derrière celle qui joue.
  const reveal = () => {
    if (mainReady) return;
    a.style.opacity = DARK_OPACITY;
    markReady(a);
  };

  // ── Ce qui déclenche la révélation de la page ──
  // `canplaythrough` seul ne suffisait pas sur téléphone : iOS/Safari dégrade
  // `preload="auto"` en « métadonnées seules » sur réseau cellulaire, et
  // l'évènement n'arrivait qu'après plusieurs secondes — parfois jamais. La
  // page, dont l'opacité est pilotée par cette révélation, restait alors noire.
  // `loadeddata` (première image décodée, donc quelque chose à montrer) arrive
  // beaucoup plus tôt et sur tous les navigateurs : c'est lui qui commande
  // maintenant, `canplaythrough` ne servant plus que de doublure.
  a.addEventListener('loadeddata', reveal, { once: true });
  a.addEventListener('canplaythrough', reveal, { once: true });

  const fallback = () => {
    if (a.currentTime > 0.05) {
      reveal();
      a.removeEventListener('timeupdate', fallback);
    }
  };
  a.addEventListener('timeupdate', fallback);

  // Échec franc du réseau (zone blanche, requête coupée) : inutile d'attendre
  // le filet de sécurité, on sait déjà qu'aucune image ne viendra. L'image fixe
  // posée SOUS les couches couvre la zone, donc la page se révèle complète.
  a.addEventListener('error', reveal, { once: true });
  a.addEventListener('abort', reveal, { once: true });

  // ── Filet de sécurité ──
  // Plafond absolu sur l'attente, quoi qu'il arrive au réseau. Il était à
  // 6000 ms : sur un téléphone en 4G faible, ces 6 secondes s'ajoutaient au
  // temps de chargement du bundle et l'écran restait NOIR tout ce temps (la
  // page entière est masquée jusqu'à la révélation), ce qui donnait un site
  // apparemment mort à l'ouverture. Court désormais : au-delà, on révèle avec
  // l'image fixe (= la première image de la vidéo) à la place de la vidéo, donc
  // rien ne paraît « à moitié chargé », et la vidéo prend le relais en silence
  // dès qu'elle arrive.
  window.setTimeout(reveal, 1200);

  const observer = new MutationObserver(() => {
    if (mainReady) { applyTheme(a); applyTheme(b); if (still) applyTheme(still); }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  layers = [a, b];
  activeIdx = 0;

  a.load();
  a.play().catch(() => {});
  // La doublure est chargée et amorcée sur sa première image, puis laissée en
  // attente : au moment du relais elle n'a plus rien à décoder.
  b.load();
  b.pause();
  try { b.currentTime = 0; } catch { /* noop */ }

  startKeepAlive(layers);
  startHandoffWatcher(layers);
  return layers;
}

// ── Fondu du haut : masque, et non plus dégradé posé par-dessus ──
// AVANT : un <div> occupait les `fade` premiers pixels de la vidéo avec un
// dégradé `var(--surface-0)` → transparent, pour noyer le bord net du haut de
// la vidéo dans le fond de page. Deux défauts, tous deux visibles dans la
// vignette d'aperçu de la fenêtre (survol de la barre des tâches) :
//  • ce dégradé, empilé au-dessus d'une vidéo, devient une COUCHE de
//    composition à part. Quand le navigateur recompose la page pour la
//    vignette, cette couche peut être reprise d'un rendu précédent (échelle ou
//    thème d'avant) : on voyait alors un grand dégradé BLANC en plein milieu
//    d'une page sombre ;
//  • il lisait `--surface-0`, donc la moindre divergence de thème entre cette
//    couche et le reste de la page se traduisait par une bande claire.
// MAINTENANT : on découpe directement l'opacité de la vidéo (masque). Le fondu
// ne peint plus rien du tout : il laisse voir le VRAI fond de page derrière,
// donc il est juste par construction dans les deux thèmes, et il n'y a plus de
// couche superposée à désynchroniser. Bonus : une vidéo masquée ne peut plus
// être promue en plan vidéo matériel, ce plan étant précisément celui que la
// vignette de la fenêtre ne capture pas (d'où la vidéo « disparue »).
function fadeMask(fade: number): string {
  return `linear-gradient(to bottom, rgba(0,0,0,0) 0px, rgba(0,0,0,1) ${fade}px)`;
}

export function GlobalVideoSlot({ visible, fade = 0 }: { visible: boolean; fade?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Image fixe en dessous : si le navigateur ne peint pas la vidéo (vignette
    // d'aperçu, décodeur libéré, tout début du chargement), cette zone garde
    // l'image de fond au lieu de se vider.
    const st = getStill();
    if (st.parentElement !== el) el.insertBefore(st, el.firstChild);
    applyTheme(st);
    const vs = getLayers();
    for (const v of vs) {
      if (v.parentElement !== el) el.appendChild(v);
      if (mainReady) applyTheme(v);
    }
    const v = vs[activeIdx];
    if (v.paused) v.play().catch(() => {});
  }, [visible]);

  const mask = fade > 0 ? fadeMask(fade) : undefined;

  return (
    <div
      ref={ref}
      className="absolute inset-0"
      style={{
        zIndex: 1,
        position: 'relative',
        pointerEvents: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        maskImage: mask,
        WebkitMaskImage: mask,
      } as CSSProperties}
    />
  );
}
