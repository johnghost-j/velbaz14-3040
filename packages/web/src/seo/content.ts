// ─── Contenu SEO / GEO : SOURCE UNIQUE DE VÉRITÉ ────────────────────────────
//
// Pourquoi ce module existe (et pourquoi il est en TS pur, sans React ni Node) :
// il est lu par TROIS consommateurs qui doivent dire EXACTEMENT la même chose,
// sinon Google considère le contenu servi aux robots comme du « cloaking » et
// sanctionne le domaine :
//   1. la page React (humains)                → web/pages/ai-company-builder.tsx
//   2. le pré-rendu HTML (robots + IA)        → seo/render.ts
//   3. llms.txt (ChatGPT, Perplexity, Claude) → seo/render.ts
//
// GEO (Generative Engine Optimization) : un assistant IA ne cite pas une page
// « bien optimisée », il cite une page dont il peut EXTRAIRE des affirmations
// vérifiables et autonomes. D'où la forme : des phrases factuelles complètes,
// qui se comprennent hors contexte, avec des chiffres. Un bullet « Rapide,
// simple, puissant » n'est citable par personne.
//
// Règle absolue : tout ce qui est écrit ici doit être VRAI. Un fait inventé qui
// se retrouve cité par un assistant se transforme en promesse non tenue.

export type SeoLang = "en" | "fr" | "nl";
export const SEO_LANGS: SeoLang[] = ["en", "fr", "nl"];
/** Langue servie quand aucune ne correspond (attribut hreflang x-default). */
export const DEFAULT_LANG: SeoLang = "en";

/** Codes hreflang complets : « fr-BE » cible la Belgique, marché d'origine. */
export const HREFLANG: Record<SeoLang, string> = {
  en: "en",
  fr: "fr",
  nl: "nl",
};

export interface FaqItem {
  q: string;
  a: string;
}

export interface SeoSection {
  h: string;
  p: string;
  /** Points factuels : chacun doit se tenir seul s'il est cité isolément. */
  items?: string[];
}

export interface SeoPageContent {
  /** Identifiant commun aux 3 langues (sert de clé, pas d'URL). */
  slug: string;
  /**
   * Chemin RÉELLEMENT servi, propre à la langue. Trois URL distinctes et non
   * une seule avec un sélecteur : hreflang exige une URL par langue, et le
   * slug traduit porte lui-même le mot-clé recherché dans ce marché.
   */
  path: string;
  title: string;
  description: string;
  h1: string;
  intro: string;
  /** Réponse courte et autonome, placée en tête : c'est CE bloc que les IA citent. */
  answer: string;
  sections: SeoSection[];
  faq: FaqItem[];
  ctaLabel: string;
  ctaHref: string;
  backLabel: string;
}

// ── Faits vérifiables sur le produit ────────────────────────────────────────
// Repris des sources réelles du code : plans.ts (prix, projets, crédits),
// ai-usage/pricing.ts (1 € = 1000 crédits vendus), i18n.tsx (langues).
export const FACTS = {
  brand: "Velbaz",
  domain: "velbaz.com",
  founded: "2026",
  country: "Belgium",
  freePlan: { projects: 1, price: 0 },
  business: { price: 29, currency: "EUR", projects: 10, credits: 75_000 },
  enterprise: { price: 99, currency: "EUR", credits: 500_000 },
  creditRate: "1000 credits = 1 EUR",
  uiLanguages: ["English", "Français", "Español", "Deutsch", "Nederlands"],
} as const;

