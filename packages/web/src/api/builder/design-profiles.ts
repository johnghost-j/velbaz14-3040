// ─── Profils de design « étudiés sur de vrais sites » ────────────────────────
// Constat (même logique que anti-ai-smell.ts, mais au-delà de la couleur):
// laissée seule, l'IA de génération de design system converge vers un petit
// nombre de choix par défaut — Inter/Plus Jakarta Sans/Poppins/Sora/Manrope
// pour la police (elle-même suggérée en exemple dans DESIGN_SYSTEM_PROMPT),
// un radius ~0.75rem partout, un hero centré + 3 cartes en grille, et des
// photos de stock génériques. Le résultat : deux sites d'industries
// différentes « sentent » la même IA dès qu'on regarde la mise en page.
//
// Ce module fournit un POOL de profils de design DÉTERMINISTES (même logique
// que HUMAN_PALETTES: un hash stable du projet choisit un profil, donc deux
// builds du même projet restent identiques, mais deux projets différents
// divergent réellement). Chaque profil n'est pas une invention abstraite: il
// est distillé de l'étude d'un vrai site connu pour la qualité de son design
// (Stripe, Linear, Apple, Airbnb, Vercel/Geist, Notion, Figma, Framer, Arc,
// Attio, Mercury, Cash App, Duolingo, Nike, Aesop, Muji, Chanel, Tesla,
// Compass, Calm, agences primées type Instrument/Pentagram/MetaLab…) — la
// référence figure en commentaire pour la traçabilité, jamais recopiée comme
// nom de marque dans le produit généré.
//
// Chaque profil couvre les 5 axes demandés: mise en page (hero/sections/
// grilles), typographie, boutons, rayon de bordure, style photo — sous forme
// d'un texte de consigne (`layoutNotes`) injecté dans `designNotes`, qui
// alimente déjà tous les prompts de génération de page (voir engine.ts
// `baseVctx.designNotes` et prompts.ts). Police et radius sont en plus
// appliqués DIRECTEMENT sur les champs `font`/`radius` du design system,
// exactement comme deAiPalette applique `colors`.

/** Polices Google Fonts surexploitées par les générateurs IA — signal de
 *  convergence, au même titre que le violet/cyan pour les couleurs. */
const AI_SIGNATURE_FONTS = [
  "inter", "plus jakarta sans", "poppins", "space grotesk", "sora",
  "manrope", "dm sans", "outfit", "nunito sans", "nunito", "roboto",
  "montserrat", "open sans", "lato",
];

export function isAiSignatureFont(font: string | undefined | null): boolean {
  if (!font || typeof font !== "string") return true; // pas de police = à remplacer
  return AI_SIGNATURE_FONTS.includes(font.trim().toLowerCase());
}

export interface DesignProfile {
  name: string;
  /** Site réel étudié pour ce profil — traçabilité interne, jamais affiché
   *  comme nom de marque dans le produit généré. */
  reference: string;
  tone: "light" | "dark" | "any";
  /** Mots-clés de secteur pour lesquels ce profil est particulièrement juste. */
  sectors: string[];
  /** Police Google Fonts unique (titres + corps — une seule famille, cf. CODE_SYSTEM). */
  font: string;
  /** Rayon de bordure CSS de référence pour ce profil. */
  radius: string;
  /** Consigne de mise en page / boutons / photo injectée dans designNotes. */
  layoutNotes: string;
}

