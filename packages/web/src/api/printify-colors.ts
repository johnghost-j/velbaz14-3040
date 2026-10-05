// ─── Choix des couleurs de vêtement en fonction du design ────────────────────
// ANCIEN COMPORTEMENT (bug) : `rawVariants.slice(0, maxVariants)` gardait les N
// premières variantes dans l'ordre de l'API Printify. Comme l'API trie par
// couleur, un produit limité à 6 variantes ne sortait qu'en « Dark Chocolate »,
// et un design sombre pouvait se retrouver imprimé sur un t-shirt noir (donc
// invisible). On choisit désormais les couleurs qui font RESSORTIR le design,
// puis on active TOUTES les tailles de ces couleurs.

/** Luminance estimée (0=noir, 255=blanc) d'un nom de couleur Printify. */
const COLOR_LUMINANCE: Array<[RegExp, number]> = [
  [/^white$|pure white|optic white/i, 250],
  [/natural|ivory|cream|off.?white|vanilla/i, 235],
  [/^sand$|beige|khaki|oatmeal|bone|pebble/i, 215],
  [/light pink|baby|pale|light blue|light grey|light gray|powder/i, 210],
  [/^ash$|silver|sport grey|sport gray|heather grey|heather gray|athletic heather/i, 195],
  [/yellow|lemon|daisy|butter/i, 200],
  [/gold|mustard|amber/i, 165],
  [/^pink$|rose|coral|peach|salmon|lilac|lavender/i, 165],
  [/orange|tangerine/i, 150],
  [/light heather|heather$/i, 150],
  [/^red$|cardinal|cherry|scarlet/i, 95],
  [/^green$|irish green|kelly|lime|mint/i, 120],
  [/turquoise|aqua|sky|cyan/i, 160],
  [/^royal$|^blue$|sapphire/i, 85],
  [/dark heather|graphite|charcoal|smoke|slate/i, 80],
  [/^grey$|^gray$|steel/i, 120],
  [/purple|violet|plum|berry/i, 70],
  [/maroon|burgundy|wine|brick/i, 55],
  [/brown|chocolate|espresso|coffee|rust/i, 50],
  [/forest|olive|army|military|hunter|moss/i, 55],
  [/navy|midnight|indigo|denim/i, 40],
  [/^black$|jet|onyx|coal/i, 20],
];

/** Couleurs « cœur de gamme » : à privilégier à contraste équivalent. */
const CORE = /^(white|black|navy|sport grey|sport gray|athletic heather|dark heather|natural|ash)$/i;

export function colorLuminance(name: string): number {
  const n = (name || '').trim();
  for (const [re, lum] of COLOR_LUMINANCE) if (re.test(n)) return lum;
  return 128; // inconnu → neutre
}

export interface ColorPick {
  color: string;
  luminance: number;
  contrast: number;
}

/**
 * Sélectionne les couleurs de vêtement où le design se voit vraiment.
 * @param colors        noms de couleurs disponibles pour le blueprint/provider
 * @param artLuminance  luminance moyenne des pixels visibles du design
 * @param max           nombre de couleurs à retenir
 */
export function pickGarmentColors(colors: string[], artLuminance: number, max = 4): ColorPick[] {
  const uniq = [...new Set(colors.filter(Boolean))];
  if (!uniq.length) return [];

  const scored = uniq.map((color) => {
    const luminance = colorLuminance(color);
    const contrast = Math.abs(luminance - artLuminance);
    // Bonus cœur de gamme, et malus si le contraste est insuffisant pour lire
    // le design (un print sombre sur tissu sombre ne se voit pas).
    const coreBonus = CORE.test(color) ? 18 : 0;
    const tooClose = contrast < 55 ? -140 : 0;
    return { color, luminance, contrast, score: contrast + coreBonus + tooClose };
  });

  scored.sort((a, b) => b.score - a.score);
  const kept = scored.filter((s) => s.contrast >= 55);
  const chosen = (kept.length ? kept : scored).slice(0, Math.max(1, max));
  return chosen.map(({ color, luminance, contrast }) => ({ color, luminance, contrast }));
}

/** Ordre de tailles usuel, pour activer les variantes dans un ordre lisible. */
const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', '4XL', '5XL'];
export function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const ia = SIZE_ORDER.indexOf((a || '').toUpperCase());
    const ib = SIZE_ORDER.indexOf((b || '').toUpperCase());
    if (ia === -1 && ib === -1) return String(a).localeCompare(String(b));
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}