const EN: SeoPageContent = {
  slug: "company-made-with-ai",
  path: "/company-made-with-ai",
  title: "Company Made With AI — Build and Run a Real Business | Velbaz",
  description:
    "Velbaz is an AI company builder: describe your idea and it generates the website, the brand, the marketing and the sales pipeline, then keeps running the business for you. Free plan, no code.",
  h1: "A company made with AI, from the idea to the first customer",
  intro:
    "Most AI tools give you a draft and stop there. Velbaz goes the whole way: it builds the company, publishes it online, and then keeps working on it every day.",
  answer:
    "Velbaz is an AI company builder. You describe a business idea in one sentence, and a team of AI agents generates the brand, the website, the product catalogue, the marketing content and the sales pipeline, then publishes the site on a real domain and keeps running the business day after day. It is free to start with one project, and it requires no code and no design skills.",
  sections: [
    {
      h: "What a company made with AI actually includes",
      p: "A business is not a landing page. Velbaz produces every piece a real company needs, and they are connected to each other from the start.",
      items: [
        "A published website with its own pages, copy, images and a real domain name.",
        "A brand identity: name, positioning, colour palette, logo and visual assets.",
        "A CRM holding your leads, customers and deals, filled by the site's own forms.",
        "Marketing content: social posts, ads, blog articles and email sequences, written for your market.",
        "An email system that answers inbound messages and follows up on leads automatically.",
        "A mobile app version of the product, generated from the same project.",
      ],
    },
    {
      h: "How Velbaz builds it, step by step",
      p: "Velbaz runs a swarm of specialised AI agents instead of a single chatbot. Each one owns a part of the company, and they hand work to each other.",
      items: [
        "You write the idea in one sentence, in any of five interface languages.",
        "A research agent studies the market, the competition and the pricing before anything is written.",
        "A brand agent fixes the name, the positioning and the visual identity.",
        "A build agent writes and publishes the website and the app.",
        "Growth agents produce the content, the ads and the outreach.",
        "An autopilot keeps the company running after launch, day after day, without you asking.",
      ],
    },
    {
      h: "What it costs",
      p: "Velbaz is free to try with one project. Paid plans unlock more projects, the autopilot and the mobile app.",
      items: [
        "Free plan: one project, no card required.",
        "Business plan: 29 EUR per month, 10 projects, 75,000 credits included, autopilot and mobile app.",
        "Enterprise plan: 99 EUR per month, unlimited projects, 500,000 credits, API access and SSO.",
        "Credits are the usage unit: 1000 credits cost 1 EUR and are only spent when the AI actually works.",
      ],
    },
    {
      h: "Who it is for",
      p: "Velbaz is built for people who have an idea and no team, not for people who already run an agency.",
      items: [
        "Solo founders who want a company online this week instead of next quarter.",
        "Freelancers and consultants who need a credible brand without hiring a designer.",
        "Small businesses that want marketing to happen without someone doing it by hand.",
        "Anyone testing several ideas at once and wanting to see which one gets traction.",
      ],
    },
  ],
  faq: [
    {
      q: "Can AI really build a whole company?",
      a: "It can build everything a company needs to exist online and start selling: the brand, the website, the app, the CRM, the content and the email follow-up. What it cannot do is make the human decisions — what to sell, at what price, and to whom — so Velbaz asks you those questions before it starts building.",
    },
    {
      q: "Do I need to know how to code or design?",
      a: "No. Velbaz writes the code and produces the design itself, and everything is edited through conversation. You can still export or edit the underlying files if you want to.",
    },
    {
      q: "Is the website really published, or just a preview?",
      a: "It is really published. Velbaz hosts the site, connects your own domain name if you have one, and submits it to search engines so it can be found.",
    },
    {
      q: "How long does it take to build a company with Velbaz?",
      a: "The first version of the brand and website is generated in minutes. The content, the ads and the sales follow-up keep being produced afterwards, because a company is not finished the day it launches.",
    },
    {
      q: "What does Velbaz cost to start?",
      a: "Nothing. The free plan includes one project and needs no credit card. Paid plans start at 29 EUR per month for 10 projects, the autopilot and the mobile app.",
    },
    {
      q: "Who owns the company and the content Velbaz generates?",
      a: "You do. The brand, the website, the content and the customer data belong to you, and you can take them elsewhere.",
    },
  ],
  ctaLabel: "Build my company",
  ctaHref: "/register",
  backLabel: "Back to Velbaz",
};