export const DESIGN_PROFILES: DesignProfile[] = [
  {
    name: "Éditorial Encre",
    reference: "Stripe.com (structure), Linear.app (densité typographique)",
    tone: "light",
    sectors: ["b2b", "saas", "conseil", "finance", "logiciel", "startup", "tech"],
    font: "Bricolage Grotesque",
    radius: "0.5rem",
    layoutNotes: "MISE EN PAGE (étudiée sur Stripe/Linear): hero asymétrique — titre + sous-titre + CTA alignés à gauche sur 55-60% de largeur, illustration/mockup produit à droite qui déborde légèrement du cadre. Sections en alternance texte-gauche/visuel-droite puis inversé. Grille de features en 3 colonnes avec icône fine + titre + 1 phrase, PAS de carte avec bordure pleine — juste un léger séparateur vertical entre colonnes. BOUTONS: rectangle à coins légèrement arrondis (rayon 0.5rem), hauteur 40-44px, CTA principal plein-encre avec hover qui éclaircit d'une nuance, jamais de bouton pill. PHOTO: aucune photo de stock — uniquement des captures d'écran produit réalistes ou des illustrations vectorielles géométriques simples, jamais de visage souriant générique.",
  },
  {
    name: "Studio Silence",
    reference: "Apple.com (storytelling produit), Aesop.com (retenue chromatique)",
    tone: "light",
    sectors: ["luxe", "beauté", "mode", "cosmétique", "parfum", "joaillerie", "horlogerie"],
    font: "Fraunces",
    radius: "0",
    layoutNotes: "MISE EN PAGE (étudiée sur Apple/Aesop): hero plein cadre avec UNE photo produit très grande (déborde du viewport en bas), texte minimal centré au-dessus (1 titre court, pas de paragraphe). Sections en scrollytelling strict: image plein cadre puis bloc de texte seul sur fond uni, en alternance, jamais les deux en même temps sur une section. Aucune grille de cartes — la narration est linéaire, section par section. BOUTONS: rectangle à angles DROITS (rayon 0), fine bordure 1px, texte en petites capitales espacées, jamais de fond plein sauf le CTA final. PHOTO: photographie produit soignée, fond neutre ou nature morte, lumière douce, JAMAIS de stock photo de personnes souriantes — le produit est le sujet, pas un mannequin générique.",
  },
  {
    name: "Terminal Sombre",
    reference: "Linear.app (dark mode), Vercel/Geist (densité outil)",
    tone: "dark",
    sectors: ["developer", "devops", "ia", "data", "cybersécurité", "infrastructure", "no-code"],
    font: "Geist",
    radius: "0.375rem",
    layoutNotes: "MISE EN PAGE (étudiée sur Linear/Vercel): hero avec mesh gradient très subtil derrière un titre serré (tracking négatif) + capture d'écran produit en mode sombre flottante avec ombre discrète. Sections denses: grille de features SERRÉE (gap 12-16px), cartes avec bordure translucide fine (border-white/10), fond légèrement plus clair que le fond de page — jamais d'ombre portée visible en sombre. BOUTONS: rectangle rayon modéré (0.375rem), hauteur 36-40px, bordure au repos + fond plein au hover pour le CTA secondaire, CTA principal en accent plein. PHOTO: aucune photo — uniquement captures d'écran produit réelles, diagrammes techniques, ou icônes ligne fine monochromes.",
  },
  {
    name: "Argile & Papier",
    reference: "Notion.so (chaleur éditoriale), Muji.com (minimalisme fonctionnel)",
    tone: "light",
    sectors: ["éducation", "productivité", "coaching", "organisation", "communauté", "association"],
    font: "Newsreader",
    radius: "0.75rem",
    layoutNotes: "MISE EN PAGE (étudiée sur Notion/Muji): hero avec titre en grande serif éditoriale sur fond crème texturé, illustration simple à côté (pas de mockup complexe). Sections organisées en blocs de texte COURTS avec beaucoup de blanc, grille 2 colonnes maximum (jamais 3-4 cartes serrées) pour garder un rythme de lecture posé. BOUTONS: rectangle coins doux (0.75rem), remplissage encre chaude, texte en poids normal (pas de majuscules). PHOTO: photographie documentaire chaleureuse (mains, objets du quotidien, lumière naturelle), jamais de photo corporate posée.",
  },
  {
    name: "Béton Brut",
    reference: "Airbnb.com (grille carte), sites d'agence type Instrument (typographie XL)",
    tone: "light",
    sectors: ["immobilier", "architecture", "construction", "urbanisme", "décoration", "aménagement"],
    font: "Archivo",
    radius: "1rem",
    layoutNotes: "MISE EN PAGE (étudiée sur Airbnb + agences primées): hero avec titre TRÈS grand (clamp 3rem-6rem) en gras, photo plein cadre en arrière-plan avec voile sombre léger pour la lisibilité. Grille de cartes façon Airbnb: image en haut ratio 4:3 avec coins arrondis SUR L'IMAGE ELLE-MÊME (1rem), contenu dessous, survol = léger zoom image uniquement (scale-105). Gap constant 20-24px entre cartes, hauteurs alignées. BOUTONS: rectangle arrondi généreux (1rem), CTA plein avec ombre douce discrète. PHOTO: photographie architecturale/intérieur réelle, cadrage large, lumière naturelle — jamais de rendu 3D générique ni de stock impersonnel.",
  },
  {
    name: "Néon Contrôle",
    reference: "Cash App / Robinhood (fintech grand public), Duolingo (ludique)",
    tone: "dark",
    sectors: ["fintech", "banque", "crypto", "investissement", "paiement", "trading"],
    font: "Unbounded",
    radius: "1.5rem",
    layoutNotes: "MISE EN PAGE (étudiée sur Cash App/Robinhood): hero avec fond sombre profond + UNE forme colorée organique (blob flou) très saturée en accent, titre très gras et court, mockup app mobile flottant légèrement incliné. Sections avec grosses formes arrondies en fond de bloc (pas de rectangles nets), grille 2 colonnes pour les features avec icône dans un cercle coloré plein. BOUTONS: pill complet (rayon 1.5rem/9999px), très épais (48-52px de hauteur), couleur saturée franche, texte en gras. PHOTO: aucune photo — uniquement mockups d'app, formes géométriques pleines couleurs, illustrations flat très saturées.",
  },
  {
    name: "Cabinet Feutré",
    reference: "Cabinets d'avocats/conseil haut de gamme (typographie serif, sobriété)",
    tone: "light",
    sectors: ["avocat", "juridique", "notaire", "cabinet", "audit", "assurance", "patrimoine"],
    font: "Libre Franklin",
    radius: "0.25rem",
    layoutNotes: "MISE EN PAGE: hero sobre, fond uni encre profonde ou crème, titre serré en 2 lignes maximum, aucune illustration décorative — juste le texte et un CTA. Sections en 2 colonnes texte/chiffres-clés, jamais de grille de 6+ cartes colorées. Bordures fines partout, séparateurs horizontaux discrets entre sections plutôt que des fonds contrastés. BOUTONS: rectangle presque droit (0.25rem), bordure fine au repos, fond plein uniquement pour LE seul CTA principal de la page. PHOTO: photographie institutionnelle sobre en noir et blanc ou désaturée, jamais de photo de stock souriante 'business team high five'.",
  },
  {
    name: "Serre Vivante",
    reference: "Marques bio/nutrition à l'esthétique naturelle (type Oatly, Innocent)",
    tone: "light",
    sectors: ["alimentaire", "bio", "nutrition", "agriculture", "jardin", "écologie", "durable"],
    font: "Epilogue",
    radius: "1.25rem",
    layoutNotes: "MISE EN PAGE: hero avec forme organique découpée (pas un rectangle net) contenant la photo produit, titre manuscrit-like en très grand à côté. Sections avec fonds pastel doux en blocs arrondis, grille de cartes à coins très arrondis (1.25rem) façon galets. BOUTONS: pill arrondi, fond plein coloré franc, icône + texte. PHOTO: photographie naturelle lumineuse, produits en situation réelle (cuisine, jardin, marché), couleurs chaudes et vraies — jamais de rendu studio froid.",
  },
  {
    name: "Passerelle Claire",
    reference: "Compass.com / Zillow (immobilier orienté données), Mercury.com (fintech pro épuré)",
    tone: "light",
    sectors: ["immobilier", "agence", "location", "courtage", "gestion locative"],
    font: "Public Sans",
    radius: "0.625rem",
    layoutNotes: "MISE EN PAGE: hero avec barre de recherche/filtre proéminente sous le titre (pattern 'outil' plutôt que 'brochure'), photo de bien en grand à droite. Grille de cartes bien annonces: photo 4:3, prix en évidence en gras, méta-infos en ligne (surface, pièces) avec icônes fines. Sections outil (filtres, carte) séparées des sections marketing par un changement de fond net. BOUTONS: rectangle coins moyens (0.625rem), CTA plein, boutons secondaires en contour fin. PHOTO: photographie immobilière professionnelle réelle, lumière naturelle, jamais de rendu 3D ni de placeholder gris.",
  },
  {
    name: "Papier Journal",
    reference: "Sites de presse/édition premium (grille éditoriale dense, hiérarchie typographique)",
    tone: "light",
    sectors: ["presse", "édition", "média", "blog", "magazine", "contenu"],
    font: "Spectral",
    radius: "0",
    layoutNotes: "MISE EN PAGE: hero façon 'une de journal' — gros titre serif, chapeau court au-dessus, image d'illustration en bandeau plutôt qu'un hero plein écran. Grille d'articles en colonnes inégales (un article vedette large + une colonne d'articles secondaires plus petits), séparateurs horizontaux fins entre blocs plutôt que des cartes avec ombre. BOUTONS: texte souligné ou rectangle net (rayon 0) sans remplissage sauf CTA d'abonnement. PHOTO: photographie éditoriale/reportage, cadrages variés (pas tous 4:3 identiques), légendes visibles sous chaque image.",
  },
  {
    name: "Atelier Chaud",
    reference: "Sites d'artisans/agences créatives (typographie display, textures)",
    tone: "light",
    sectors: ["artisanat", "restauration", "traiteur", "boulangerie", "café", "brasserie"],
    font: "Cormorant",
    radius: "0.875rem",
    layoutNotes: "MISE EN PAGE: hero avec photo plein cadre du produit/plat en gros plan, titre serif italique élégant superposé avec léger voile. Sections en alternance photo pleine largeur / bloc menu-texte, grille de plats en cartes à coins arrondis moyens avec photo carrée. BOUTONS: rectangle arrondi (0.875rem), fond encre chaude ou terracotta, texte en petites capitales. PHOTO: photographie culinaire chaleureuse, lumière naturelle rasante, gros plans texturés — jamais de photo de stock de plat générique trop lisse.",
  },
  {
    name: "Piste Cinétique",
    reference: "Nike.com / marques sport performance (mouvement, contraste fort)",
    tone: "dark",
    sectors: ["sport", "fitness", "coaching sportif", "équipement", "outdoor", "running"],
    font: "Big Shoulders",
    radius: "0",
    layoutNotes: "MISE EN PAGE: hero avec photo action grand format (athlète en mouvement, flou de vitesse), titre condensé TRÈS grand en majuscules qui chevauche presque la photo. Sections en blocs diagonaux ou avec léger décalage (pas tout parfaitement aligné en grille sage), contrastes noir/blanc/accent vif francs. BOUTONS: rectangle net (rayon 0), texte majuscule gras espacé, fond accent vif ou blanc sur noir. PHOTO: photographie sportive dynamique et réelle, jamais posée, mouvement et sueur visibles.",
  },
  {
    name: "Vitrine Nordique",
    reference: "Design scandinave (Muji, Tekla, marques de mobilier minimalistes)",
    tone: "light",
    sectors: ["mobilier", "décoration", "maison", "design d'intérieur", "textile"],
    font: "Karla",
    radius: "0.5rem",
    layoutNotes: "MISE EN PAGE: hero très aéré, beaucoup de blanc/beige, photo produit centrée petite plutôt qu'en plein cadre — la RESPIRATION est le message. Grille de produits simple 3-4 colonnes, fond uni clair, pas d'ombre, juste un espacement généreux entre éléments. BOUTONS: rectangle coins doux (0.5rem), contour fin au repos, jamais de couleur criarde. PHOTO: photographie produit épurée sur fond neutre clair, lumière diffuse, aucune mise en scène surchargée.",
  },
  {
    name: "Console Tactique",
    reference: "Discord.com / itch.io (gaming/communauté, énergie néon sur fond sombre)",
    tone: "dark",
    sectors: ["gaming", "esport", "communauté en ligne", "streaming", "divertissement"],
    font: "Syne",
    radius: "1rem",
    layoutNotes: "MISE EN PAGE: hero avec fond sombre + illustration/mascotte stylisée à droite, titre gras avec un mot en accent coloré. Sections avec cartes flottantes légèrement inclinées (rotate -2deg à 2deg) façon 'stickers', grille asymétrique plutôt que parfaitement alignée. BOUTONS: coins bien arrondis (1rem), fond accent saturé plein, hover avec léger scale-105. PHOTO: illustrations/mascottes stylisées, captures d'écran de communauté/interface, jamais de photo réaliste de personnes.",
  },
  {
    name: "Cabine Sereine",
    reference: "Calm.com / Headspace (bien-être, formes douces, respiration visuelle)",
    tone: "light",
    sectors: ["bien-être", "méditation", "santé mentale", "thérapie", "yoga", "sommeil"],
    font: "Onest",
    radius: "2rem",
    layoutNotes: "MISE EN PAGE: hero avec dégradé de couleurs douces en fond (pas de mesh agressif, des tons pastel qui se fondent lentement), titre centré avec beaucoup d'espace autour. Sections en blocs très arrondis (2rem+) façon galets/nuages, grille 2 colonnes maximum. BOUTONS: pill très arrondi, fond pastel plein ou dégradé doux, texte en poids moyen jamais agressif. PHOTO: photographie apaisante (nature, lumière douce, personnes détendues réelles pas posées), jamais de couleurs saturées criardes.",
  },
  {
    name: "Guichet Précis",
    reference: "Attio.com / Ramp.com (B2B fintech/CRM moderne, précision chirurgicale)",
    tone: "light",
    sectors: ["crm", "rh", "outil interne", "gestion", "erp", "b2b", "productivité équipe"],
    font: "Hanken Grotesk",
    radius: "0.5rem",
    layoutNotes: "MISE EN PAGE: hero avec capture d'écran produit TRÈS détaillée et réaliste (tableau, graphique, liste) en grand, titre court à gauche. Grille de features avec mini-captures d'écran contextuelles plutôt que des icônes seules — montrer le PRODUIT, pas des pictogrammes abstraits. Densité modérée à haute (gap 16px), alignement pixel-perfect strict. BOUTONS: rectangle coins moyens (0.5rem), hauteur 40px précise, un seul style de CTA répété identique partout. PHOTO: aucune photo humaine — uniquement captures d'écran produit réalistes et graphiques de données.",
  },
  {
    name: "Frontière Ambrée",
    reference: "Marques outdoor/voyage (Patagonia, sites de tourisme nature)",
    tone: "light",
    sectors: ["tourisme", "voyage", "hôtel", "outdoor", "nature", "camping", "aventure"],
    font: "Bitter",
    radius: "0.75rem",
    layoutNotes: "MISE EN PAGE: hero plein cadre avec photo de paysage grand format, titre serif chaleureux, léger dégradé sombre en bas pour lisibilité du CTA. Sections en scrollytelling avec grandes photos alternées et texte court, grille de destinations/offres en cartes avec coins arrondis moyens. BOUTONS: rectangle arrondi (0.75rem), fond ambre/terracotta ou contour blanc sur photo. PHOTO: photographie de paysage/voyage réelle et spectaculaire, lumière dorée, jamais de stock touristique générique clicheté.",
  },
  {
    name: "Vitrine Joaillière",
    reference: "Chanel.com / Tiffany.com (luxe éditorial, typographie fine)",
    tone: "dark",
    sectors: ["luxe", "joaillerie", "mode haut de gamme", "horlogerie", "maroquinerie"],
    font: "Cormorant",
    radius: "0",
    layoutNotes: "MISE EN PAGE: hero noir avec UN produit éclairé au centre (fond quasi noir, focus dramatique), titre fin en petites capitales très espacées sous le produit. Sections minimalistes, énormément d'espace noir, un seul élément visuel par section. BOUTONS: texte souligné fin, jamais de gros bouton coloré — la sobriété EST le luxe. PHOTO: photographie produit dramatique en éclairage studio contrasté (fond noir, lumière rasante), jamais de contexte de vie quotidienne.",
  },
  {
    name: "Circuit Précis",
    reference: "Tesla.com (produit tech premium, épure industrielle)",
    tone: "dark",
    sectors: ["automobile", "mobilité", "énergie", "tech industrielle", "robotique"],
    font: "Red Hat Display",
    radius: "0.25rem",
    layoutNotes: "MISE EN PAGE: hero avec produit en très grand sur fond sombre neutre, titre minimal (2-4 mots), specs techniques affichées en grille de chiffres nets sous le hero. Sections épurées, fond alternant noir/blanc pur, transitions nettes sans dégradé. BOUTONS: rectangle presque droit (0.25rem), CTA plein blanc-sur-noir ou noir-sur-blanc, jamais de couleur d'accent vive. PHOTO: rendu produit très propre (studio ou 3D photoréaliste), fond neutre, focus absolu sur le produit sans décor.",
  },
  {
    name: "Cour d'École",
    reference: "Duolingo.com (éducation ludique, mascotte, couleurs franches)",
    tone: "light",
    sectors: ["éducation enfant", "école", "activité enfant", "jeu éducatif", "garde d'enfants"],
    font: "Baloo 2",
    radius: "1.5rem",
    layoutNotes: "MISE EN PAGE: hero coloré et joyeux avec illustration/mascotte ronde, titre gras rond, fond en aplat de couleur vive plutôt que photo. Sections en blocs très arrondis colorés alternés, grille d'activités avec icônes rondes ludiques. BOUTONS: pill très épais et arrondi, ombre portée franche façon 'bouton physique' (pas plat), couleurs vives franches. PHOTO: illustrations vectorielles rondes et colorées plutôt que photos, si photo alors enfants/familles réelles et joyeuses jamais posées de façon guindée.",
  },
  {
    name: "Loft Industriel",
    reference: "Sites d'agences créatives primées (Awwwards-style, grilles asymétriques)",
    tone: "dark",
    sectors: ["agence", "studio créatif", "photographie", "portfolio", "production", "événementiel"],
    font: "Space Mono",
    radius: "0",
    layoutNotes: "MISE EN PAGE: hero plein écran avec typographie XL en mode 'poster', grille de portfolio en damier asymétrique (pas de tailles uniformes), beaucoup de noir et d'espace négatif. Navigation minimaliste, curseur personnalisé suggéré, transitions de page marquées. BOUTONS: texte seul avec soulignement animé au survol, très peu de boutons pleins. PHOTO: travaux/portfolio en plein cadre haute résolution, cadrages variés et audacieux, jamais de grille régulière ennuyeuse.",
  },
  {
    name: "Comptoir Solide",
    reference: "Sites artisans/commerce de proximité (confiance, simplicité fonctionnelle)",
    tone: "light",
    sectors: ["commerce", "artisan", "réparation", "service à domicile", "plomberie", "électricité", "bâtiment"],
    font: "IBM Plex Sans",
    radius: "0.5rem",
    layoutNotes: "MISE EN PAGE: hero direct — titre orienté bénéfice client, CTA téléphone/devis très visible dès le premier écran, photo de l'équipe/atelier réelle. Sections orientées confiance: avis clients, zone d'intervention, tarifs clairs — pas de storytelling long. Grille de services simple en 3 colonnes avec icône + titre + description courte. BOUTONS: rectangle coins moyens (0.5rem), CTA téléphone/devis toujours visible (sticky si pertinent), couleur franche et lisible. PHOTO: photographie réelle de l'équipe/du travail effectué, jamais de stock corporate anonyme.",
  },
  {
    name: "Verrière Blanche",
    reference: "Figma.com / Framer.com (design tool, couleurs franches sur fond blanc)",
    tone: "light",
    sectors: ["design", "outil créatif", "collaboration", "prototypage", "no-code", "saas créatif"],
    font: "Albert Sans",
    radius: "0.875rem",
    layoutNotes: "MISE EN PAGE: hero blanc pur avec formes géométriques colorées flottantes (cercles, triangles superposés en dégradé), titre noir net. Grille de features avec cartes à fond coloré FRANC (pas pastel), coins arrondis (0.875rem), contenu produit visible dans chaque carte. BOUTONS: rectangle bien arrondi, CTA noir plein sur fond blanc, hover subtil. PHOTO: aucune photo — captures d'écran produit colorées et formes géométriques abstraites uniquement.",
  },
  {
    name: "Rive Minérale",
    reference: "Marques de cosmétique clean/skincare (Glossier, The Ordinary — clinique mais chaleureux)",
    tone: "light",
    sectors: ["cosmétique", "skincare", "pharmacie", "beauté", "dermatologie", "parapharmacie"],
    font: "Instrument Sans",
    radius: "1rem",
    layoutNotes: "MISE EN PAGE: hero avec photo produit sur fond rose pâle/beige clinique, texte centré avec ingrédients/bénéfices listés simplement. Grille produit en cartes carrées à coins arrondis moyens, packshot centré sur fond uni pastel identique pour toute la grille (cohérence visuelle forte). BOUTONS: rectangle arrondi (1rem), texte discret, fond blanc ou pastel avec bordure fine. PHOTO: packshot produit très propre sur fond pastel uni, éventuellement peau/texture en gros plan net, jamais de montage complexe.",
  },
  {
    name: "Rotative Urbaine",
    reference: "Sites de transport/mobilité urbaine (clarté d'usage, carte/itinéraire proéminent)",
    tone: "light",
    sectors: ["transport", "mobilité", "livraison", "logistique", "vtc"],
    font: "Work Sans",
    radius: "0.75rem",
    layoutNotes: "MISE EN PAGE: hero avec illustration de trajet/carte stylisée, titre orienté usage ('allez où vous voulez'), CTA app store proéminent. Sections orientées fonctionnement (étapes numérotées 1-2-3 avec icônes), grille de villes/zones desservies. BOUTONS: rectangle coins moyens (0.75rem), boutons app store réels, CTA principal plein accent. PHOTO: illustrations de trajet/carte stylisées ou captures d'app réelles, jamais de photo de voiture générique de stock.",
  },
  {
    name: "Sanctuaire Musical",
    reference: "Spotify.com / sites d'événements musicaux (couleurs vives, énergie festive)",
    tone: "dark",
    sectors: ["musique", "événementiel", "festival", "concert", "billeterie", "divertissement nocturne"],
    font: "Anton",
    radius: "0.5rem",
    layoutNotes: "MISE EN PAGE: hero avec typographie poster ÉNORME qui déborde du cadre, fond dégradé vif animé subtil, image d'ambiance en arrière-plan avec voile sombre. Grille d'événements/artistes en cartes avec photo carrée et forte hiérarchie de date/nom. BOUTONS: rectangle coins moyens (0.5rem), CTA billetterie toujours saturé et visible, texte gras. PHOTO: photographie d'ambiance/concert réelle et vivante, couleurs saturées, jamais de stock souriant plat.",
  },
  {
    name: "Verger Numérique",
    reference: "Marques agro-tech / marketplaces fermières (confiance + modernité)",
    tone: "light",
    sectors: ["agriculture", "marketplace", "producteur local", "circuit court", "agtech"],
    font: "Lexend",
    radius: "0.625rem",
    layoutNotes: "MISE EN PAGE: hero avec photo de terrain/producteur réel, titre orienté impact concret (kilomètres, fraîcheur, prix juste). Grille de produits/producteurs avec photo carrée et badge de provenance. BOUTONS: rectangle coins moyens (0.625rem), fond vert profond ou terre, texte clair. PHOTO: photographie documentaire de terrain réelle, producteurs et produits authentiques, jamais de stock 'ferme parfaite' irréaliste.",
  },
  {
    name: "Réserve Boisée",
    reference: "Marques de spiritueux/vin haut de gamme (obscurité élégante, détail texturé)",
    tone: "dark",
    sectors: ["vin", "spiritueux", "brasserie artisanale", "distillerie", "cave"],
    font: "DM Serif Display",
    radius: "0.25rem",
    layoutNotes: "MISE EN PAGE: hero sombre avec bouteille/verre éclairé dramatiquement au centre, titre serif élégant, texture bois/cuir subtile en fond. Sections avec beaucoup de noir, un produit mis en scène par section. BOUTONS: rectangle presque droit (0.25rem), contour doré fin ou fond ambre profond. PHOTO: photographie produit dramatique en éclairage chaud tamisé, textures (bois, verre, liquide) en gros plan.",
  },
  {
    name: "Aile Blanche",
    reference: "Sites médicaux/cliniques modernes (clarté clinique rassurante)",
    tone: "light",
    sectors: ["santé", "clinique", "médical", "dentaire", "kinésithérapie", "opticien"],
    font: "Figtree",
    radius: "1rem",
    layoutNotes: "MISE EN PAGE: hero blanc/bleu très clair, titre rassurant orienté patient, photo de praticien réel ou illustration médicale claire (jamais alarmiste). Sections avec prise de RDV proéminente, grille de services en cartes à coins arrondis (1rem) avec icône claire. BOUTONS: rectangle bien arrondi, CTA 'Prendre RDV' toujours visible, couleur bleu/vert apaisant. PHOTO: photographie de cabinet/praticien réelle et rassurante, jamais clinique froide ni stock alarmiste.",
  },
  {
    name: "Passage Secret",
    reference: "Arc Browser (the-browser-company.com) — ludique mais premium, formes fluides",
    tone: "light",
    sectors: ["navigateur", "productivité personnelle", "app grand public", "lifestyle tech"],
    font: "Schibsted Grotesk",
    radius: "1.75rem",
    layoutNotes: "MISE EN PAGE: hero avec fond dégradé coloré doux en mouvement, mockup produit flottant avec ombre colorée diffuse, titre enjoué mais net. Sections avec formes très arrondies (1.75rem+), petites touches d'illustration ludique dans les coins. BOUTONS: pill très arrondi, dégradé doux ou couleur franche, hover avec léger rebond. PHOTO: aucune photo — mockups produit et formes/dégradés colorés doux uniquement.",
  },
  {
    name: "Grand Comptoir",
    reference: "Sites e-commerce premium type Shopify showcase (grille produit léchée)",
    tone: "light",
    sectors: ["e-commerce", "boutique en ligne", "vente en ligne", "marketplace", "retail"],
    font: "Familjen Grotesk",
    radius: "0.5rem",
    layoutNotes: "MISE EN PAGE: hero avec produit hero en grand sur fond de couleur de marque uni, badge promo discret. Grille produit stricte (3-4 colonnes), packshot ratio 1:1 identique partout, prix et CTA 'Ajouter au panier' toujours au même endroit sur chaque carte. BOUTONS: rectangle coins moyens (0.5rem), CTA panier plein sur chaque carte produit, CTA principal plus grand en hero. PHOTO: packshot produit cohérent (même angle, même fond) sur toute la grille — la COHÉRENCE visuelle prime sur la variété.",
  },
  {
    name: "Cabinet de Curiosités",
    reference: "Sites de musées/culture (Cooper Hewitt, MoMA — grille éditoriale audacieuse)",
    tone: "light",
    sectors: ["culture", "musée", "exposition", "art", "patrimoine", "billeterie culturelle"],
    font: "Zilla Slab",
    radius: "0",
    layoutNotes: "MISE EN PAGE: hero avec œuvre/visuel en pleine largeur et titre qui la chevauche en typographie serif marquée. Grille d'expositions/collections en tailles VARIÉES (pas uniformes), forte hiérarchie visuelle entre l'événement phare et les autres. BOUTONS: rectangle net (rayon 0), texte souligné au survol, peu de remplissage. PHOTO: reproductions d'œuvres/photographie d'exposition en haute qualité, cadrages généreux, légendes soignées.",
  },
  {
    name: "Rampe de Lancement",
    reference: "Sites de startups deeptech/spatial (SpaceX, Anduril — sobriété technique impressionnante)",
    tone: "dark",
    sectors: ["deeptech", "spatial", "défense", "hardware", "robotique avancée", "recherche"],
    font: "Archivo",
    radius: "0.125rem",
    layoutNotes: "MISE EN PAGE: hero noir avec image/vidéo produit technique impressionnante en fond, titre minimal en majuscules espacées. Sections avec specs techniques présentées en tableaux nets, aucune décoration superflue. BOUTONS: rectangle quasi droit (0.125rem), contour blanc fin sur fond noir, texte majuscule espacé. PHOTO: photographie technique réelle (hardware, essais, terrain), qualité documentaire impressionnante, jamais d'illustration décorative.",
  },
  {
    name: "Kiosque Vivant",
    reference: "Sites d'associations/ONG (chaleur humaine, appel à l'action clair)",
    tone: "light",
    sectors: ["association", "ong", "caritatif", "bénévolat", "don", "impact social"],
    font: "Urbanist",
    radius: "1rem",
    layoutNotes: "MISE EN PAGE: hero avec photo humaine réelle et chaleureuse, titre orienté cause/impact, CTA 'Faire un don' toujours visible et contrasté. Sections avec chiffres d'impact RÉELS mis en avant en grand, grille de projets/témoignages avec photo carrée. BOUTONS: rectangle bien arrondi (1rem), CTA don en couleur chaude distincte du reste. PHOTO: photographie humaine documentaire réelle et digne (jamais misérabiliste ni stock souriant artificiel).",
  },
];

