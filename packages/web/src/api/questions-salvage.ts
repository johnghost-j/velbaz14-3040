// ─── Récupération d'un bloc [QUESTIONS] TRONQUÉ ─────────────────────────────
//
// POURQUOI CE FICHIER EXISTE (bug corrigé le 2026-09-16)
//
// Symptôme rapporté : « crée-moi une marque de vêtement » donnait parfois une
// entreprise qui crée des marques de vêtements POUR D'AUTRES (agence B2B) au
// lieu de LA marque de l'utilisateur.
//
// Cause réelle mesurée : le questionnaire de découverte du modèle est long
// (6-8 questions avec options = ~2 400 caractères de JSON, soit ~1 000 tokens
// en français accentué). Quand il dépassait le budget de tokens, le flux était
// coupé EN PLEIN MILIEU du JSON. Le backend validait ce bloc avec un
// `JSON.parse` naïf : parse en échec ⇒ bloc considéré ABSENT ⇒ on jetait les
// vraies questions du modèle (pays, style de vêtements, produit signature,
// fourchette de prix à la pièce…) et on injectait le questionnaire GÉNÉRIQUE
// orienté SaaS (« public cible : Petites entreprises / Startups », « modèle de
// prix : Abonnement mensuel / Freemium »).
// L'utilisateur répondait donc « Petites entreprises » + « Abonnement mensuel »
// pour une marque de vêtements → ce contexte partait au build → le pipeline
// construisait fidèlement… un service B2B par abonnement autour du vêtement.
//
// Le frontend savait déjà réparer un bloc tronqué (chat.tsx →
// parseQuestionsFromContent) mais il ne voyait jamais le bloc : le backend
// l'avait déjà remplacé. On porte donc ce scan tolérant côté serveur.

export type SalvagedQuestion = {
  q: string;
  options?: { id?: string; label: string }[];
  kind?: string;
  placeholder?: string;
  allowCustom?: boolean;
  [k: string]: unknown;
};

/** Une question est exploitable par le formulaire si elle a un libellé réel. */
function isUsable(q: any): q is SalvagedQuestion {
  return !!q && typeof q.q === 'string' && q.q.trim().length > 2;
}

/**
 * Le dernier objet réparé porte-t-il un libellé coupé en plein mot
 * (« Quel prix par pièc ») ? Dans ce cas on préfère l'abandonner : mieux vaut
 * une question en moins qu'une question illisible affichée à l'utilisateur.
 * Une vraie question du modèle se termine par ? ! . ou :
 */
function isMutilated(q: SalvagedQuestion, cutMidString: boolean): boolean {
  if (!cutMidString) return false;
  return !/[?!.:…]$/.test(q.q.trim());
}

/**
 * Coupure survenue APRÈS le libellé de la question (donc dans les options) :
 * la question est bonne, mais sa dernière option peut être tronquée. On la
 * retire, et si il ne reste plus assez de choix on passe la question en champ
 * libre plutôt que d'afficher une liste amputée.
 */
function sanitizeCut(q: SalvagedQuestion, cutMidString: boolean): SalvagedQuestion {
  if (!cutMidString || !Array.isArray(q.options) || !q.options.length) return q;
  const options = q.options.slice(0, -1).filter((o) => o && typeof o.label === 'string' && o.label.trim().length > 0);
  if (options.length < 2) {
    const { options: _drop, ...rest } = q;
    return { ...rest, kind: 'text' } as SalvagedQuestion;
  }
  return { ...q, options, allowCustom: true };
}

/**
 * Extrait toutes les questions d'un bloc [QUESTIONS], même si le JSON est
 * incomplet (flux coupé net). Scan équilibré objet par objet : chaque `{...}`
 * complet est récupéré, et le DERNIER objet inachevé est réparé (guillemet,
 * virgule, crochets et accolades manquants) avant d'être tenté.
 *
 * La balise de fermeture [/QUESTIONS] est OPTIONNELLE — c'est justement elle
 * qui manque quand la génération est tronquée.
 *
 * @returns les questions trouvées, ou null s'il n'y a rien à récupérer.
 */