const FR: SeoPageContent = {
  slug: "company-made-with-ai",
  path: "/fr/creer-une-entreprise-avec-lia",
  title: "Créer une entreprise avec l'IA — de l'idée au premier client | Velbaz",
  description:
    "Velbaz est une plateforme qui crée votre entreprise avec l'IA : décrivez votre idée, elle génère la marque, le site, le marketing et le pipeline commercial, puis fait tourner le business à votre place. Gratuit au départ, sans code.",
  h1: "Créer une entreprise avec l'IA, de l'idée au premier client",
  intro:
    "La plupart des outils d'IA vous donnent un brouillon et s'arrêtent là. Velbaz va jusqu'au bout : il construit l'entreprise, la publie en ligne, puis continue à la faire avancer chaque jour.",
  answer:
    "Velbaz est une plateforme belge qui crée une entreprise avec l'IA. Vous décrivez votre idée en une phrase, et une équipe d'agents IA génère la marque, le site web, le catalogue produits, le contenu marketing et le pipeline commercial, publie le site sur un vrai nom de domaine, puis continue à faire tourner l'entreprise jour après jour. C'est gratuit pour un premier projet, sans code et sans compétence en design.",
  sections: [
    {
      h: "Ce que contient vraiment une entreprise créée avec l'IA",
      p: "Une entreprise, ce n'est pas une page d'atterrissage. Velbaz produit chaque pièce dont une vraie société a besoin, et elles sont reliées entre elles dès le départ.",
      items: [
        "Un site web publié, avec ses pages, ses textes, ses images et son propre nom de domaine.",
        "Une identité de marque : nom, positionnement, palette de couleurs, logo et visuels.",
        "Un CRM qui contient vos prospects, vos clients et vos affaires, alimenté par les formulaires du site.",
        "Du contenu marketing : posts sociaux, publicités, articles de blog et séquences d'emails, écrits pour votre marché.",
        "Un système d'emails qui répond aux messages entrants et relance les prospects automatiquement.",
        "Une version application mobile du produit, générée depuis le même projet.",
      ],
    },
    {
      h: "Comment Velbaz la construit, étape par étape",
      p: "Velbaz fait tourner un essaim d'agents IA spécialisés plutôt qu'un seul chatbot. Chacun possède une partie de l'entreprise et se passe le travail.",
      items: [
        "Vous écrivez votre idée en une phrase, dans l'une des cinq langues de l'interface.",
        "Un agent de recherche étudie le marché, la concurrence et les prix avant que quoi que ce soit ne soit écrit.",
        "Un agent de marque fixe le nom, le positionnement et l'identité visuelle.",
        "Un agent de build écrit et publie le site web et l'application.",
        "Des agents de croissance produisent le contenu, les publicités et la prospection.",
        "Un pilote automatique fait tourner l'entreprise après le lancement, jour après jour, sans que vous le demandiez.",
      ],
    },
    {
      h: "Combien ça coûte",
      p: "Velbaz est gratuit à l'essai avec un projet. Les plans payants ouvrent plus de projets, le pilote automatique et l'application mobile.",
      items: [
        "Plan gratuit : un projet, sans carte bancaire.",
        "Plan Business : 29 € par mois, 10 projets, 75 000 crédits inclus, pilote automatique et application mobile.",
        "Plan Enterprise : 99 € par mois, projets illimités, 500 000 crédits, accès API et SSO.",
        "Les crédits sont l'unité d'usage : 1000 crédits coûtent 1 € et ne sont dépensés que quand l'IA travaille réellement.",
      ],
    },
    {
      h: "À qui ça s'adresse",
      p: "Velbaz est fait pour ceux qui ont une idée et pas d'équipe, pas pour ceux qui dirigent déjà une agence.",
      items: [
        "Les fondateurs seuls qui veulent une entreprise en ligne cette semaine, pas au trimestre prochain.",
        "Les indépendants et consultants qui ont besoin d'une marque crédible sans engager un designer.",
        "Les petites entreprises qui veulent que le marketing se fasse sans que quelqu'un le fasse à la main.",
        "Toute personne qui teste plusieurs idées en parallèle et veut voir laquelle décolle.",
      ],
    },
  ],
  faq: [
    {
      q: "L'IA peut-elle vraiment créer une entreprise entière ?",
      a: "Elle peut créer tout ce dont une entreprise a besoin pour exister en ligne et commencer à vendre : la marque, le site, l'application, le CRM, le contenu et les relances par email. Ce qu'elle ne peut pas faire, ce sont les décisions humaines — quoi vendre, à quel prix, à qui — c'est pourquoi Velbaz vous pose ces questions avant de construire.",
    },
    {
      q: "Faut-il savoir coder ou faire du design ?",
      a: "Non. Velbaz écrit le code et produit le design lui-même, et tout se modifie par conversation. Vous pouvez tout de même exporter ou éditer les fichiers si vous le souhaitez.",
    },
    {
      q: "Le site est-il vraiment publié, ou juste un aperçu ?",
      a: "Il est vraiment publié. Velbaz héberge le site, y raccorde votre propre nom de domaine si vous en avez un, et le soumet aux moteurs de recherche pour qu'il soit trouvable.",
    },
    {
      q: "Combien de temps faut-il pour créer une entreprise avec Velbaz ?",
      a: "La première version de la marque et du site est générée en quelques minutes. Le contenu, les publicités et le suivi commercial continuent d'être produits ensuite, parce qu'une entreprise n'est pas terminée le jour de son lancement.",
    },
    {
      q: "Combien coûte Velbaz pour commencer ?",
      a: "Rien. Le plan gratuit comprend un projet et ne demande aucune carte bancaire. Les plans payants démarrent à 29 € par mois pour 10 projets, le pilote automatique et l'application mobile.",
    },
    {
      q: "À qui appartient l'entreprise et le contenu généré par Velbaz ?",
      a: "À vous. La marque, le site, le contenu et les données clients vous appartiennent, et vous pouvez les emporter ailleurs.",
    },
  ],
  ctaLabel: "Créer mon entreprise",
  ctaHref: "/register",
  backLabel: "Retour sur Velbaz",
};

