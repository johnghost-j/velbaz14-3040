import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

// [2026-09-26] Garde-fou de non-régression : écran NOIR à l'ouverture du site
// sur téléphone.
//
// La page d'accueil entière est masquée (`opacity: 0`) jusqu'à ce que la vidéo
// de fond se déclare prête — c'est voulu, le site se révèle d'un bloc au lieu
// de montrer l'interface sans son fond. Mais tant que cette révélation dépend
// du réseau, elle doit être PLAFONNÉE et réagir à l'échec, sinon le visiteur
// regarde un écran noir :
//  • `canplaythrough` seul ne suffit pas — iOS/Safari dégrade `preload="auto"`
//    en métadonnées sur réseau cellulaire et l'évènement tarde, ou n'arrive
//    jamais ;
//  • une requête vidéo qui échoue ne réveillait personne : on attendait quand
//    même le minuteur ;
//  • ce minuteur était à 6000 ms, qui s'ajoutaient au chargement du bundle →
//    jusqu'à ~10 s de noir sur un téléphone en 4G faible.
// Mesuré avant correctif (vidéo coupée, iPhone émulé) : contenu lisible à
// ~8000 ms. Après : ~2500 ms, dont l'essentiel est le bundle.
const src = readFileSync(new URL('./GlobalVideo.tsx', import.meta.url), 'utf8');

// Le code sans ses commentaires : les explications ci-dessus citent les anciens
// réglages, elles ne doivent pas faire passer les tests pour de vrai code.
const code = src
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
  .join('\n');

describe('révélation de la page d’accueil', () => {
  it('plafonne l’attente de la vidéo à 2 secondes maximum', () => {
    const m = /window\.setTimeout\(\s*reveal\s*,\s*(\d+)\s*\)/.exec(code);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(2000);
  });

  it('révèle dès la première image décodée, sans attendre canplaythrough', () => {
    expect(/addEventListener\(\s*'loadeddata'\s*,\s*reveal/.test(code)).toBe(true);
  });

  it('révèle immédiatement si la vidéo échoue ou est coupée', () => {
    expect(/addEventListener\(\s*'error'\s*,\s*reveal/.test(code)).toBe(true);
    expect(/addEventListener\(\s*'abort'\s*,\s*reveal/.test(code)).toBe(true);
  });

  it('garde une image fixe sous les couches vidéo pour couvrir la zone', () => {
    // C'est elle qui rend la révélation anticipée acceptable : on ne montre
    // jamais un trou à la place de la vidéo, mais sa première image.
    expect(code).toContain("VIDEO_STILL = '/images/video-bg-still.webp'");
    expect(/backgroundImage:\s*`url\(\$\{VIDEO_STILL\}\)`/.test(code)).toBe(true);
  });
});

describe('page d’accueil : couplage opacité / vidéo', () => {
  const page = readFileSync(new URL('../pages/index.tsx', import.meta.url), 'utf8');

  it('masque bien toute la page jusqu’à la révélation', () => {
    // Si ce couplage disparaît un jour, les garde-fous ci-dessus perdent leur
    // raison d'être ; s'il reste, ils sont obligatoires.
    expect(/opacity:\s*pageReady\s*\?\s*1\s*:\s*0/.test(page)).toBe(true);
    expect(page).toContain('subscribeMainVideoReady');
  });
});