export function salvageQuestions(raw: string): SalvagedQuestion[] | null {
  const txt = String(raw || '');
  const start = txt.indexOf('[QUESTIONS]');
  if (start === -1) return null;

  let body = txt.slice(start + '[QUESTIONS]'.length);
  const endTag = body.indexOf('[/QUESTIONS]');
  if (endTag !== -1) body = body.slice(0, endTag);
  const fb = body.indexOf('[');
  if (fb !== -1) body = body.slice(fb + 1);

  const objs: string[] = [];
  // Pile des délimiteurs ouverts ({ et [) : elle permet de refermer le dernier
  // objet tronqué DANS LE BON ORDRE (une option coupée à l'intérieur d'un
  // tableau se referme « } puis ] puis } », pas l'inverse).
  const stack: string[] = [];
  let depth = 0, buf = '', inStr = false, esc = false;
  for (const ch of body) {
    if (inStr) {
      buf += ch;
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; buf += ch; continue; }
    if (ch === '{' || ch === '[') {
      if (ch === '{') depth++;
      stack.push(ch);
      buf += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] === (ch === '}' ? '{' : '[')) stack.pop();
      if (ch === '}') {
        depth--;
        buf += ch;
        if (depth === 0) { objs.push(buf); buf = ''; }
        continue;
      }
      if (depth > 0) buf += ch;
      continue;
    }
    if (depth > 0) buf += ch;
  }

  const out: SalvagedQuestion[] = [];
  for (const o of objs) {
    try {
      const p = JSON.parse(o);
      if (isUsable(p)) out.push(p);
    } catch { /* objet illisible : ignoré */ }
  }

  // Dernier objet incomplet (flux coupé net) : réparation ciblée.
  if (buf.trim().startsWith('{')) {
    let r = buf;
    // Chaîne laissée ouverte par la coupure : on la referme, mais on retient
    // l'info — ce qui a été coupé en plein milieu (libellé de question ou
    // d'option) est du texte MUTILÉ qu'on refuse d'afficher tel quel.
    const cutMidString = inStr;
    if (cutMidString) r += '"';
    const close = () => {
      let s = r.replace(/,\s*$/, '');
      // Clé écrite sans sa valeur (« …,"options": ») ou valeur littérale
      // coupée (« …,"allowCustom":tr ») : on retire le fragment.
      s = s.replace(/,?\s*"[^"]*"\s*:\s*(?:[a-z0-9.+-]*)?$/i, '');
      for (let i = stack.length - 1; i >= 1; i--) s += stack[i] === '{' ? '}' : ']';
      return s + '}';
    };
    for (const candidate of [close(), close().replace(/,\s*(?=[}\]])/g, '')]) {
      try {
        const p = JSON.parse(candidate);
        if (isUsable(p) && !isMutilated(p, cutMidString)) out.push(sanitizeCut(p, cutMidString));
        break;
      } catch { /* on tente la variante suivante */ }
    }
  }

  return out.length > 0 ? out : null;
}

/**
 * Réécrit une réponse pour qu'elle contienne un bloc [QUESTIONS] PROPRE et
 * complet, construit à partir des questions récupérées. L'intro rédigée par le
 * modèle est conservée ; tout ce qui suit le marqueur ouvrant (JSON tronqué,
 * bavardage) est remplacé.
 *
 * @returns la réponse réparée, ou null s'il n'y avait rien à récupérer.
 */
export function repairQuestionsBlock(reply: string): { reply: string; questions: SalvagedQuestion[] } | null {
  const questions = salvageQuestions(reply);
  if (!questions || !questions.length) return null;
  const intro = String(reply || '')
    .split('[QUESTIONS]')[0]
    .replace(/\[\/?QUESTIONS\]/gi, '')
    .trim();
  const block = `[QUESTIONS]${JSON.stringify(questions)}[/QUESTIONS]`;
  return { reply: intro ? `${intro}\n\n${block}` : block, questions };
}
