// ─── Lire l'objet JSON d'une réponse de modèle ──────────────────────────────
//
// [2026-10-04] Bug réel : le pack visibilité retombait sur son modèle intégré
// (« visibility: unparseable JSON ») alors que la réponse de l'IA était un JSON
// VALIDE. L'ancien extracteur cherchait un bloc ``` N'IMPORTE OÙ dans le texte
// et le prenait pour l'enveloppe du JSON. Or les documents demandés contiennent
// eux-mêmes des blocs de code (pages HTML « Sites de Référence ») : il parsait
// donc le HTML du 1er bloc trouvé au milieu d'une chaîne JSON, et échouait.
//
// Ordre ici : le texte tel quel ; puis une enveloppe ``` seulement si elle
// ENTOURE la réponse (début et fin du texte) ; puis la tranche { … } la plus
// large ; enfin la même sans virgules finales.

function tryParse(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}

function isObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function outerSlice(s: string): string | null {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start === -1 || end <= start ? null : s.slice(start, end + 1);
}

/** Le premier objet JSON d'une réponse de modèle, ou null s'il n'y en a pas de lisible. */
export function extractJSONObject(raw: string): any | null {
  if (!raw) return null;
  const text = raw.trim();
  const candidates: string[] = [text];
  const wrapped = text.match(/^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i);
  if (wrapped) candidates.push(wrapped[1].trim());
  const slice = outerSlice(wrapped ? wrapped[1] : text);
  if (slice) candidates.push(slice, slice.replace(/,\s*([}\]])/g, "$1"));
  for (const c of candidates) {
    const v = tryParse(c);
    if (isObject(v)) return v;
  }
  return null;
}
