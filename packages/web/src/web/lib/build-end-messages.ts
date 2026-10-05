// ── Messages de fin de build affichés EN DIRECT ─────────────────────────────
//
// [2026-10-04] À la fin d'un build, le serveur écrit plusieurs messages dans le
// chat (stratégie marketing, pack visibilité, contenu d'exemple, propositions,
// et en DERNIER le récap de ce qui a été construit). Le navigateur n'en relisait
// qu'un (le marketing) et ajoutait à la place « Your project is ready! 🎉 »,
// codé en dur et jamais enregistré : sans recharger la page, l'utilisateur ne
// voyait ni le récap ni la plupart des fichiers.
//
// Les messages concernés sont reconnus par leur id (posé côté serveur dans
// api/index.ts runBuildWebsiteWork et api/builder/build-recap.ts) et par leur
// date : seuls ceux écrits depuis le départ du build sont repris.

import type { BuildMessage } from './build-store';

export const BUILD_END_ID_PREFIXES = ['build-end-', 'demo-notice-', 'build-recap-'] as const;

export const buildRecapId = (companyId: string) => `build-recap-${companyId}`;

/** `created_at` n'a qu'une précision d'une seconde : marge pour ne pas rater un message du départ. */
const SINCE_MARGIN_MS = 2000;

function msgTime(m: any): Date | null {
  const raw = m?.createdAt ?? m?.created_at;
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  const d = !isNaN(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Les messages de fin de build à ajouter au fil, dans l'ordre, récap en dernier
 * (c'est lui que run-layout.ts affiche comme réponse du run).
 *
 * @param history     Les messages renvoyés par GET /chat/:companyId.
 * @param since       Départ du build (job) ; null → seul le récap de ce projet est repris.
 * @param presentIds  Ids déjà affichés (dédoublonnage).
 * @param modelLabel  Étiquette de modèle à afficher pour un message.
 */
export function pickBuildEndMessages(
  history: any[],
  companyId: string,
  since: Date | null,
  presentIds: Set<string>,
  modelLabel: (model?: string | null) => string | undefined = (m) => m || undefined,
): BuildMessage[] {
  const recapId = buildRecapId(companyId);
  const out: Array<BuildMessage & { _t: number }> = [];
  for (const m of history || []) {
    const id = String(m?.id || '');
    if (m?.role !== 'assistant' || presentIds.has(id)) continue;
    if (!BUILD_END_ID_PREFIXES.some((p) => id.startsWith(p))) continue;
    // Un récap/avis d'un AUTRE projet n'a rien à faire ici (session partagée improbable, mais gratuit à exclure).
    if ((id.startsWith('build-recap-') || id.startsWith('demo-notice-')) && !id.endsWith(companyId)) continue;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) continue;
    const t = msgTime(m);
    if (since) {
      if (!t || t.getTime() < since.getTime() - SINCE_MARGIN_MS) continue;
    } else if (id !== recapId) {
      continue;
    }
    out.push({ id, role: 'assistant', content, model: modelLabel(m.model), time: t || new Date(), _t: t?.getTime() ?? Date.now() });
  }
  out.sort((a, b) => (a.id === recapId ? 1 : 0) - (b.id === recapId ? 1 : 0) || a._t - b._t);
  // Le récap doit rester APRÈS les autres même à la seconde près (tri par date dans chat.tsx).
  const last = out[out.length - 1];
  if (last && last.id === recapId) {
    const maxOther = out.slice(0, -1).reduce((mx, x) => Math.max(mx, x.time.getTime()), 0);
    if (last.time.getTime() <= maxOther) last.time = new Date(maxOther + 1);
  }
  return out.map(({ _t, ...m }) => m);
}
