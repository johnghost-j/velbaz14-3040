// ─── Contenu d'exemple ASSUMÉ (4ᵉ option de la règle de vérité) ──────────────
// [2026-09-25] Demande utilisateur : « si on demande une entreprise de voitures,
// d'avions ou n'importe quel produit qu'on ne peut pas vendre tout de suite, il
// faut QUAND MÊME créer la marque et le site — mais dire EN BAS que pour
// l'instant ce sont de fausses informations, et qu'on peut les rendre vraies.
// Comme ça Velbaz n'arnaque personne et le propriétaire le sait. Et il ne faut
// pas que Stripe bugue alors qu'il n'y a rien à vendre. »
//
// Pourquoi ce fichier existe :
//   content-truth.ts interdit d'inventer (avis, labels, prix, adresse…). Pris au
//   pied de la lettre, ça vidait les sites dont le cœur de l'offre ne peut PAS
//   encore être réel : un concessionnaire auto, un courtier en avions, un
//   restaurant sans carte fournie… → catalogue supprimé, site mort.
//   La sortie n'est pas d'inventer en silence (illégal) ni de ne rien générer
//   (inutile) : c'est de générer un catalogue d'EXEMPLE **étiqueté comme tel**,
//   de le DIRE au propriétaire dans le chat Velbaz, et de ne brancher aucun
//   paiement dessus. Une information divulguée comme exemple n'est pas une pratique
//   commerciale trompeuse : ce qui est sanctionné (directive 2005/29/CE mod.
//   (UE) 2019/2161, FTC 16 CFR Part 465), c'est le faux PRÉSENTÉ COMME VRAI.
//
// [2026-09-25 — correction] La mention n'est PLUS affichée dans le site généré
// (bandeau sous le footer de chaque page, composant DemoNotice) : le
// propriétaire n'a pas à montrer à ses visiteurs que son catalogue est un
// exemple. Velbaz le lui DIT dans le chat (message assistant persistant,
// cf. demoNoticeChatMessage) — le garde-fou de paiement côté serveur, lui, reste
// entier (CHECKOUT_BLOCK_COPY) : aucune commande d'un article inexistant ne
// passe.
//
// Ce module est PUR (aucun import) : il est la source unique des textes de la
// mention, des messages de paiement bloqué, et du bloc de prompt injecté par
// content-truth.ts dans TOUS les chemins de génération.

// ── Ce qui reste interdit, même étiqueté ────────────────────────────────────
// L'étiquette « exemple » n'autorise QUE la structure de l'offre. Elle
// n'autorise jamais un faux avis, un faux label ou une fausse identité : ceux-là
// trompent même accompagnés d'une mention (et restent des infractions).
export const DEMO_NEVER_ALLOWED = [
  "avis, témoignages, notes, étoiles, nombre d'avis",
  "preuve sociale chiffrée (« +10 000 clients », « 4,9/5 », « n°1 »)",
  "logos de clients/partenaires/presse, prix et récompenses",
  "certifications, labels, agréments, assurances",
  "identité et contact (adresse, téléphone, e-mail, horaires, SIRET/TVA, date de création)",
  "équipe (noms, photos, bios)",
  "allégations santé, sécurité, écologie, finance",
  "comparatif avec un concurrent nommé",
  "textes légaux remplis avec des données d'entreprise inventées",
] as const;

// ── Types d'app dont le CŒUR de l'offre ne peut pas être réel sans catalogue ─
// Pour ces produits, si aucun catalogue réel n'est branché, tout ce qui est
// montré (modèles, gammes, prestations, tarifs) est forcément un exemple → la
// mention est OBLIGATOIRE. Un outil/SaaS/tracker, lui, n'invente rien : il
// démarre simplement vide (états vides honnêtes) → pas de mention.
export const DEMO_NOTICE_APP_TYPES: ReadonlySet<string> = new Set([
  "ecommerce",
  "marketplace",
  "brand",
  "configurator",
  "service",
  "dropshipping",
  "shop",
  "store",
]);

