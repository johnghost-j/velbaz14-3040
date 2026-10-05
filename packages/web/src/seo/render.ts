// ─── Rendu HTML des pages SEO / GEO ────────────────────────────────────────
//
// Pourquoi un rendu SERVEUR et pas une simple page React :
// Velbaz est une SPA. En production, `server.ts` renvoie `dist/index.html`
// pour tout chemin inconnu, et le contenu n'apparaît qu'APRÈS exécution du
// JavaScript. Or les robots qui nous intéressent ici ne l'exécutent pas de
// façon fiable :
//   • GPTBot / OAI-SearchBot (ChatGPT), PerplexityBot, ClaudeBot : pas de JS.
//   • Googlebot exécute le JS, mais en deuxième passe, des jours plus tard.
// Une page cliente n'est donc pas citable par un assistant IA. Ce module rend
// du HTML complet, immédiat, lisible sans une ligne de JavaScript.
//
// Cloaking : le HTML servi ici est le MÊME pour un humain et pour un robot
// (aucune détection d'user-agent). C'est volontaire — servir deux contenus
// différents est sanctionné par Google, et c'est la seule règle que ce module
// ne doit jamais enfreindre.
//
// Aucune dépendance de framework (ni React, ni Hono) : ce fichier est importé
// à la fois par le plugin Vite de dev et par `server.ts` en production, et doit
// rendre la même chose dans les deux.

import {
  PAGES,
  SEO_LANGS,
  SEO_PATHS,
  DEFAULT_LANG,
  HREFLANG,
  FACTS,
  TARGET_QUERIES,
  type SeoLang,
  type SeoPageContent,
} from "./content";

import { mainSiteIndexNowKey, mainSiteKeyPath } from "./indexnow";

export { seoLangForPath, SEO_PATHS, SEO_LANGS } from "./content";

const ORIGIN = `https://${FACTS.domain}`;

/** Échappement HTML — tout le contenu passe par ici avant d'entrer dans la page. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Échappement pour un bloc <script type="application/ld+json">.
 * `JSON.stringify` seul ne suffit pas : une chaîne contenant « </script> »
 * fermerait la balise et casserait la page (et l'injection serait possible).
 */
function jsonLd(value: unknown): string {
  return JSON.stringify(value, null, 1).replace(/</g, "\\u003c");
}

const LANG_LABEL: Record<SeoLang, string> = {
  en: "English",
  fr: "Français",
  nl: "Nederlands",
};

// ── Données structurées ─────────────────────────────────────────────────────
// Trois schémas distincts, chacun pour un usage réel :
//  • WebPage + BreadcrumbList : comment Google situe la page dans le site.
//  • FAQPage : rend les questions éligibles aux réponses enrichies, et donne
//    aux assistants IA des paires question/réponse déjà découpées.
//  • SoftwareApplication + Organization : dit CE QU'EST Velbaz, avec ses prix.
function schemas(lang: SeoLang, page: SeoPageContent) {
  const url = ORIGIN + page.path;

  const webPage = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": url,
    url,
    name: page.title,
    description: page.description,
    inLanguage: HREFLANG[lang],
    isPartOf: { "@type": "WebSite", name: FACTS.brand, url: ORIGIN + "/" },
    about: { "@type": "SoftwareApplication", name: FACTS.brand },
    primaryImageOfPage: { "@type": "ImageObject", url: ORIGIN + "/og-image.png" },
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: FACTS.brand, item: ORIGIN + "/" },
        { "@type": "ListItem", position: 2, name: page.h1, item: url },
      ],
    },
  };

  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    inLanguage: HREFLANG[lang],
    mainEntity: page.faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  const software = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: FACTS.brand,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: ORIGIN + "/",
    description: page.answer,
    inLanguage: FACTS.uiLanguages,
    author: {
      "@type": "Organization",
      name: FACTS.brand,
      url: ORIGIN + "/",
      foundingDate: FACTS.founded,
      address: { "@type": "PostalAddress", addressCountry: FACTS.country },
    },
    offers: [
      {
        "@type": "Offer",
        name: "Free",
        price: "0",
        priceCurrency: FACTS.business.currency,
        description: `${FACTS.freePlan.projects} project, no card required.`,
      },
      {
        "@type": "Offer",
        name: "Business",
        price: String(FACTS.business.price),
        priceCurrency: FACTS.business.currency,
        description: `${FACTS.business.projects} projects, ${FACTS.business.credits.toLocaleString("en-US")} credits per month.`,
      },
      {
        "@type": "Offer",
        name: "Enterprise",
        price: String(FACTS.enterprise.price),
        priceCurrency: FACTS.enterprise.currency,
        description: `Unlimited projects, ${FACTS.enterprise.credits.toLocaleString("en-US")} credits per month.`,
      },
    ],
  };

  return [webPage, faqPage, software];
}

