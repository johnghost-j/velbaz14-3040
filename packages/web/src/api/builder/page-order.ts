/**
 * [2026-10-04] Ordre des pages + page d'accueil + « Showroom » — règles
 * DÉTERMINISTES appliquées au plan de pages (questionnaire ET build).
 *
 * Bugs réels (base, 2026-10-04) :
 *  - PasStride, Denimora, Paselle : « Showroom » servi sur "/" → la page
 *    d'accueil du site était une grille de catalogue, pas un accueil.
 *  - Paséo : aucune page sur "/" ; `ensureHomeRoute` a pris la 1ʳᵉ page
 *    statique… « Contact ». Contact devenait l'accueil ET la 1ʳᵉ entrée de nav.
 *  - MailFlow : « Contact » placé AVANT « Accueil » dans la nav.
 * Causes : le prompt de plan imposait « Showroom = page principale (/) » pour
 * toute marque/boutique, et le questionnaire renvoyait les pages sans leur
 * route (voir PagePlanTool / chat.tsx) avec les pages « standard » en tête.
 *
 * Demande utilisateur : l'IA ne propose JAMAIS de page « Showroom » d'elle-
 * même — seulement si la personne la demande ou l'ajoute. Et l'accueil est
 * toujours un vrai accueil, suivi d'un ordre logique.
 */

export interface PlanPageLike {
  name: string;
  file: string;
  route: string;
  purpose?: string;
  sections?: string;
  isCore?: boolean;
  hasForm?: boolean;
  hasPayment?: boolean;
  navOrder?: number;
  showInNav?: boolean;
}

/** Texte normalisé (minuscules, sans accents) d'une page : nom + route. */
function key(p: { name: string; route: string; file?: string }): string {
  return deaccent(`${p.name} ${p.route.replace(/[/:-]+/g, " ")}`).toLowerCase();
}