/**
 * Velbaz doit-il PRÉVENIR le propriétaire, dans le chat, que le cœur de l'offre
 * a été rempli avec du contenu d'exemple ?
 * (Rien n'est affiché dans le site généré : cf. demoNoticeChatMessage.)
 * Déterministe (aucun appel IA) — c'est volontaire : la mention ne doit pas
 * dépendre de l'humeur du modèle.
 *
 *  • MODE CLONE → jamais (on reproduit un site réel existant).
 *  • Catalogue réel injecté (src/lib/catalog.ts) → jamais : les produits, prix
 *    et photos sont ceux du fournisseur, rien n'est inventé.
 *  • Le plan IA a déclaré `demoContent: true` → toujours (il sait qu'il a dû
 *    remplir l'offre avec des exemples).
 *  • Sinon : dès que le produit VEND quelque chose (type commerce/marque/
 *    service, ou une page de paiement) sans catalogue réel → mention.
 */
export function needsDemoNotice(opts: {
  appType?: string | null;
  hasRealCatalog?: boolean;
  cloneMode?: boolean;
  planDemoContent?: boolean;
  hasPaymentPage?: boolean;
}): boolean {
  if (opts.cloneMode) return false;
  if (opts.hasRealCatalog) return false;
  if (opts.planDemoContent === true) return true;
  const appType = String(opts.appType || "").trim().toLowerCase();
  if (DEMO_NOTICE_APP_TYPES.has(appType)) return true;
  return opts.hasPaymentPage === true;
}

// ── Textes de la mention (FR/EN) ────────────────────────────────────────────
// Ces textes s'adressent au PROPRIÉTAIRE (tutoiement, « depuis Velbaz ») et sont
// dits dans le chat Velbaz — ils ne sont jamais rendus dans le site généré.
export interface DemoNoticeCopy {
  /** Petite étiquette (badge) affichée avant le texte. */
  badge: string;
  /** Phrase principale : ce contenu est un exemple. */
  title: string;
  /** Explication : comment le rendre vrai + pourquoi le paiement est coupé. */
  body: string;
}

const DEMO_NOTICE_FR: DemoNoticeCopy = {
  badge: "Contenu d'exemple",
  title:
    "Les produits, modèles et tarifs affichés sur ce site sont des exemples : ce ne sont pas encore de vraies informations.",
  body:
    "Ils servent à montrer le site en situation. Remplace-les par ton vrai catalogue (produits, prix, photos, disponibilités) depuis Velbaz pour les rendre réels. Tant que ce n'est pas fait, aucun paiement n'est encaissé : le serveur refuse toute commande d'un article qui n'existe pas réellement.",
};

const DEMO_NOTICE_EN: DemoNoticeCopy = {
  badge: "Sample content",
  title:
    "The products, models and prices shown on this site are samples — they are not real information yet.",
  body:
    "They are here to show the site in context. Replace them with your real catalogue (products, prices, photos, availability) from Velbaz to make them real. Until then no payment is ever collected: the server rejects any order for an item that does not really exist.",
};

export function demoNoticeCopy(lang?: string | null): DemoNoticeCopy {
  return String(lang || "fr").toLowerCase().startsWith("en") ? DEMO_NOTICE_EN : DEMO_NOTICE_FR;
}

/**
 * Message DIT DANS LE CHAT VELBAZ (message assistant persistant) quand le cœur
 * de l'offre a dû être rempli avec du contenu d'exemple.
 *
 * [2026-09-25] Demande utilisateur : cette information ne doit PAS être mise
 * dans le site (elle s'adresse au propriétaire, pas à ses visiteurs) — elle doit
 * être dite à l'utilisateur dans le chat de Velbaz. C'est la seule et unique
 * surface où la mention apparaît désormais ; le refus de paiement côté serveur
 * (CHECKOUT_BLOCK_COPY) continue, lui, de protéger les visiteurs.
 */
export function demoNoticeChatMessage(lang?: string | null): string {
  const copy = demoNoticeCopy(lang);
  return `⚠️ ${copy.badge}\n\n${copy.title}\n\n${copy.body}`;
}

// ── Paiement bloqué : messages HONNÊTES au lieu d'une erreur brute ──────────
// Avant : `checkout()` faisait `throw new Error(r.message || r.error)` et la
// plupart des pages générées n'attrapaient rien → clic sur « Acheter » = rien
// qui se passe, ou une erreur rouge incompréhensible. C'est le « Stripe qui
// bugue alors qu'il n'y a rien à vendre » signalé par l'utilisateur.
// Maintenant : chaque code de refus a un message clair, et le client n'explose
// plus (il renvoie { ok: false } + affiche la mention).
export type CheckoutBlockKind =
  /** Rien de réel à vendre derrière ce bouton (contenu d'exemple). */
  | "demo"
  /** Configuration du propriétaire à finir (clés Stripe, prix à corriger). */
  | "config"
  /** Action attendue du visiteur (choisir une option, panier vide). */
  | "cart"
  /** Incident technique (Stripe ou réseau). */
  | "error";