// ── Feuille de style ───────────────────────────────────────────────────────
// En ligne et non dans un fichier : la page doit être entièrement rendue au
// premier octet reçu, sans aucune requête supplémentaire. La CSP du site
// autorise `style-src 'unsafe-inline'` (cf. api/security.ts), pas les scripts
// en ligne — d'où une page sans une seule ligne de JS.
const CSS = `
:root{--bg:#04241b;--bg2:#062f23;--card:rgba(255,255,255,.04);--line:rgba(255,255,255,.10);--txt:#eaf5f0;--dim:#9ab8ad;--acc:#34d399}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:820px;margin:0 auto;padding:28px 20px 80px}
header.top{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;padding-bottom:28px}
.brand{font-weight:700;letter-spacing:-.02em;font-size:18px;color:var(--txt)}
nav.langs{display:flex;gap:10px;font-size:13px}
nav.langs a,nav.langs span{color:var(--dim)}
nav.langs span[aria-current]{color:var(--txt);font-weight:600}
h1{font-size:clamp(28px,5vw,44px);line-height:1.12;letter-spacing:-.03em;margin:0 0 16px}
.intro{font-size:18px;color:var(--dim);margin:0 0 28px}
.answer{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:12px;padding:18px 20px;margin:0 0 36px;font-size:17px}
h2{font-size:clamp(20px,3.4vw,26px);letter-spacing:-.02em;margin:40px 0 10px}
p{margin:0 0 12px}
ul{margin:12px 0 0;padding:0;list-style:none}
li{position:relative;padding:7px 0 7px 22px;border-top:1px solid var(--line)}
li:before{content:"";position:absolute;left:4px;top:17px;width:6px;height:6px;border-radius:50%;background:var(--acc)}
.cta{display:inline-block;margin:36px 0 8px;padding:14px 26px;border-radius:999px;background:var(--acc);color:#04241b;font-weight:650;font-size:16px}
.cta:hover{text-decoration:none;filter:brightness(1.08)}
details{border-top:1px solid var(--line);padding:12px 0}
summary{cursor:pointer;font-weight:600;list-style:none}
summary::-webkit-details-marker{display:none}
summary:before{content:"+ ";color:var(--acc)}
details[open] summary:before{content:"– "}
details p{margin:10px 0 0;color:var(--dim)}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:var(--dim);display:flex;flex-wrap:wrap;gap:14px}
@media(prefers-color-scheme:light){:root{--bg:#f6faf8;--card:rgba(4,36,27,.04);--line:rgba(4,36,27,.12);--txt:#08241c;--dim:#4c6b61;--acc:#0f8f68}.cta{color:#fff}}
`.trim();