export function deaccent(s: string): string {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Slug de route sans accents : « Détail du modèle » → "detail-du-modele"
 *  (avant : "d-tail-du-mod-le", vu en base sur Paséo). */
export function routeSlug(s: string): string {
  return deaccent(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
}

export const SHOWROOM_RE = /show[\s_-]?room/i;

/** L'utilisateur a-t-il lui-même parlé d'un showroom ? */
export function userAskedForShowroom(requestText: string): boolean {
  return SHOWROOM_RE.test(requestText || "");
}

const HOME_NAME_RE = /^(accueil|home|homepage|home page|index|landing|bienvenue|welcome|start|inicio|startseite|начало)$/i;
const CATALOG_RE = /^(boutique|la boutique|e-?shop|shop|shop all|store|catalogue|catalog|collections?|nos collections|produits|products|nos produits|tous les produits|gamme|la gamme|notre gamme|modeles|nos modeles|models|tienda|winkel|negozio|showroom|show room)$/;

function isShowroomPage(p: { name: string; route: string; file?: string }): boolean {
  return SHOWROOM_RE.test(`${p.name} ${p.route} ${p.file || ""}`);
}

function isCatalogPage(p: { name: string; route: string }): boolean {
  const n = deaccent(p.name).toLowerCase().trim();
  const r = deaccent(p.route).toLowerCase().replace(/^\/+|\/+$/g, "").replace(/-/g, " ");
  return CATALOG_RE.test(n) || (!!r && !r.includes(":") && CATALOG_RE.test(r));
}

function isHomeNamed(p: { name: string; route: string }): boolean {
  return HOME_NAME_RE.test(p.name.trim()) || HOME_NAME_RE.test(p.route.replace(/^\/+|\/+$/g, ""));
}

/** Types de plan « site » (marque, boutique, service) : la racine y est un
 *  ACCUEIL. Les logiciels (saas, tool…) gardent leur espace de travail sur "/". */
const SITE_APP_TYPES = new Set(["ecommerce", "brand", "configurator", "service"]);
export function isSiteAppType(appType?: string): boolean {
  return SITE_APP_TYPES.has(String(appType || "").toLowerCase().trim());
}

const VEHICLE_RE = /\b(voitures?|autos?|automobiles?|motos?|scooters?|v[ée]hicules?|cars?|bikes?|v[ée]los?|bateaux?|boats?|yachts?|avions?|jets?|camions?|trucks?)\b/i;

type Lang = "fr" | "en" | "nl" | "de" | "es" | "it";
function lang2(lang?: string): Lang {
  const l = String(lang || "").toLowerCase().slice(0, 2);
  return (["fr", "en", "nl", "de", "es", "it"] as const).includes(l as Lang) ? (l as Lang) : "en";
}

const HOME_LABEL: Record<Lang, string> = { fr: "Accueil", en: "Home", nl: "Home", de: "Startseite", es: "Inicio", it: "Home" };
const SHOP_LABEL: Record<Lang, string> = { fr: "Boutique", en: "Shop", nl: "Winkel", de: "Shop", es: "Tienda", it: "Negozio" };
const MODELS_LABEL: Record<Lang, string> = { fr: "Modèles", en: "Models", nl: "Modellen", de: "Modelle", es: "Modelos", it: "Modelli" };
/** Mot neutre qui remplace « showroom » dans les descriptions (« le showroom »
 *  → « le catalogue » reste grammatical en français). */
const CATALOG_WORD: Record<Lang, string> = { fr: "catalogue", en: "catalogue", nl: "catalogus", de: "Katalog", es: "catálogo", it: "catalogo" };

function catalogLabel(lang: Lang, context: string): string {
  return VEHICLE_RE.test(context) ? MODELS_LABEL[lang] : SHOP_LABEL[lang];
}

function fileFor(name: string, taken: Set<string>): string {
  const base = deaccent(name).replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).map(w => w[0]!.toUpperCase() + w.slice(1)).join("") || "Page";
  let f = `${base}.tsx`;
  for (let i = 2; taken.has(f.toLowerCase()); i++) f = `${base}${i}.tsx`;
  return f;
}

function freeRoute(wanted: string, taken: Set<string>): string {
  let r = wanted;
  for (let i = 2; taken.has(r); i++) r = `${wanted}-${i}`;
  return r;
}

/**
 * Retire le « Showroom » que l'IA a proposé d'elle-même (la personne n'a pas
 * prononcé le mot). La page devient la page catalogue (« Boutique », ou
 * « Modèles » pour des véhicules) — sauf si une page catalogue existe déjà,
 * auquel cas elle est supprimée (doublon). Si elle était sur "/", elle quitte
 * la racine : `ensureRealHome` y mettra un vrai accueil.
 */
export function removeUnrequestedShowroom<P extends PlanPageLike>(
  pages: P[],
  requestText: string,
  lang?: string,
): { pages: P[]; changes: string[] } {
  if (userAskedForShowroom(requestText) || !pages.some(isShowroomPage)) {
    return { pages, changes: [] };
  }
  const L = lang2(lang);
  const word = CATALOG_WORD[L];
  const label = catalogLabel(L, requestText);
  const changes: string[] = [];
  const hasOtherCatalog = pages.some(p => !isShowroomPage(p) && isCatalogPage(p));
  const routes = new Set(pages.filter(p => !isShowroomPage(p)).map(p => p.route));
  const files = new Set(pages.filter(p => !isShowroomPage(p)).map(p => p.file.toLowerCase()));
  const out: P[] = [];
  let converted = false;
  for (const p of pages) {
    if (!isShowroomPage(p)) { out.push(p); continue; }
    if (hasOtherCatalog || converted) {
      changes.push(`« ${p.name} » supprimée (doublon du catalogue, non demandée)`);
      continue;
    }
    const detail = p.route.includes(":");
    const route = detail ? p.route.replace(SHOWROOM_RE, routeSlug(label)) : freeRoute(`/${routeSlug(label)}`, routes);
    const file = fileFor(label, files);
    routes.add(route);
    files.add(file.toLowerCase());
    out.push({ ...p, name: label, file, route });
    converted = !detail;
    changes.push(`« ${p.name} » (${p.route}) → « ${label} » (${route})`);
  }
  // Le mot ne doit plus apparaître dans les descriptions des autres pages non
  // plus (« depuis le showroom »), sinon le générateur le recopie à l'écran.
  const scrub = (s?: string) => (s ? s.replace(new RegExp(SHOWROOM_RE.source, "gi"), word) : s);
  return {
    pages: out.map(p => ({ ...p, purpose: scrub(p.purpose), sections: scrub(p.sections) })),
    changes,
  };
}

function homePage(L: Lang, appType: string, catalogRoute: string | null, file: string): PlanPageLike {
  const service = String(appType).toLowerCase() === "service";
  const toCatalog = catalogRoute ? ` vers ${catalogRoute}` : "";
  return {
    name: HOME_LABEL[L],
    file,
    route: "/",
    purpose: L === "fr"
      ? (service ? "Accueil : ce que vous proposez, pour qui, et prise de rendez-vous." : "Accueil : présenter la marque et mettre en avant les produits phares.")
      : (service ? "Home: what you offer, who it is for, and how to book." : "Home: introduce the brand and highlight best-selling products."),
    sections: service
      ? `VRAI ACCUEIL (pas une liste brute) : HERO (ce que fait l'entreprise, pour qui, CTA principal « Prendre rendez-vous »${toCatalog ? "" : ""}) ; 3 à 6 prestations phares avec prix de départ, chacune liée à sa page ; « comment ça se passe » en 3 étapes ; infos pratiques (adresse, horaires, zone desservie) UNIQUEMENT si elles sont fournies ; CTA final. États chargement/vide sur toute liste lue via data.list.`
      : `VRAI ACCUEIL (pas une grille de catalogue) : HERO (accroche de la marque + CTA « Découvrir la boutique »${toCatalog}) ; sélection de 4 à 8 produits phares lus via data.list (skeleton + état vide), chaque carte mène à sa fiche produit ; accès rapide aux catégories/collections ; bandeau d'arguments VRAIS uniquement (livraison, retours, paiement sécurisé — rien d'inventé) ; court bloc histoire/valeurs de la marque ; CTA final vers la boutique.`,
    isCore: true,
    hasForm: false,
    hasPayment: false,
    navOrder: 1,
    showInNav: true,
  };
}

/**
 * Garantit un VRAI accueil sur "/" pour les sites (marque, boutique, service) :
 *  - une page catalogue/showroom sur "/" est déplacée sur sa propre route ;
 *  - une page nommée « Accueil/Home » ailleurs est remise sur "/" ;
 *  - sinon une page Accueil est AJOUTÉE (jamais « Contact » ou « Panier »).
 * Pour les logiciels (saas, outil…), seul le cas « aucune page sur "/" » est
 * traité, comme avant (`fallback`).
 */
export function ensureRealHome<P extends PlanPageLike>(
  pages: P[],
  appType: string | undefined,
  lang: string | undefined,
  fallback: (pages: P[]) => P[],
): { pages: P[]; changes: string[] } {
  if (!pages.length) return { pages, changes: [] };
  const site = isSiteAppType(appType);
  const rootIdx = pages.findIndex(p => p.route === "/");
  const root = rootIdx >= 0 ? pages[rootIdx]! : null;
  const rootIsCatalog = !!root && (isShowroomPage(root) || (site && isCatalogPage(root)));
  if (root && !rootIsCatalog) return { pages, changes: [] };
  if (!root && !site) return { pages: fallback(pages), changes: [] };

  const changes: string[] = [];
  const L = lang2(lang);
  const routes = new Set(pages.map(p => p.route));
  let out = pages.slice();
  let catalogRoute: string | null = null;
  if (root && rootIsCatalog) {
    const route = freeRoute(`/${routeSlug(root.name)}`, routes);
    routes.add(route);
    catalogRoute = route;
    out[rootIdx] = { ...root, route, navOrder: undefined };
    changes.push(`« ${root.name} » quitte "/" → ${route} (une page catalogue n'est pas un accueil)`);
  } else {
    catalogRoute = out.find(p => isCatalogPage(p))?.route ?? null;
  }
  const namedIdx = out.findIndex(p => p.route !== "/" && !p.route.includes(":") && isHomeNamed(p));
  if (namedIdx >= 0) {
    const n = out[namedIdx]!;
    out[namedIdx] = { ...n, route: "/", isCore: true, showInNav: true };
    changes.push(`« ${n.name} » (${n.route}) remise sur "/"`);
  } else {
    const files = new Set(out.map(p => p.file.toLowerCase()));
    const file = fileFor(files.has("home.tsx") ? "HomePage" : "Home", files);
    out = [homePage(L, String(appType || ""), catalogRoute, file) as P, ...out];
    changes.push(`page « ${HOME_LABEL[L]} » ajoutée sur "/"`);
  }
  return { pages: out, changes };
}

/**
 * Rang LOGIQUE d'une page dans le parcours (et donc dans la nav) :
 * 0 accueil · 1 contenu principal (boutique, menu, prestations, espace de
 * travail…) · 2 fiches détail + tunnel (panier, commande…) · 3 tarifs ·
 * 4 à propos · 5 journal/blog · 6 contact/FAQ/points de vente · 7 légal.
 * Constat sur les sites étudiés : « À propos » et « Contact » ferment la nav,
 * le catalogue (ou le menu, ou les prestations) l'ouvre juste après l'accueil.
 */
export function pageRank(p: { name: string; route: string }): number {
  if (p.route === "/") return 0;
  const k = key(p);
  if (/\b(mentions|legal|cgv|cgu|conditions|confidentialite|privacy|terms|cookies)\b/.test(k)) return 7;
  if (/\b(contact|contactez|faq|questions|support|aide|help|points? de vente|magasins|store locator|nous trouver|acces|plan d acces|infos pratiques)\b/.test(k)) return 6;
  if (p.route.includes(":") || /\b(detail|fiche|panier|cart|bag|checkout|commande|paiement|payment|confirmation|merci|thank|wishlist|favoris|ma selection|suivi)\b/.test(k)) return 2;
  if (/\b(a propos|about|notre histoire|histoire|story|qui sommes nous|equipe|team|mission|savoir faire|manifeste|valeurs|engagements)\b/.test(k)) return 4;
  if (/\b(blog|journal|actualites?|news|magazine|articles?|presse)\b/.test(k)) return 5;
  if (/\b(tarifs?|pricing|prices|plans|abonnements?|subscriptions?|billing|facturation)\b/.test(k)) return 3;
  return 1;
}

/** Valeur par défaut de showInNav quand l'IA ne l'a pas donnée. */
export function defaultShowInNav(p: { name: string; route: string }): boolean {
  if (p.route === "/") return true;
  const r = pageRank(p);
  return r !== 2 && r !== 7 && !/\b(billing|facturation)\b/.test(key(p));
}

/** Tri stable : rang logique d'abord, puis navOrder de l'IA, puis ordre d'origine. */
export function sortPagesLogically<P extends PlanPageLike>(pages: P[]): P[] {
  return pages
    .map((p, i) => ({ p, i, r: pageRank(p) }))
    .sort((a, b) => {
      if (a.r !== b.r) return a.r - b.r;
      const ao = typeof a.p.navOrder === "number" ? a.p.navOrder : 1e9;
      const bo = typeof b.p.navOrder === "number" ? b.p.navOrder : 1e9;
      if (ao !== bo) return ao - bo;
      return a.i - b.i;
    })
    .map(x => x.p);
}

/**
 * [2026-10-03] Garantit qu'UNE page est servie sur "/". Le planificateur rend
 * parfois l'accueil sur "/accueil" (ou "/home") sans aucune route "/" : le
 * logo, « Retour à l'accueil » et la racine du site menaient alors à la page
 * 404 — sur CHAQUE page.
 * Choix : la page dont le nom/la route dit « accueil » ; sinon la première
 * page de CONTENU (jamais Contact, Panier, À propos ou une page légale quand
 * une autre page existe — cas Paséo du 2026-10-04) ; sinon la première page
 * statique. Le fichier ne change pas, seule sa route devient "/".
 */
export function ensureHomeRoute<P extends { name: string; route: string }>(pages: P[]): P[] {
  if (!pages.length || pages.some(p => p.route === "/")) return pages;
  let pick = pages.findIndex(p => !p.route.includes(":") && isHomeNamed(p));
  if (pick < 0) pick = pages.findIndex(p => !p.route.includes(":") && pageRank(p) === 1);
  if (pick < 0) pick = pages.findIndex(p => !p.route.includes(":"));
  if (pick < 0) return pages;
  return pages.map((p, i) => (i === pick ? { ...p, route: "/" } : p));
}

/**
 * Passe finale sur la liste de pages d'un plan (questionnaire ET build) :
 *  1. retire le « Showroom » non demandé (si `stripShowroom`) ;
 *  2. garantit un vrai accueil sur "/" ;
 *  3. complète showInNav et trie dans l'ordre logique.
 * `keepOrder` (mode clone) : l'ordre du site source fait foi — seule la
 * présence d'une page sur "/" est garantie.
 */
export function finalizePlanPages<P extends PlanPageLike>(
  pages: P[],
  o: { appType?: string; lang?: string; requestText?: string; stripShowroom?: boolean; keepOrder?: boolean },
): { pages: P[]; changes: string[] } {
  const changes: string[] = [];
  let out = pages;
  if (o.keepOrder) {
    out = ensureHomeRoute(out);
  } else {
    if (o.stripShowroom) {
      const s = removeUnrequestedShowroom(out, o.requestText || "", o.lang);
      out = s.pages;
      changes.push(...s.changes);
    }
    const h = ensureRealHome(out, o.appType, o.lang, ensureHomeRoute);
    out = h.pages;
    changes.push(...h.changes);
  }
  out = out.map(p => ({
    ...p,
    showInNav: p.route === "/" ? true : typeof p.showInNav === "boolean" ? p.showInNav : defaultShowInNav(p),
  }));
  if (o.keepOrder) {
    // Comportement historique : "/" d'abord, puis navOrder, puis ordre d'origine.
    out = out
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        if ((a.p.route === "/") !== (b.p.route === "/")) return a.p.route === "/" ? -1 : 1;
        const ao = typeof a.p.navOrder === "number" ? a.p.navOrder : 1e9;
        const bo = typeof b.p.navOrder === "number" ? b.p.navOrder : 1e9;
        return ao !== bo ? ao - bo : a.i - b.i;
      })
      .map(x => x.p);
  } else {
    out = sortPagesLogically(out);
  }
  return { pages: out, changes };
}