/** Hash stable (même algorithme que anti-ai-smell.ts — pas de Math.random). */
function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

export interface DeAiDesignProfileResult<T> {
  design: T;
  changed: boolean;
  reason: string;
  profile?: DesignProfile;
}

/**
 * Remplace une police/mise en page « signature IA » (police surexploitée ou
 * absente) par un profil de design complet — police, radius, et consigne de
 * mise en page/boutons/photo — choisi de façon DÉTERMINISTE selon le secteur
 * et la tonalité du projet, sur le même principe que deAiPalette. N'écrase
 * jamais un choix de police déjà singulier fait par l'IA ou par 21st.dev.
 */
export function deAiDesignProfile<T extends { font?: string; radius?: string; designNotes?: string; colors?: Record<string, string> }>(
  design: T,
  ctx: { companyName?: string; industry?: string; idea?: string } = {},
): DeAiDesignProfileResult<T> {
  if (!isAiSignatureFont(design?.font)) {
    return { design, changed: false, reason: "police déjà singulière" };
  }

  const tone: "light" | "dark" = design?.colors?.background && isDarkHex(design.colors.background) ? "dark" : "light";
  const pool = DESIGN_PROFILES.filter((p) => p.tone === tone || p.tone === "any");
  const haystack = `${ctx.industry || ""} ${ctx.idea || ""} ${ctx.companyName || ""}`.toLowerCase();
  const matching = pool.filter((p) => p.sectors.some((s) => haystack.includes(s)));
  const candidates = matching.length ? matching : pool;
  const pick = candidates[stableHash(`design|${ctx.companyName || ""}|${ctx.idea || ""}`) % candidates.length];

  const next = {
    ...design,
    font: pick.font,
    radius: pick.radius,
    designNotes: `${design.designNotes || ""}\nProfil de design « ${pick.name} »: ${pick.layoutNotes}`.trim(),
  } as T;

  return { design: next, changed: true, reason: `police « ${design?.font || "absente"} » trop répandue`, profile: pick };
}

function isDarkHex(hex: string): boolean {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return false;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const l = (Math.max(r, g, b) / 255 + Math.min(r, g, b) / 255) / 2;
  return l <= 0.3;
}