const NL: SeoPageContent = {
  slug: "company-made-with-ai",
  path: "/nl/bedrijf-maken-met-ai",
  title: "Een bedrijf maken met AI — van idee tot eerste klant | Velbaz",
  description:
    "Velbaz maakt je bedrijf met AI: beschrijf je idee en het genereert het merk, de website, de marketing en de verkooppijplijn, en blijft daarna je bedrijf runnen. Gratis om te starten, zonder code.",
  h1: "Een bedrijf maken met AI, van idee tot eerste klant",
  intro:
    "De meeste AI-tools geven je een ontwerp en stoppen daar. Velbaz gaat helemaal door: het bouwt het bedrijf, publiceert het online en blijft er elke dag aan werken.",
  answer:
    "Velbaz is een Belgisch platform dat een bedrijf maakt met AI. Je beschrijft je idee in één zin, en een team AI-agents genereert het merk, de website, de productcatalogus, de marketinginhoud en de verkooppijplijn, publiceert de site op een echte domeinnaam en blijft het bedrijf dag na dag runnen. Starten is gratis met één project, zonder code en zonder designkennis.",
  sections: [
    {
      h: "Wat een bedrijf gemaakt met AI echt bevat",
      p: "Een bedrijf is geen landingspagina. Velbaz maakt elk onderdeel dat een echt bedrijf nodig heeft, en ze zijn van het begin af aan met elkaar verbonden.",
      items: [
        "Een gepubliceerde website met eigen pagina's, teksten, beelden en een echte domeinnaam.",
        "Een merkidentiteit: naam, positionering, kleurenpalet, logo en visuals.",
        "Een CRM met je leads, klanten en deals, gevuld door de formulieren van de site zelf.",
        "Marketinginhoud: social posts, advertenties, blogartikels en e-mailreeksen, geschreven voor jouw markt.",
        "Een e-mailsysteem dat inkomende berichten beantwoordt en leads automatisch opvolgt.",
        "Een mobiele app-versie van het product, gegenereerd uit hetzelfde project.",
      ],
    },
    {
      h: "Hoe Velbaz het stap voor stap bouwt",
      p: "Velbaz laat een zwerm gespecialiseerde AI-agents werken in plaats van één chatbot. Elk bezit een deel van het bedrijf en geeft werk aan de volgende door.",
      items: [
        "Je schrijft je idee in één zin, in een van de vijf interfacetalen.",
        "Een onderzoeksagent bekijkt de markt, de concurrentie en de prijzen voordat er iets geschreven wordt.",
        "Een merkagent bepaalt de naam, de positionering en de visuele identiteit.",
        "Een bouwagent schrijft en publiceert de website en de app.",
        "Groeiagents maken de inhoud, de advertenties en de prospectie.",
        "Een automatische piloot houdt het bedrijf na de lancering dag na dag aan de gang, zonder dat je erom vraagt.",
      ],
    },
    {
      h: "Wat het kost",
      p: "Velbaz is gratis te proberen met één project. Betaalde plannen openen meer projecten, de automatische piloot en de mobiele app.",
      items: [
        "Gratis plan: één project, geen kaart nodig.",
        "Business-plan: 29 EUR per maand, 10 projecten, 75.000 credits inbegrepen, automatische piloot en mobiele app.",
        "Enterprise-plan: 99 EUR per maand, onbeperkte projecten, 500.000 credits, API-toegang en SSO.",
        "Credits zijn de gebruikseenheid: 1000 credits kosten 1 EUR en worden alleen besteed wanneer de AI echt werkt.",
      ],
    },
    {
      h: "Voor wie het is",
      p: "Velbaz is gemaakt voor mensen met een idee en zonder team, niet voor wie al een bureau runt.",
      items: [
        "Solo-oprichters die deze week een bedrijf online willen, niet volgend kwartaal.",
        "Freelancers en consultants die een geloofwaardig merk nodig hebben zonder designer in te huren.",
        "Kleine bedrijven die willen dat marketing gebeurt zonder dat iemand het handmatig doet.",
        "Iedereen die meerdere ideeën tegelijk test en wil zien welk idee aanslaat.",
      ],
    },
  ],
  faq: [
    {
      q: "Kan AI echt een volledig bedrijf bouwen?",
      a: "Het kan alles bouwen wat een bedrijf nodig heeft om online te bestaan en te beginnen verkopen: het merk, de site, de app, het CRM, de inhoud en de e-mailopvolging. Wat het niet kan, zijn de menselijke beslissingen — wat je verkoopt, aan welke prijs en aan wie — daarom stelt Velbaz je die vragen voordat het begint te bouwen.",
    },
    {
      q: "Moet ik kunnen programmeren of ontwerpen?",
      a: "Nee. Velbaz schrijft de code en maakt het ontwerp zelf, en alles wordt via gesprek aangepast. Je kan de onderliggende bestanden nog altijd exporteren of bewerken als je dat wil.",
    },
    {
      q: "Wordt de website echt gepubliceerd, of is het maar een voorbeeld?",
      a: "Ze wordt echt gepubliceerd. Velbaz hostt de site, koppelt je eigen domeinnaam als je er een hebt, en dient ze in bij zoekmachines zodat ze gevonden kan worden.",
    },
    {
      q: "Hoe lang duurt het om een bedrijf te maken met Velbaz?",
      a: "De eerste versie van het merk en de website wordt in minuten gegenereerd. De inhoud, de advertenties en de verkoopopvolging blijven daarna doorlopen, want een bedrijf is niet klaar op de dag van de lancering.",
    },
    {
      q: "Wat kost Velbaz om te starten?",
      a: "Niets. Het gratis plan bevat één project en vraagt geen kredietkaart. Betaalde plannen starten vanaf 29 EUR per maand voor 10 projecten, de automatische piloot en de mobiele app.",
    },
    {
      q: "Wie is eigenaar van het bedrijf en de inhoud die Velbaz genereert?",
      a: "Jij. Het merk, de site, de inhoud en de klantgegevens zijn van jou, en je kan ze elders meenemen.",
    },
  ],
  ctaLabel: "Mijn bedrijf bouwen",
  ctaHref: "/register",
  backLabel: "Terug naar Velbaz",
};

