// ─── Édition visuelle en DIFF ciblé (bouton « Edit » du rectangle d'aperçu) ───
//
// [2026-10-03] Demande : « ça prend trop de temps pour les edits ». Mesuré sur
// une vraie édition visuelle (MailFlow, page /contact) : 65 s pour UN appel
// Sonnet, 21 348 tokens d'entrée et 8 129 tokens de SORTIE — le modèle
// réécrivait la page ENTIÈRE pour changer un seul élément. Le temps d'un appel
// est dominé par les tokens de sortie : renvoyer le fichier complet est donc
// exactement ce qui rendait l'édition lente (et chère : 558 crédits).
//
// Ici le modèle ne renvoie que des blocs SEARCH/REPLACE autour de l'élément
// cliqué (quelques centaines de tokens), appliqués localement. Si un bloc ne
// colle pas au fichier (extrait introuvable ou ambigu), on lui renvoie
// précisément lesquels, une fois. Ce n'est qu'en cas de second échec que
// l'appelant retombe sur la réécriture complète, comme avant.

export type PatchGenerate = (system: string, prompt: string, maxTokens: number) => Promise<string>;

export const VISUAL_PATCH_SYSTEM = `Tu es un expert React/TypeScript/Tailwind qui applique une modification CIBLÉE à un fichier existant d'un site.
Tu réponds UNIQUEMENT par des blocs SEARCH/REPLACE, sans aucun texte autour, sans fence markdown.

Format exact d'un bloc :
<<<<<<< SEARCH
(extrait copié caractère pour caractère du fichier actuel, indentation comprise)
=======
(le même extrait modifié)
>>>>>>> REPLACE

Règles :
- Le SEARCH doit exister TEL QUEL dans le fichier et y être UNIQUE : prends quelques lignes autour de l'élément si besoin.
- Garde les blocs COURTS : uniquement les lignes qui changent, plus le contexte strictement nécessaire à l'unicité.
- Ne modifie que ce qui produit l'élément visé. Le reste du rendu doit rester identique.
- Demande de STYLE (couleur, taille, police, fond, bordure, espacement, alignement…) : change uniquement les classes / le style, jamais le texte.
- Demande de CONTENU (texte, libellé) : change uniquement le texte, garde le style.
- Le texte peut venir d'une expression (ternaire, template littéral, tableau de données, prop) : modifie-le à sa source.
- Ajoute un import seulement s'il est indispensable, par un bloc séparé sur les lignes d'import.
- Le code obtenu doit rester du TSX valide.`;

export function visualPatchPrompt(path: string, current: string, instruction: string, design: unknown, lang: string): string {
  return `Fichier : "${path}"

## MODIFICATION
${instruction}

${design ? `## DESIGN SYSTEM (respecte-le)\n${JSON.stringify(design)}\n\n` : ""}## FICHIER ACTUEL
${current}

Langue du contenu visible : ${lang === "en" ? "ANGLAIS" : "FRANÇAIS"}.
Réponds uniquement par des blocs SEARCH/REPLACE.`;
}

export type PatchBlockFailure = { search: string; reason: "introuvable" | "ambigu" };

/**
 * Applique les blocs SEARCH/REPLACE de `response` à `code`. Un bloc dont
 * l'extrait est absent du fichier ou y apparaît plusieurs fois n'est PAS
 * appliqué (remplacer « la première occurrence » modifierait peut-être un autre
 * élément que celui cliqué) : il est renvoyé dans `failed`.
 */
export function applyStrictPatches(code: string, response: string): { code: string; applied: number; blocks: number; failed: PatchBlockFailure[] } {
  const re = /<{7}\s*SEARCH\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n?>{7}\s*REPLACE/g;
  let out = code;
  let applied = 0;
  let blocks = 0;
  const failed: PatchBlockFailure[] = [];
  for (const m of response.matchAll(re)) {
    blocks++;
    let search = m[1];
    let replace = m[2];
    if (!search.trim()) { failed.push({ search, reason: "introuvable" }); continue; }
    let at = out.indexOf(search);
    if (at === -1) {
      // Divergence fréquente et sans conséquence : espaces en fin de ligne.
      const trimLines = (s: string) => s.replace(/[ \t]+$/gm, "");
      const relaxedOut = trimLines(out);
      const relaxedSearch = trimLines(search);
      if (relaxedOut !== out || relaxedSearch !== search) {
        const i = relaxedOut.indexOf(relaxedSearch);
        if (i !== -1 && relaxedOut.indexOf(relaxedSearch, i + 1) === -1) {
          out = relaxedOut;
          search = relaxedSearch;
          replace = trimLines(replace);
          at = i;
        }
      }
    }
    if (at === -1) { failed.push({ search, reason: "introuvable" }); continue; }
    if (out.indexOf(search, at + 1) !== -1) { failed.push({ search, reason: "ambigu" }); continue; }
    out = out.slice(0, at) + replace + out.slice(at + search.length);
    applied++;
  }
  return { code: out, applied, blocks, failed };
}

function failureFeedback(failed: PatchBlockFailure[], blocks: number): string {
  if (blocks === 0) {
    return "Ta réponse ne contenait AUCUN bloc SEARCH/REPLACE valide. Réponds uniquement avec le format demandé.";
  }
  const list = failed
    .slice(0, 5)
    .map((f, i) => `Bloc ${i + 1} (${f.reason === "ambigu" ? "apparaît plusieurs fois — ajoute du contexte pour le rendre unique" : "introuvable tel quel dans le fichier — recopie-le exactement"}) :\n${f.search.slice(0, 600)}`)
    .join("\n\n");
  return `Ces blocs SEARCH n'ont PAS pu être appliqués :\n\n${list}\n\nRenvoie TOUS les blocs nécessaires à la modification (pas seulement ceux-ci), avec des SEARCH copiés exactement depuis le FICHIER ACTUEL.`;
}

/**
 * Modifie `current` en diff ciblé. Renvoie le nouveau code, ou null si le
 * modèle n'a produit aucun diff applicable en deux essais (ou un diff qui ne
 * change rien) — l'appelant décide alors de réécrire le fichier en entier.
 */
export async function patchFileForVisualEdit(opts: {
  path: string;
  current: string;
  instruction: string;
  design?: unknown;
  lang: string;
  generate: PatchGenerate;
  onProgress?: (msg: string) => void;
}): Promise<{ code: string; applied: number; attempts: number } | null> {
  const { path, current, instruction, design, lang, generate, onProgress } = opts;
  const base = visualPatchPrompt(path, current, instruction, design, lang);
  let prompt = base;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await generate(VISUAL_PATCH_SYSTEM, prompt, 4000);
    const r = applyStrictPatches(current, text || "");
    // Tout ou rien : un diff à moitié appliqué peut laisser du JSX incohérent.
    if (r.blocks > 0 && r.failed.length === 0 && r.code !== current) {
      return { code: r.code, applied: r.applied, attempts: attempt };
    }
    if (attempt === 1) {
      onProgress?.(`🔁 Diff ciblé non applicable sur ${path}, nouvel essai…`);
      prompt = `${base}\n\n## CORRECTION\n${failureFeedback(r.failed, r.blocks)}`;
    }
  }
  return null;
}