/** Page SEO complète, en HTML autonome (aucun JS requis pour la lire). */
export function renderSeoPage(lang: SeoLang): string {
  const page = PAGES[lang];
  const url = ORIGIN + page.path;

  // hreflang : chaque langue se déclare ELLE-MÊME et ses sœurs, sinon Google
  // ignore le groupe entier. x-default = la version servie par défaut.
  const alternates = [
    ...SEO_LANGS.map(
      (l) => `<link rel="alternate" hreflang="${HREFLANG[l]}" href="${ORIGIN}${SEO_PATHS[l]}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${ORIGIN}${SEO_PATHS[DEFAULT_LANG]}" />`,
  ].join("\n\t\t");

  const langNav = SEO_LANGS.map((l) =>
    l === lang
      ? `<span aria-current="page">${LANG_LABEL[l]}</span>`
      : `<a href="${SEO_PATHS[l]}" hreflang="${HREFLANG[l]}">${LANG_LABEL[l]}</a>`,
  ).join("");

  const sections = page.sections
    .map((s) => {
      const items = s.items?.length
        ? `<ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
        : "";
      return `<section>\n\t\t<h2>${esc(s.h)}</h2>\n\t\t<p>${esc(s.p)}</p>\n\t\t${items}\n\t</section>`;
    })
    .join("\n\t");

  // <details> et non un accordéon JS : le texte des réponses est dans le HTML,
  // donc lu par les robots, même replié.
  const faq = page.faq
    .map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`)
    .join("\n\t\t");

  const faqTitle = { en: "Frequently asked questions", fr: "Questions fréquentes", nl: "Veelgestelde vragen" }[lang];

  return `<!doctype html>
<html lang="${HREFLANG[lang]}">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${esc(page.title)}</title>
		<meta name="description" content="${esc(page.description)}" />
		<meta name="keywords" content="${esc(TARGET_QUERIES.join(", "))}" />
		<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
		<meta name="theme-color" content="#04241b" />
		<link rel="canonical" href="${url}" />
		${alternates}
		<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=7" />
		<meta property="og:type" content="article" />
		<meta property="og:site_name" content="${FACTS.brand}" />
		<meta property="og:title" content="${esc(page.title)}" />
		<meta property="og:description" content="${esc(page.description)}" />
		<meta property="og:url" content="${url}" />
		<meta property="og:image" content="${ORIGIN}/og-image.png" />
		<meta name="twitter:card" content="summary_large_image" />
		<meta name="twitter:title" content="${esc(page.title)}" />
		<meta name="twitter:description" content="${esc(page.description)}" />
		<meta name="twitter:image" content="${ORIGIN}/og-image.png" />
		${schemas(lang, page)
      .map((s) => `<script type="application/ld+json">${jsonLd(s)}</script>`)
      .join("\n\t\t")}
		<style>${CSS}</style>
	</head>
	<body>
		<div class="wrap">
			<header class="top">
				<a class="brand" href="/">${FACTS.brand}</a>
				<nav class="langs" aria-label="Language">${langNav}</nav>
			</header>
			<main>
				<h1>${esc(page.h1)}</h1>
				<p class="intro">${esc(page.intro)}</p>
				<p class="answer">${esc(page.answer)}</p>
				${sections}
				<section>
					<h2>${esc(faqTitle)}</h2>
					${faq}
				</section>
				<a class="cta" href="${page.ctaHref}">${esc(page.ctaLabel)}</a>
			</main>
			<footer>
				<a href="/">${esc(page.backLabel)}</a>
				<a href="/plans">${esc({ en: "Pricing", fr: "Tarifs", nl: "Prijzen" }[lang])}</a>
				<a href="/community">${esc({ en: "Community", fr: "Communauté", nl: "Community" }[lang])}</a>
				<a href="/legal/privacy">${esc({ en: "Privacy", fr: "Confidentialité", nl: "Privacy" }[lang])}</a>
				<span>© ${new Date().getUTCFullYear()} ${FACTS.brand} — ${FACTS.country}</span>
			</footer>
		</div>
	</body>
</html>
`;
}

/**
 * llms.txt — convention lue par les crawlers d'assistants (ChatGPT, Perplexity,
 * Claude). Un robots.txt dit ce qu'on peut LIRE ; llms.txt dit en Markdown ce
 * que le produit EST, pour quelles questions il est une réponse, et où trouver
 * le texte de référence. Servi en text/plain, sans HTML à traverser.
 */
export function renderLlmsTxt(): string {
  const p = PAGES.en;
  const lines: string[] = [
    `# ${FACTS.brand}`,
    "",
    `> ${p.answer}`,
    "",
    `- Website: ${ORIGIN}/`,
    `- Founded: ${FACTS.founded}, ${FACTS.country}`,
    `- Interface languages: ${FACTS.uiLanguages.join(", ")}`,
    "",
    "## What people are looking for when Velbaz is the answer",
    "",
    ...TARGET_QUERIES.map((q) => `- ${q}`),
    "",
    "## Reference pages",
    "",
    ...SEO_LANGS.map((l) => `- [${PAGES[l].title}](${ORIGIN}${SEO_PATHS[l]}): ${PAGES[l].description}`),
    `- [Pricing](${ORIGIN}/plans): Free plan with ${FACTS.freePlan.projects} project; Business ${FACTS.business.price} ${FACTS.business.currency}/month with ${FACTS.business.projects} projects and ${FACTS.business.credits} credits; Enterprise ${FACTS.enterprise.price} ${FACTS.enterprise.currency}/month with unlimited projects and ${FACTS.enterprise.credits} credits.`,
    `- [Terms](${ORIGIN}/legal/terms) · [Privacy](${ORIGIN}/legal/privacy)`,
    "",
    "## Facts",
    "",
  ];
  for (const s of p.sections) {
    lines.push(`### ${s.h}`, "", s.p, "");
    for (const i of s.items || []) lines.push(`- ${i}`);
    lines.push("");
  }
  lines.push("## FAQ", "");
  for (const f of p.faq) lines.push(`### ${f.q}`, "", f.a, "");
  lines.push(`Credits: ${FACTS.creditRate}. Credits are only consumed when the AI runs a task.`, "");
  return lines.join("\n");
}

/**
 * sitemap.xml du site Velbaz lui-même. Généré et non écrit à la main : ajouter
 * une langue dans content.ts suffit pour qu'elle apparaisse ici.
 * (À ne pas confondre avec api/seo/discovery.ts, qui fait les sitemaps des
 * sites PUBLIÉS par les utilisateurs.)
 */
const STATIC_URLS: Array<{ loc: string; changefreq: string; priority: string }> = [
  { loc: "/", changefreq: "weekly", priority: "1.0" },
  { loc: "/plans", changefreq: "monthly", priority: "0.8" },
  { loc: "/register", changefreq: "monthly", priority: "0.7" },
  { loc: "/login", changefreq: "monthly", priority: "0.6" },
  { loc: "/community", changefreq: "weekly", priority: "0.6" },
  { loc: "/legal/terms", changefreq: "yearly", priority: "0.3" },
  { loc: "/legal/privacy", changefreq: "yearly", priority: "0.3" },
];

export function renderMainSitemap(): string {
  const today = new Date().toISOString().slice(0, 10);

  // Les pages SEO portent leurs alternates DANS le sitemap aussi : Google
  // accepte le groupe hreflang depuis le sitemap même si le HTML n'est pas
  // encore recrawlé.
  const seoEntries = SEO_LANGS.map((l) => {
    const alts = SEO_LANGS.map(
      (o) => `\t\t<xhtml:link rel="alternate" hreflang="${HREFLANG[o]}" href="${ORIGIN}${SEO_PATHS[o]}" />`,
    ).join("\n");
    return [
      "\t<url>",
      `\t\t<loc>${ORIGIN}${SEO_PATHS[l]}</loc>`,
      `\t\t<lastmod>${today}</lastmod>`,
      "\t\t<changefreq>weekly</changefreq>",
      "\t\t<priority>0.9</priority>",
      alts,
      `\t\t<xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${SEO_PATHS[DEFAULT_LANG]}" />`,
      "\t</url>",
    ].join("\n");
  }).join("\n");

  const staticEntries = STATIC_URLS.map((u) =>
    [
      "\t<url>",
      `\t\t<loc>${ORIGIN}${u.loc}</loc>`,
      `\t\t<changefreq>${u.changefreq}</changefreq>`,
      `\t\t<priority>${u.priority}</priority>`,
      "\t</url>",
    ].join("\n"),
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${staticEntries}
${seoEntries}
</urlset>
`;
}

/**
 * Point d'entrée unique du routage SEO, partagé par le dev (plugin Vite) et la
 * prod (server.ts) : une seule implémentation, donc aucun risque que la page
 * marche en local et pas en ligne.
 * Renvoie null si le chemin n'est pas à nous → la SPA reprend la main.
 */
export function seoResponse(pathname: string): { body: string; contentType: string } | null {
  const clean = String(pathname || "").split("?")[0].replace(/\/+$/, "") || "/";

  if (clean === "/llms.txt" || clean === "/.well-known/llms.txt") {
    return { body: renderLlmsTxt(), contentType: "text/plain; charset=utf-8" };
  }
  if (clean === "/sitemap.xml") {
    return { body: renderMainSitemap(), contentType: "application/xml; charset=utf-8" };
  }
  // Fichier de preuve IndexNow : son seul contenu doit être la clé, sans
  // retour à la ligne parasite — les moteurs comparent la chaîne exacte.
  if (clean === mainSiteKeyPath()) {
    return { body: mainSiteIndexNowKey(), contentType: "text/plain; charset=utf-8" };
  }
  for (const lang of SEO_LANGS) {
    if (SEO_PATHS[lang] === clean) {
      return { body: renderSeoPage(lang), contentType: "text/html; charset=utf-8" };
    }
  }
  return null;
}
