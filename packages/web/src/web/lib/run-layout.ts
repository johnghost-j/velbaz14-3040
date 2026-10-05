/**
 * Mise en page d'un « run » dans le fil de discussion.
 *
 * [2026-09-19] Un run, c'est un paquet de travail : des étapes, les petits
 * textes que l'IA dit entre elles, et un texte de conclusion. Trois règles
 * décident de ce qui s'affiche où, et elles sont ici plutôt que noyées dans
 * le JSX de la page :
 *
 *  1. RÉCAP — le dernier texte de l'IA du run est la réponse. Il sort du
 *     déroulé repliable et reste visible en pleine taille.
 *  2. TRANSITIONS — tous les autres textes de l'IA sont du commentaire de
 *     travail : ils restent dans le déroulé, en petit et en gris.
 *  3. FICHIERS — un fichier déposé au milieu du travail ne doit pas rester
 *     coincé entre deux étapes (il disparaîtrait avec le déroulé replié). Les
 *     balises [FILE:…] sont retirées des textes et regroupées en fin de run.
 *
 * Pendant que le run TOURNE, rien ne bouge : pas de récap extrait, l'ordre
 * chronologique est conservé sous les yeux de l'utilisateur.
 */

/** Une balise fichier telle que l'IA l'émet dans son texte. */
const FILE_TAG = /\[FILE:[^\]]+\]/g;

/** Les balises fichier d'un texte, dans l'ordre d'apparition. */
export function collectFileTags(text: string): string[] {
  return text.match(FILE_TAG) || [];
}

/**
 * Le texte sans ses balises fichier, et sans les trous qu'elles laissent :
 * espaces en fin de ligne, lignes vides en série, bords. Un texte qui ne
 * contenait QUE des fichiers revient vide — c'est ainsi qu'on sait qu'il n'a
 * plus rien à afficher.
 */
export function stripFileTags(text: string): string {
  return text
    .replace(FILE_TAG, '')
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : l.replace(/[ \t]+$/, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Ce que la page sait d'un élément du run, réduit à ce qui décide de sa place. */
export type RunItem = {
  /** 'build' = un paquet d'étapes ; 'msg' = un texte du fil. */
  type: 'build' | 'msg';
  role?: string;
  content?: string;
  /** Un message de conversation d'équipe n'est jamais le récap. */
  hasTeamMsgs?: boolean;
};

export type RunLayout = {
  /** Index du récap dans le tableau reçu, ou -1 s'il n'y en a pas. */
  recapIdx: number;
  /** Indices des textes de transition qui ont encore quelque chose à dire. */
  visibleIdx: number[];
  /** Les fichiers du run, dédupliqués, dans l'ordre d'apparition. */
  fileTags: string[];
};

/**
 * Répartit les éléments d'un run entre déroulé, récap et fichiers.
 *
 * @param items  Les éléments du run, dans l'ordre chronologique.
 * @param isLive Le run est-il encore en train de tourner ?
 */
export function layoutRun(items: RunItem[], isLive = false): RunLayout {
  let recapIdx = -1;
  if (!isLive) {
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.type !== 'msg' || it.role !== 'assistant' || it.hasTeamMsgs) continue;
      // Un message réduit à ses balises fichier ne fait pas un récap : on
      // afficherait un logo suivi de rien.
      if (!stripFileTags(it.content || '')) continue;
      recapIdx = k;
    }
  }

  const visibleIdx: number[] = [];
  const fileTags: string[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.type !== 'msg') continue;
    if (it.role === 'assistant') fileTags.push(...collectFileTags(it.content || ''));
    if (k === recapIdx) continue;
    // Un texte réduit à ses seules balises fichier n'a plus rien à montrer :
    // il s'efface au lieu de laisser une ligne vide dans le déroulé.
    const hasText = it.role !== 'assistant' || !!stripFileTags(it.content || '');
    if (hasText) visibleIdx.push(k);
  }

  return { recapIdx, visibleIdx, fileTags: [...new Set(fileTags)] };
}