export interface CheckoutBlockCopy {
  kind: CheckoutBlockKind;
  message: string;
}

const NOTHING_CHARGED = "Aucun paiement n'a été effectué.";

/**
 * Table code de refus → message affiché. Les codes viennent de commerce-guard.ts
 * (RÈGLE 1/1bis/2) et de server/stripe.ts du site généré. Sérialisée telle
 * quelle dans le code du site (scaffold) : une seule source de vérité.
 */
export const CHECKOUT_BLOCK_COPY: Readonly<Record<string, CheckoutBlockCopy>> = {
  // — Rien de réel derrière le bouton —
  no_product_reference: {
    kind: "demo",
    message: `Cet article est un exemple de démonstration : il n'existe pas encore dans le catalogue réel, il n'est donc pas en vente. ${NOTHING_CHARGED}`,
  },
  product_not_found: {
    kind: "demo",
    message: `Cet article n'existe pas dans le catalogue réel : il ne peut pas être vendu. ${NOTHING_CHARGED}`,
  },
  product_not_published: {
    kind: "demo",
    message: `Cet article n'est pas encore publié à la vente. ${NOTHING_CHARGED}`,
  },
  product_without_price: {
    kind: "demo",
    message: `Cet article n'a pas encore de prix réel : la vente est désactivée. ${NOTHING_CHARGED}`,
  },
  cart_has_unknown_items: {
    kind: "demo",
    message: `Une partie du panier correspond à du contenu d'exemple, pas à des produits réels : la commande est refusée. ${NOTHING_CHARGED}`,
  },
  catalog_unverifiable: {
    kind: "demo",
    message: `Le catalogue réel n'est pas encore branché sur ce site : la commande ne peut pas être vérifiée, elle est donc refusée. ${NOTHING_CHARGED}`,
  },
  catalog_unreachable: {
    kind: "demo",
    message: `Le catalogue produit est momentanément injoignable : la commande est refusée par précaution. ${NOTHING_CHARGED}`,
  },
  // — Configuration côté propriétaire —
  stripe_not_connected: {
    kind: "config",
    message: `Le paiement est momentanément indisponible sur ce site. ${NOTHING_CHARGED}`,
  },
  price_below_supplier_cost: {
    kind: "config",
    message: `Le prix affiché est inférieur au coût fournisseur : la vente est bloquée le temps de corriger le prix. ${NOTHING_CHARGED}`,
  },
  price_changed: {
    kind: "config",
    message: `Le prix de cet article vient d'être mis à jour : recharge la page pour voir le bon prix avant de payer. ${NOTHING_CHARGED}`,
  },
  plan_without_price: {
    kind: "config",
    message: `Cet abonnement n'a pas encore de montant réel : la souscription est désactivée. ${NOTHING_CHARGED}`,
  },
  // — Action du visiteur —
  no_items: {
    kind: "cart",
    message: "Le panier est vide : il n'y a rien à payer.",
  },
  variant_required: {
    kind: "cart",
    message: "Choisis une option (taille, couleur, modèle) avant de continuer.",
  },
  variant_not_found: {
    kind: "cart",
    message: "L'option choisie n'est plus disponible : sélectionne-en une autre.",
  },
  // — Incident technique —
  stripe_error: {
    kind: "error",
    message: `Le paiement n'a pas pu démarrer (erreur du prestataire de paiement). ${NOTHING_CHARGED}`,
  },
};

export const CHECKOUT_BLOCK_FALLBACK: CheckoutBlockCopy = {
  kind: "error",
  message: `Le paiement n'a pas pu démarrer. ${NOTHING_CHARGED}`,
};

/**
 * Message à afficher pour un refus de paiement. `serverMessage` (message exact
 * renvoyé par le garde-fou) est privilégié quand il existe : il est déjà écrit
 * pour un humain et peut nommer le produit concerné.
 */
export function checkoutBlockCopy(
  code?: string | null,
  serverMessage?: string | null,
): CheckoutBlockCopy {
  const known = code ? CHECKOUT_BLOCK_COPY[String(code)] : undefined;
  const base = known || CHECKOUT_BLOCK_FALLBACK;
  const msg = String(serverMessage || "").trim();
  // Un message serveur utile remplace le texte générique, mais on garde le
  // « aucun paiement effectué » qui rassure et évite le double clic.
  if (msg && msg.length > 8 && base.kind !== "cart") {
    return { kind: base.kind, message: msg.includes("aucun paiement") || msg.includes("Aucun paiement") ? msg : `${msg} ${NOTHING_CHARGED}` };
  }
  return base;
}

