// ─── Boutons LOGIQUES pour une boutique ─────────────────────────────────────
// [2026-10-01] Bug signalé : « crée une boutique de chaussures » → le site
// affichait des boutons de logiciel : « Get started », « Essai gratuit »,
// « Réserver un essai », « Book a demo »… Une boutique vend : ses boutons
// sont « Ajouter au panier », « Acheter », « Voir le produit », « Découvrir la
// collection ». Deux protections :
//   1. une consigne dans les prompts (Header + pages) quand le site est une
//      boutique ;
//   2. un correctif DÉTERMINISTE sur le code généré : tout bouton/lien dont le
//      libellé ENTIER est un CTA de logiciel/essai est renommé selon sa cible
//      (fiche produit, inscription, panier/achat, sinon la boutique). Seuls
//      les libellés exacts de boutons sont touchés, jamais la prose ni
//      « Réessayer » / « Try again » (erreurs).

const SHIPPABLE_OBJECT_RE = new RegExp(
  "\\b(" + [
    "chaussures?", "baskets?", "sneakers?", "shoes?", "footwear", "bottes?", "boots?", "sandales?", "sandals?",
    "v[eê]tements?", "clothing", "apparel", "t-?shirts?", "hoodies?", "sweats?", "streetwear", "mode", "fashion",
    "casquettes?", "caps?", "bonnets?", "sacs?", "bags?", "maroquinerie",
    "bijoux", "bijou", "jewel(?:le)?ry", "montres?", "watches?", "lunettes?", "sunglasses",
    "mugs?", "tasses?", "posters?", "affiches?", "bougies?", "candles?", "cosm[eé]tiques?", "cosmetics", "skincare",
    "parfums?", "perfumes?", "accessoires?", "accessories", "coques?", "phone cases?", "gourdes?", "bottles?",
    "boutique", "e-?shop", "e-?commerce", "online store", "shop", "store", "merch",
  ].join("|") + ")\\b",
  "i",
);

/** Vrai quand le site est une boutique qui vend des produits livrables. */
export function isShopSite(opts: { appType?: string; hasCatalog?: boolean; idea?: string; industry?: string }): boolean {
  if (opts.hasCatalog) return true;
  const t = String(opts.appType || "").toLowerCase();
  if (t === "ecommerce") return true;
  // « brand » couvre aussi une marque auto/immobilier (essai légitime) : on ne
  // tranche que si l'idée parle d'objets livrables.
  const text = `${opts.idea || ""} ${opts.industry || ""}`;
  if ((t === "brand" || t === "" || t === "marketplace") && SHIPPABLE_OBJECT_RE.test(text)) return true;
  return false;
}

/** Consigne pour les prompts de pages / Header d'une boutique. */
export function shopCtaRules(lang: string): string {
  const en = lang === "en";
  return `
## 🛍️ C'EST UNE BOUTIQUE — BOUTONS DE COMMERCE UNIQUEMENT (RÈGLE PRIORITAIRE)
Le visiteur vient ACHETER un produit, pas tester un logiciel. Chaque bouton doit correspondre à une action d'achat logique :
- Carte produit → ${en ? "« View product » / « Add to cart »" : "« Voir le produit » / « Ajouter au panier »"} ; fiche produit → ${en ? "« Add to cart » / « Buy now »" : "« Ajouter au panier » / « Acheter maintenant »"} (désactivé tant que la taille/variante n'est pas choisie) ; hero / bandeau → ${en ? "« Shop the collection » / « Discover »" : "« Découvrir la collection » / « Voir la boutique »"} ; détails → ${en ? "« Description », « Size guide », « Shipping & returns »" : "« Description », « Guide des tailles », « Livraison & retours »"}.
- Header : à droite le <ThemeToggle />, puis (si comptes activés) ${en ? "« Sign in »" : "« Connexion »"} en lien discret et ${en ? "« Create account »" : "« Créer un compte »"} vers /signup — JAMAIS « Get started » / « Commencer ». Le CTA principal du header, s'il y en a un, mène à la boutique (${en ? "« Shop »" : "« Boutique »"}).
- INTERDIT sur tout le site : « Essai gratuit », « Essayer », « Essayer gratuitement », « Démarrer l'essai », « Réserver un essai », « Réserver un essayage », « Demander une démo », « Commencer », « Get started », « Start free trial », « Try for free », « Book a demo », « Start now », « Sign up free », et tout vocabulaire de SaaS (plan, abonnement, workspace, onboarding) — sauf si l'utilisateur l'a demandé explicitement.
`;
}

