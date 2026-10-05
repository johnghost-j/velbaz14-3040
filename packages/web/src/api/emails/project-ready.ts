// ─── Email « Ton projet est prêt » ──────────────────────────────────────────
// Envoyé UNE fois au créateur quand l'IA a fini son projet. Rendu PUR (aucun
// accès base / réseau) pour pouvoir être testé et prévisualisé.
//
// Contraintes email : tableaux + CSS inline uniquement (Gmail, Outlook, Apple
// Mail), largeur 600 px, polices système, aucune image indispensable (le logo
// a un texte de repli), version texte complète pour les clients sans HTML.

export type ProjectReadyLang = "fr" | "en";

export interface ProjectReadyEmailInput {
  projectName: string;
  ownerName?: string | null;
  /** Courte description du projet (1-2 phrases). */
  description?: string | null;
  /** Lien pour ouvrir le projet dans Velbaz (chat + aperçu). */
  projectUrl: string;
  /** Lien public du site s'il est déjà publié. */
  liveUrl?: string | null;
  /** Pages réellement construites (titres lisibles). */
  pages: string[];
  /** Fonctionnalités détectées (panier, paiement, comptes…). */
  features: string[];
  /** web | mobile | both */
  projectType?: string | null;
  lang?: ProjectReadyLang;
  /** Racine publique de Velbaz (logo, liens de pied de page). */
  baseUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const T = {
  fr: {
    subject: (n: string) => `${n} est prêt — ton projet t'attend`,
    preheader: (n: string, p: number) => `${n} est construit : ${p} page${p > 1 ? "s" : ""}, vérifiées et prêtes à être publiées.`,
    eyebrow: "Projet terminé",
    hello: (o?: string | null) => (o ? `Bonne nouvelle, ${o}.` : "Bonne nouvelle."),
    title: (n: string) => `${n} est prêt.`,
    lead: "L'IA a terminé la construction : les pages sont codées, testées dans un vrai navigateur et visibles dès maintenant dans ton aperçu.",
    cta: "Ouvrir mon projet",
    live: "Voir le site en ligne",
    built: "Ce qui a été construit",
    pagesLabel: (p: number) => `${p} page${p > 1 ? "s" : ""}`,
    featuresLabel: "Fonctionnalités",
    next: "Prochaines étapes",
    steps: [
      ["Vérifie l'aperçu", "Ouvre le projet et parcours chaque page. Une retouche ? Demande-la simplement dans le chat."],
      ["Publie ton site", "Clique sur « Publier » pour le mettre en ligne, puis connecte ton propre nom de domaine si tu veux."],
      ["Fais-le connaître", "Lance la visibilité : réseaux sociaux, campagnes et contenus sont prêts à être activés depuis ton projet."],
    ] as [string, string][],
    fallback: "Le bouton ne fonctionne pas ? Copie ce lien dans ton navigateur :",
    footer: (n: string) => `Tu reçois cet email parce que tu as créé ${n} sur Velbaz. Il n'est envoyé qu'une seule fois par projet.`,
    sign: "L'équipe Velbaz",
    types: { web: "Site web", mobile: "App mobile", both: "Site web + app mobile" } as Record<string, string>,
  },
  en: {
    subject: (n: string) => `${n} is ready — your project is waiting`,
    preheader: (n: string, p: number) => `${n} is built: ${p} page${p > 1 ? "s" : ""}, tested and ready to publish.`,
    eyebrow: "Project complete",
    hello: (o?: string | null) => (o ? `Good news, ${o}.` : "Good news."),
    title: (n: string) => `${n} is ready.`,
    lead: "The AI has finished building: every page is coded, tested in a real browser and live in your preview right now.",
    cta: "Open my project",
    live: "View the live site",
    built: "What was built",
    pagesLabel: (p: number) => `${p} page${p > 1 ? "s" : ""}`,
    featuresLabel: "Features",
    next: "Next steps",
    steps: [
      ["Review the preview", "Open the project and go through each page. Want a change? Just ask in the chat."],
      ["Publish your site", "Click “Publish” to put it online, then connect your own domain if you like."],
      ["Get the word out", "Social accounts, campaigns and content are ready to switch on from your project."],
    ] as [string, string][],
    fallback: "Button not working? Paste this link into your browser:",
    footer: (n: string) => `You're receiving this because you created ${n} on Velbaz. It is only sent once per project.`,
    sign: "The Velbaz team",
    types: { web: "Website", mobile: "Mobile app", both: "Website + mobile app" } as Record<string, string>,
  },
};

export function escapeEmailHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Langue de l'email. `companies.languages` vaut '["en"]' PAR DÉFAUT pour tout
 * le monde : ce défaut n'est donc pas un signal. On ne passe en anglais que si
 * le projet a explicitement d'autres langues avec l'anglais en premier, ou si
 * le texte du projet (idée / description) est nettement anglais. Sinon : français.
 */
export function pickEmailLang(languagesJson?: string | null, sampleText?: string | null): ProjectReadyLang {
  let arr: string[] = [];
  try {
    const parsed = JSON.parse(languagesJson || "[]");
    if (Array.isArray(parsed)) arr = parsed.map(x => String(x || "").toLowerCase());
  } catch { /* défaut */ }
  const isDefault = arr.length === 0 || (arr.length === 1 && arr[0] === "en");
  if (!isDefault) return arr[0].startsWith("en") ? "en" : "fr";
  const txt = ` ${String(sampleText || "").toLowerCase()} `;
  if (txt.trim().length < 8) return "fr";
  const count = (words: string[]) => words.reduce((n, w) => n + (txt.split(` ${w} `).length - 1), 0);
  const fr = count(["le", "la", "les", "des", "du", "de", "et", "un", "une", "pour", "avec", "est", "à", "qui", "mon", "ma", "mes", "en", "sur", "dans"])
    + (/[éèêàùçô]/.test(txt) ? 2 : 0);
  const en = count(["the", "and", "for", "with", "is", "a", "an", "of", "to", "my", "your", "that", "which", "on", "in", "app", "website"]);
  return en >= 3 && en > fr * 1.5 ? "en" : "fr";
}

const PAGE_LABELS: Record<string, { fr: string; en: string }> = {
  home: { fr: "Accueil", en: "Home" }, index: { fr: "Accueil", en: "Home" }, landing: { fr: "Accueil", en: "Home" },
  productdetail: { fr: "Fiche produit", en: "Product page" }, product: { fr: "Fiche produit", en: "Product page" },
  products: { fr: "Catalogue", en: "Catalogue" }, shop: { fr: "Boutique", en: "Shop" }, catalog: { fr: "Catalogue", en: "Catalogue" },
  cart: { fr: "Panier", en: "Cart" }, checkout: { fr: "Paiement", en: "Checkout" },
  orders: { fr: "Mes commandes", en: "My orders" }, orderdetail: { fr: "Détail commande", en: "Order details" },
  profile: { fr: "Profil", en: "Profile" }, account: { fr: "Mon compte", en: "My account" },
  dashboard: { fr: "Tableau de bord", en: "Dashboard" }, support: { fr: "Support", en: "Support" },
  contact: { fr: "Contact", en: "Contact" }, about: { fr: "À propos", en: "About" }, pricing: { fr: "Tarifs", en: "Pricing" },
  blog: { fr: "Blog", en: "Blog" }, faq: { fr: "FAQ", en: "FAQ" }, booking: { fr: "Réservation", en: "Booking" },
  services: { fr: "Services", en: "Services" }, gallery: { fr: "Galerie", en: "Gallery" }, menu: { fr: "Menu", en: "Menu" },
};
const LEGAL_PAGE = /^(legal|legalnotice|legalpage|privacy|privacypolicy|terms|termsofservice|cookies?|cgv|cgu|mentions(legales)?)$/;
const AUTH_PAGE = /^(login|signin|signup|register|forgotpassword|resetpassword|auth)$/;
const HIDDEN = /^(notfound|404|app|layout|indexlayout|settings|admin)$/;

/**
 * Liste lisible des pages d'un projet React à partir des noms de fichiers
 * `src/pages/*.tsx` : pages métier traduites, puis pages de connexion et
 * pages légales regroupées en une ligne chacune.
 */
export function summarizeReactPages(fileNames: string[], lang: ProjectReadyLang = "fr"): string[] {
  const main: string[] = [];
  let legal = false, auth = false;
  for (const raw of fileNames) {
    const base = String(raw || "").split("/").pop()!.replace(/\.(tsx|jsx|ts|js)$/, "");
    const key = base.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/page$/, "") || base.toLowerCase();
    if (HIDDEN.test(key)) continue;
    if (LEGAL_PAGE.test(key)) { legal = true; continue; }
    if (AUTH_PAGE.test(key)) { auth = true; continue; }
    main.push(PAGE_LABELS[key]?.[lang] || humanizePageName(base));
  }
  const order = (l: string) => (/^(Accueil|Home)$/.test(l) ? 0 : 1);
  const out = [...new Set(main)].sort((a, b) => order(a) - order(b));
  if (auth) out.push(lang === "fr" ? "Connexion & inscription" : "Sign in & sign up");
  if (legal) out.push(lang === "fr" ? "Pages légales (mentions, confidentialité, CGU, cookies)" : "Legal pages (notice, privacy, terms, cookies)");
  return out;
}