// ── Bloc de prompt injecté partout (via content-truth.ts) ───────────────────
export const DEMO_CONTENT_RULE = `
4. CONTENU D'EXEMPLE ASSUMÉ — LA 4ᵉ OPTION (quand le CŒUR de l'offre ne peut pas encore être réel):
   Certaines entreprises ne PEUVENT pas avoir de données réelles au moment de la génération: concessionnaire automobile, courtier en avions/bateaux, immobilier, machines industrielles, restaurant sans carte fournie, etc. Supprimer le catalogue reviendrait à livrer un site vide: c'est un échec. Tu GÉNÈRES donc quand même l'offre (modèles de voitures, appareils, prestations, gammes) — mais ÉTIQUETÉE comme exemple, jamais présentée comme un fait établi.
   Conditions CUMULATIVES, aucune n'est optionnelle:
   a) Chaque élément d'exemple est reconnaissable comme tel: un badge/tag visible « Exemple » (ou « Sample » en anglais) sur la carte/fiche, et un champ \`isSample: true\` dans l'objet de données. Aucune donnée d'exemple ne se fait passer pour une donnée vérifiée.
   b) Les données d'exemple restent PLAUSIBLES ET NEUTRES: un nom de modèle, une catégorie, une description de ce que ça fait. Un prix d'exemple est toléré UNIQUEMENT s'il est affiché comme indicatif (« à titre d'exemple », « prix indicatif à définir »). Tu n'écris jamais une caractéristique technique chiffrée, une autonomie, une conso, une norme ni une homologation que le brief ne donne pas.
   c) N'AJOUTE AUCUN BANDEAU / AUCUNE MENTION GLOBALE « contenu d'exemple » dans le site (ni sous le footer, ni en haut de page, ni dans un encart): c'est Velbaz qui prévient le propriétaire directement dans le chat. Le site, lui, reste propre: seuls les badges « Exemple » sur les éléments concernés (point a) sont visibles. En échange tu ne contredis jamais cette réalité: aucune phrase du type « tous nos modèles sont disponibles en stock », « livré en 48 h », « déjà 500 clients ».
   d) AUCUN PAIEMENT SUR UN CONTENU D'EXEMPLE. Pas de bouton « Acheter »/« Payer »/panier branché sur un élément d'exemple: le serveur refuse (409) et le visiteur se retrouve devant un bouton mort. À la place, un CTA RÉEL et utile qui persiste vraiment: « Demander un devis », « Réserver un essai », « Être prévenu » (data.create sur une collection réelle + confirmation honnête). Un bouton d'achat n'existe QUE pour un produit du catalogue réel (src/lib/catalog.ts) avec son \`productId\`.
   e) Ça ne débloque RIEN d'autre: ${DEMO_NEVER_ALLOWED.join(" ; ")} restent INTERDITS même avec une étiquette « exemple » — une fausse preuve trompe le client même annoncée.
   Autrement dit: on ne livre jamais un site vide, et on ne fait jamais passer un exemple pour un fait. Générer + étiqueter + ne rien encaisser.`;

export const DEMO_CONTENT_RULE_SHORT = `
- CONTENU D'EXEMPLE ASSUMÉ (4ᵉ option): si le cœur de l'offre ne peut PAS être réel maintenant (concession auto, avions, immobilier, machines, carte de restaurant non fournie…), NE supprime PAS le catalogue (Boutique / Modèles / Menu) — prévois-le avec des éléments d'EXEMPLE explicitement étiquetés (badge « Exemple » + champ \`isSample: true\`), des prix seulement indicatifs, et un CTA réel qui persiste (devis, essai, alerte) à la place de tout bouton d'achat. N'ajoute AUCUN bandeau ni mention globale « contenu d'exemple » dans le site (le propriétaire en est prévenu dans le chat Velbaz, pas ses visiteurs) — seuls les badges « Exemple » sur les éléments concernés sont visibles, et aucune phrase ne doit contredire ça (« en stock », « livré en 48 h »). Cela ne rend PAS acceptables les faux avis, labels, chiffres de preuve sociale ou coordonnées: ceux-là restent interdits, étiquetés ou non.`;