// Libellés de logiciel/essai (comparés après normalisation, libellé ENTIER).
const SAAS_LABELS_EN = [
  "get started", "get started now", "get started for free", "get started free", "start now", "start today",
  "start free", "start for free", "start free trial", "start your free trial", "start your trial", "free trial",
  "try it", "try it free", "try it now", "try for free", "try free", "try now", "book a demo", "request a demo",
  "get a demo", "book a trial", "book a fitting", "book a try on", "book your fitting", "sign up free",
  "sign up for free", "start building", "launch app", "open app",
];
const SAAS_LABELS_FR = [
  "commencer", "commencer maintenant", "commencer gratuitement", "commencez", "commencez maintenant", "demarrer",
  "demarrer maintenant", "demarrer l essai", "demarrer mon essai", "demarrer l essai gratuit", "essai gratuit",
  "essayer", "essayer gratuitement", "essayer maintenant", "essayez", "essayez gratuitement", "reserver un essai",
  "reserver mon essai", "reserver un essayage", "reserver mon essayage", "demander un essai", "demander une demo",
  "reserver une demo", "voir la demo", "s inscrire gratuitement", "inscription gratuite", "lancer l app",
];

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’'\-]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const EN_SET = new Set(SAAS_LABELS_EN);
const FR_SET = new Set(SAAS_LABELS_FR);

type Target = "signup" | "product" | "buy" | "shop";
function labelFor(lang: "en" | "fr", target: Target): string {
  const t = {
    en: { signup: "Create account", product: "View product", buy: "Add to cart", shop: "Shop now" },
    fr: { signup: "Créer un compte", product: "Voir le produit", buy: "Ajouter au panier", shop: "Voir la boutique" },
  };
  return t[lang][target];
}

function targetOf(openTag: string): Target {
  if (/\/(signup|register|inscription)\b/i.test(openTag)) return "signup";
  if (/\b(checkout|add_?to_?cart|addItem|onBuy|handle\w*(?:Add|Buy|Cart|Checkout)\w*)\b/i.test(openTag)) return "buy";
  if (/\/(products?|produits?|item)\//i.test(openTag) || /\/(products?|produits?)\$\{|\/product\/\$\{/.test(openTag)) return "product";
  return "shop";
}

/**
 * Renomme les boutons/liens de logiciel d'une page de boutique. Ne touche qu'aux
 * éléments <Link>/<a>/<button>/<motion.*> dont le texte visible ENTIER est un
 * CTA d'essai, et aux propriétés de données `cta|label|ctaLabel|buttonText`.
 */
export function fixShopCtas(code: string): { code: string; replaced: number } {
  let replaced = 0;
  // 1) Élément JSX dont le contenu (éventuellement avec une icône) est le libellé.
  const el = /<((?:Link|a|button|motion\.(?:a|button)|Button))(\s(?:[^<>=]|=>?)*?)?>(\s*(?:<[A-Z][\w.]*(?:[^<>=]|=>?)*\/>\s*)?)([^<>{}]+?)(\s*(?:<[A-Z][\w.]*(?:[^<>=]|=>?)*\/>\s*)?)<\/\1>/g;
  let out = code.replace(el, (m, tag: string, attrs: string | undefined, pre: string, text: string, post: string) => {
    const n = norm(text);
    const lang = EN_SET.has(n) ? "en" : FR_SET.has(n) ? "fr" : null;
    if (!lang) return m;
    replaced++;
    const lead = text.match(/^\s*/)?.[0] ?? "";
    const trail = text.match(/\s*$/)?.[0] ?? "";
    return `<${tag}${attrs ?? ""}>${pre}${lead}${labelFor(lang, targetOf(attrs ?? ""))}${trail}${post}</${tag}>`;
  });
  // 2) Libellés stockés dans des données : { cta: "Get started" }.
  out = out.replace(/\b(cta|ctaLabel|ctaText|buttonText|buttonLabel|button|action)(\s*:\s*)(["'`])([^"'`\n]{2,40})\3/g, (m, k: string, sep: string, q: string, text: string) => {
    const n = norm(text);
    const lang = EN_SET.has(n) ? "en" : FR_SET.has(n) ? "fr" : null;
    if (!lang) return m;
    replaced++;
    return `${k}${sep}${q}${labelFor(lang, "shop")}${q}`;
  });
  return { code: out, replaced };
}