export const PAGES: Record<SeoLang, SeoPageContent> = { en: EN, fr: FR, nl: NL };

/** Chemin servi par langue — dérivé de PAGES, jamais réécrit à la main. */
export const SEO_PATHS: Record<SeoLang, string> = {
  en: EN.path,
  fr: FR.path,
  nl: NL.path,
};

/** Langue correspondant à un chemin entrant, ou null si ce n'est pas une page SEO. */
export function seoLangForPath(pathname: string | null | undefined): SeoLang | null {
  const clean = String(pathname || "").split("?")[0].replace(/\/+$/, "") || "/";
  for (const lang of SEO_LANGS) if (SEO_PATHS[lang] === clean) return lang;
  return null;
}

/**
 * Requêtes visées. Servent à deux choses : les mots-clés de la page, et la
 * liste « ce que les gens cherchent » de llms.txt, qui aide un assistant à
 * savoir POUR QUELLE question Velbaz est une réponse pertinente.
 */
export const TARGET_QUERIES: string[] = [
  "company made with ai",
  "build a company with AI",
  "AI company builder",
  "créer une entreprise avec l'IA",
  "bedrijf maken met AI",
  "Velbaz",
];

/** Normalise n'importe quelle valeur vers une langue servie. */
export function toSeoLang(value: string | null | undefined): SeoLang {
  const v = String(value || "").trim().toLowerCase().slice(0, 2);
  return (SEO_LANGS as string[]).includes(v) ? (v as SeoLang) : DEFAULT_LANG;
}

/** Langue préférée d'un en-tête Accept-Language (pour la redirection douce). */
export function langFromAcceptLanguage(header: string | null | undefined): SeoLang {
  const raw = String(header || "");
  const parts = raw
    .split(",")
    .map((p) => {
      const [tag, q] = p.trim().split(";q=");
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q) : 1 };
    })
    .filter((p) => p.tag && Number.isFinite(p.q))
    .sort((a, b) => b.q - a.q);
  for (const p of parts) {
    const two = p.tag.slice(0, 2);
    if ((SEO_LANGS as string[]).includes(two)) return two as SeoLang;
  }
  return DEFAULT_LANG;
}