/** « ProductDetail » → « Product Detail », « mes-commandes » → « Mes commandes ». */
export function humanizePageName(raw: string): string {
  const s = String(raw || "")
    .replace(/\.(tsx|jsx|ts|js)$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** Fonctionnalités lisibles déduites des chemins de fichiers du projet. */
export function detectFeatures(paths: string[], lang: ProjectReadyLang = "fr"): string[] {
  const has = (re: RegExp) => paths.some(p => re.test(p));
  const fr = lang === "fr";
  const out: string[] = [];
  if (has(/catalog|products?\b|Shop/i)) out.push(fr ? "Catalogue produits" : "Product catalogue");
  if (has(/Cart|panier/i)) out.push(fr ? "Panier persistant" : "Persistent cart");
  if (has(/Checkout|stripe|payment|paiement/i)) out.push(fr ? "Paiement sécurisé" : "Secure checkout");
  if (has(/Login|Signup|Register|auth|Account/i)) out.push(fr ? "Comptes clients" : "Customer accounts");
  if (has(/Orders|commandes/i)) out.push(fr ? "Suivi des commandes" : "Order tracking");
  if (has(/Contact/i)) out.push(fr ? "Formulaire de contact" : "Contact form");
  if (has(/Blog|Article/i)) out.push(fr ? "Blog" : "Blog");
  if (has(/Booking|Reserv|Appointment|rendez/i)) out.push(fr ? "Réservation en ligne" : "Online booking");
  if (has(/Legal|Privacy|Terms|cgv|mentions/i)) out.push(fr ? "Pages légales" : "Legal pages");
  out.push(fr ? "Design responsive (mobile, tablette, ordinateur)" : "Responsive design (mobile, tablet, desktop)");
  return out;
}

export function renderProjectReadyEmail(input: ProjectReadyEmailInput): RenderedEmail {
  const lang: ProjectReadyLang = input.lang === "en" ? "en" : "fr";
  const t = T[lang];
  const e = escapeEmailHtml;
  const base = input.baseUrl.replace(/\/$/, "");
  const name = (input.projectName || "Ton projet").trim();
  const pages = [...new Set(input.pages.map(p => p.trim()).filter(Boolean))].slice(0, 12);
  const features = [...new Set(input.features.map(f => f.trim()).filter(Boolean))].slice(0, 8);
  const typeLabel = t.types[input.projectType || "web"] || t.types.web;
  const desc = (input.description || "").trim().slice(0, 280);

  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const ink = "#111111";
  const muted = "#6B6B6B";
  const line = "#E7E5E1";

  const pageRows = pages.map(p => `
              <tr>
                <td width="22" valign="top" style="padding:7px 0;font:600 13px/20px ${font};color:${ink}">✓</td>
                <td valign="top" style="padding:7px 0;font:400 15px/20px ${font};color:${ink};border-bottom:1px solid ${line}">${e(p)}</td>
              </tr>`).join("");

  const featureChips = features.map(f =>
    `<span style="display:inline-block;margin:0 6px 8px 0;padding:6px 12px;border:1px solid ${line};border-radius:999px;font:500 13px/18px ${font};color:${ink};background:#FAFAF8">${e(f)}</span>`).join("");

  const steps = t.steps.map(([h, b], i) => `
              <tr>
                <td width="40" valign="top" style="padding:0 0 18px">
                  <div style="width:28px;height:28px;border-radius:14px;background:${ink};color:#FFFFFF;font:700 13px/28px ${font};text-align:center">${i + 1}</div>
                </td>
                <td valign="top" style="padding:2px 0 18px">
                  <div style="font:600 15px/22px ${font};color:${ink}">${e(h)}</div>
                  <div style="font:400 14px/21px ${font};color:${muted}">${e(b)}</div>
                </td>
              </tr>`).join("");

  const liveBtn = input.liveUrl
    ? `<a href="${e(input.liveUrl)}" style="display:inline-block;margin:0 0 0 10px;padding:14px 22px;border:1px solid ${ink};border-radius:10px;font:600 15px/18px ${font};color:${ink};text-decoration:none">${e(t.live)}</a>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${e(t.subject(name))}</title>
<style>
  @media only screen and (max-width:620px){
    .vz-card{width:100% !important;border-radius:0 !important}
    .vz-full{width:100% !important}
    .vz-outer{padding:0 !important}
    .vz-pad{padding-left:24px !important;padding-right:24px !important}
    .vz-h1{font-size:30px !important;line-height:36px !important}
    .vz-btn a{display:block !important;margin:0 0 10px 0 !important;text-align:center !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F2F1EE;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${e(t.preheader(name, pages.length || 1))}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F1EE">
  <tr>
    <td align="center" class="vz-outer" style="padding:32px 12px">
      <table role="presentation" class="vz-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden">
        <!-- En-tête -->
        <tr>
          <td class="vz-pad" style="background:${ink};padding:22px 40px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" width="40"><img src="${e(base)}/velbaz-logo-120-dark.png" width="32" height="32" alt="Velbaz" style="display:block;border:0;border-radius:8px"></td>
                <td valign="middle" style="padding-left:10px;font:700 15px/20px ${font};letter-spacing:3px;color:#FFFFFF">VELBAZ</td>
                <td valign="middle" align="right" style="font:500 12px/20px ${font};color:#A8A8A8">${e(typeLabel)}</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Héros -->
        <tr>
          <td class="vz-pad" style="padding:44px 40px 8px">
            <div style="font:600 12px/16px ${font};letter-spacing:2px;text-transform:uppercase;color:#1F8A4C">● ${e(t.eyebrow)}</div>
            <div style="padding-top:18px;font:400 16px/24px ${font};color:${muted}">${e(t.hello(input.ownerName))}</div>
            <h1 class="vz-h1" style="margin:6px 0 0;font:700 36px/42px ${font};letter-spacing:-0.5px;color:${ink}">${e(t.title(name))}</h1>
            ${desc ? `<p style="margin:14px 0 0;font:italic 400 16px/24px Georgia,'Times New Roman',serif;color:${ink}">${lang === "fr" ? `« ${e(desc)} »` : `&ldquo;${e(desc)}&rdquo;`}</p>` : ""}
            <p style="margin:16px 0 0;font:400 16px/25px ${font};color:#3A3A3A">${e(t.lead)}</p>
          </td>
        </tr>
        <!-- Boutons -->
        <tr>
          <td class="vz-pad vz-btn" style="padding:28px 40px 36px">
            <a href="${e(input.projectUrl)}" style="display:inline-block;padding:15px 26px;background:${ink};border-radius:10px;font:600 15px/18px ${font};color:#FFFFFF;text-decoration:none">${e(t.cta)} &rarr;</a>${liveBtn}
          </td>
        </tr>
        <!-- Ce qui a été construit -->
        <tr>
          <td class="vz-pad" style="padding:0 40px">
            <div style="border-top:1px solid ${line};padding-top:30px;font:700 18px/24px ${font};color:${ink}">${e(t.built)}</div>
            ${pages.length ? `
            <div style="padding-top:14px;font:600 12px/16px ${font};letter-spacing:1px;text-transform:uppercase;color:${muted}">${e(t.pagesLabel(pages.length))}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px">${pageRows}
            </table>` : ""}
            ${features.length ? `
            <div style="padding-top:22px;font:600 12px/16px ${font};letter-spacing:1px;text-transform:uppercase;color:${muted}">${e(t.featuresLabel)}</div>
            <div style="padding-top:10px">${featureChips}</div>` : ""}
          </td>
        </tr>
        <!-- Prochaines étapes -->
        <tr>
          <td class="vz-pad" style="padding:22px 40px 10px">
            <div style="background:#FAFAF8;border:1px solid ${line};border-radius:12px;padding:24px 24px 6px">
              <div style="font:700 18px/24px ${font};color:${ink};padding-bottom:16px">${e(t.next)}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${steps}
              </table>
            </div>
          </td>
        </tr>
        <!-- Lien de secours + signature -->
        <tr>
          <td class="vz-pad" style="padding:22px 40px 36px">
            <p style="margin:0;font:400 13px/20px ${font};color:${muted}">${e(t.fallback)}<br><a href="${e(input.projectUrl)}" style="color:${ink};word-break:break-all">${e(input.projectUrl)}</a></p>
            <p style="margin:22px 0 0;font:600 15px/22px ${font};color:${ink}">${e(t.sign)}</p>
          </td>
        </tr>
      </table>
      <!-- Pied de page -->
      <table role="presentation" class="vz-full" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
        <tr>
          <td align="center" style="padding:20px 24px 8px;font:400 12px/18px ${font};color:#8A8A8A">${e(t.footer(name))}</td>
        </tr>
        <tr>
          <td align="center" style="padding:0 24px 24px;font:600 12px/18px ${font};letter-spacing:2px;color:#8A8A8A"><a href="${e(base)}" style="color:#8A8A8A;text-decoration:none">VELBAZ</a></td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    t.hello(input.ownerName),
    "",
    t.title(name),
    desc ? (lang === "fr" ? `« ${desc} »` : `“${desc}”`) : "",
    t.lead,
    "",
    `${t.cta} : ${input.projectUrl}`,
    input.liveUrl ? `${t.live} : ${input.liveUrl}` : "",
    "",
    `${t.built.toUpperCase()}`,
    pages.length ? `${t.pagesLabel(pages.length)} :` : "",
    ...pages.map(p => `  ✓ ${p}`),
    features.length ? `${t.featuresLabel} : ${features.join(" · ")}` : "",
    "",
    t.next.toUpperCase(),
    ...t.steps.map(([h, b], i) => `  ${i + 1}. ${h} — ${b}`),
    "",
    t.sign,
    "",
    "—",
    t.footer(name),
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");

  return { subject: t.subject(name), html, text };
}
