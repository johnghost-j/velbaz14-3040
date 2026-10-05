// ─── Marqueur des fichiers « squelette » de l'aperçu en direct ───────────────
// L'aperçu en direct écrit d'abord un jeu de fichiers AMORCE (pages squelette,
// Header/Footer placeholder) pour que Vite démarre en quelques secondes, puis
// chaque fichier RÉEL écrase son squelette au fur et à mesure de la génération.
//
// [2026-09-25] BUG : quand cette réécriture n'aboutit pas sur le disque (build
// interrompu + reprise, process Vite qui survit à un redémarrage, écriture
// finale perdue), le squelette reste servi INDÉFINIMENT — la base contient le
// vrai site, l'aperçu public montre des rectangles pulsants. Rien ne se
// réparait tout seul : `ensureRunningApp` rendait le serveur vivant sans jamais
// comparer le disque à la base.
//
// Correctif : chaque fichier squelette porte ce marqueur. Un fichier squelette
// resté sur le disque est donc DÉTECTABLE en une lecture, et le disque peut
// être resynchronisé depuis la base (source de vérité) — même logique que le
// marqueur des images placeholder (`placeholderGradientDataUri`).
// Le marqueur vit dans un module SANS dépendance : `engine.ts` (producteur) et
// `runner.ts` (détecteur) l'importent tous les deux sans créer de cycle.
export const STUB_MARKER = "@velbaz-stub";

// Commentaire à poser en tête d'un fichier squelette généré.
export const STUB_BANNER = `/* ${STUB_MARKER} — placeholder de l'aperçu en direct, remplacé par le code réel */`;

export function isStubSource(content: string | null | undefined): boolean {
  return !!content && content.includes(STUB_MARKER);
}

// Chemins « source » de l'app générée qu'on audite : le squelette ne concerne
// que les pages et Header/Footer.
export function isAuditableSourcePath(rel: string): boolean {
  return /^src\/(pages|components)\/.+\.(tsx?|jsx?)$/.test(rel);
}

// ── Projets d'AVANT le marqueur ──────────────────────────────────────────────
// Les sites déjà construits (dont ceux bloqués en squelette aujourd'hui) n'ont
// pas le marqueur sur le disque : sans reconnaissance de leur signature, le
// correctif ne réparerait QUE les futurs builds. On reconnaît donc aussi la
// forme exacte des anciens squelettes (texte du spinner, en-tête/pied
// placeholder), avec des critères assez étroits pour ne jamais confondre une
// vraie page avec un squelette.
export function isLegacyStubSource(rel: string, content: string): boolean {
  if (!content) return false;
  // Page squelette : spinner « Construction de « X »… » + blocs pulsants.
  if (/Construction de\s*«/.test(content) && content.includes("animate-pulse")) return true;
  const file = rel.split("/").pop() || "";
  // Header placeholder : bouton fantôme pulsant, et aucun contenu réel (une
  // vraie en-tête générée fait plusieurs milliers de caractères).
  if (file === "Header.tsx" && content.length < 2500
    && /h-9 w-24 rounded-full bg-gray-100/.test(content) && content.includes("animate-pulse")) return true;
  // Footer placeholder : juste « © année Nom », aucun import, aucun lien.
  if (file === "Footer.tsx" && content.length < 700 && !/\bimport\b/.test(content)
    && !content.includes("<Link") && /border-t border-gray-100/.test(content)) return true;
  return false;
}

// Vrai si le fichier est un squelette d'amorçage (marqueur OU ancienne forme).
export function isStubFile(rel: string, content: string): boolean {
  return isStubSource(content) || isLegacyStubSource(rel, content);
}
