// ─── Pages de compte PERSONNALISÉES par projet ───────────────────────────────
// Constat (bug remonté): Login / Profile / Settings étaient des constantes de
// chaîne FIGÉES dans scaffold.ts — la MÊME page, mot pour mot et pixel pour
// pixel, dans TOUS les sites générés (seules les couleurs changeaient, via les
// tokens Tailwind). Contrairement à Signup (déjà `(meta) => …`, FR/EN) et aux
// pages légales (contenu écrit par l'IA légale via planLegalPack), ces trois
// pages n'avaient AUCUNE variation par projet: ni langue, ni nom d'entreprise,
// ni ton métier, ni mise en page.
//
// Ce module apporte les deux niveaux de personnalisation:
//  1. COPY — `resolveAuthCopy(meta)` : le texte écrit par l'IA de design
//     (champ "authCopy" du JSON du design system, donc AUCUN appel LLM en plus)
//     surcharge un repli DÉTERMINISTE FR/EN adapté au SECTEUR (boutique,
//     restaurant, réservation, SaaS, formation, santé, immobilier, événement,
//     services) et interpolant le nom de l'entreprise. Même logique que
//     legal-compliance.ts: l'IA enrichit, le repli garantit que ça compile
//     toujours.
//  2. MISE EN PAGE — `pickAuthLayout(meta)` : 3 gabarits réellement différents
//     (split écran de marque / carte / minimal éditorial). Choisis par l'IA
//     ("authLayout") ou, à défaut, par un hash STABLE du projet — donc deux
//     builds du même projet sont identiques, mais deux projets différents ne se
//     ressemblent pas.
//
// Les templates TSX des 3 pages vivent ici (et non dans scaffold.ts) pour que
// scaffold.ts ne fasse que les appeler avec `meta`.

/** Sous-ensemble de AppMeta dont ces pages ont besoin. Déclaré ici (et pas
 *  importé depuis scaffold.ts) pour éviter un import circulaire: scaffold.ts
 *  importe ce module, jamais l'inverse. */
export interface AuthPageMeta {
  companyName: string;
  slug?: string;
  idea?: string;
  tagline?: string;
  lang?: string;
  logoUrl?: string;
  authCopy?: Partial<AuthCopy>;
  authLayout?: string;
}

export interface AuthCopy {
  /** Titre de la page de connexion (ex: « Connexion à Atelier Lumière »). */
  loginTitle: string;
  /** Sous-titre de la connexion, au ton du métier. */
  loginSubtitle: string;
  /** Libellé du bouton de connexion (verbe d'action métier). */
  loginCta: string;
  /** Une phrase sur ce que le compte apporte concrètement (panneau de marque). */
  loginBenefit: string;
  /** Titre de la page d'inscription. */
  signupTitle: string;
  /** Sous-titre de l'inscription, au ton du métier. */
  signupSubtitle: string;
  /** Libellé du bouton d'inscription. */
  signupCta: string;
  /** Titre de l'espace personnel (ex: « Mon compte client »). */
  profileTitle: string;
  /** Sous-titre de l'espace personnel. */
  profileSubtitle: string;
  /** Titre de la page réglages. */
  settingsTitle: string;
  /** Sous-titre de la page réglages. */
  settingsSubtitle: string;
}

export type AuthLayout = "split" | "card" | "minimal";
const AUTH_LAYOUTS: AuthLayout[] = ["split", "card", "minimal"];

/** Hash stable (même chaîne → même entier), cf. design-profiles.ts. */
function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

type Sector =
  | "shop" | "food" | "booking" | "saas" | "learn"
  | "health" | "realestate" | "events" | "services";

const SECTOR_RULES: { sector: Sector; re: RegExp }[] = [
  { sector: "shop", re: /\b(boutique|e-?commerce|shop|store|magasin|vente|vendre|produits?|artisan\w*|marketplace|marque de|dropship\w*)\b/i },
  { sector: "food", re: /\b(restaurant|resto|caf[eé]|pizz\w*|traiteur|food|menus?|brasserie|boulangerie|p[aâ]tisserie|bar\b|food[- ]?truck|cuisine)\b/i },
  { sector: "booking", re: /\b(r[eé]serv\w*|booking|rendez-vous|appointments?|salon|coiffure|barbier|spa|institut|planning|cr[eé]neaux?)\b/i },
  { sector: "saas", re: /\b(saas|plateforme|platform|dashboard|logiciel|software|outil|tool|application|app\b|automatisation|api)\b/i },
  { sector: "learn", re: /\b(cours|formation\w*|[eé]cole|school|academy|apprendre|learning|tuto\w*|coaching scolaire|e-?learning|[eé]tudiants?)\b/i },
  { sector: "health", re: /\b(sant[eé]|clinique|health|m[eé]dical\w*|medical|th[eé]rap\w*|therap\w*|cabinet|fitness|sport|gym|yoga|nutrition|bien-?[eê]tre)\b/i },
  { sector: "realestate", re: /\b(immobilier|real estate|immo\b|logements?|locations?|biens?|appartements?|agence immobili[eè]re)\b/i },
  { sector: "events", re: /\b([eé]v[eé]nement\w*|events?|billets?|tickets?|festival|mariage|conf[eé]rence|s[eé]minaire)\b/i },
];

export function detectAuthSector(meta: AuthPageMeta): Sector {
  const hay = `${meta.idea || ""} ${meta.tagline || ""} ${meta.companyName || ""}`;
  for (const rule of SECTOR_RULES) if (rule.re.test(hay)) return rule.sector;
  return "services";
}

/** Textes de repli par secteur (FR + EN). Toujours du texte métier concret:
 *  « Retrouve tes commandes » vaut mieux que « Ravi de te revoir ». */
const SECTOR_COPY: Record<Sector, {
  fr: { loginSubtitle: string; loginCta: string; loginBenefit: string; profileTitle: string; profileSubtitle: string; settingsSubtitle: string };
  en: { loginSubtitle: string; loginCta: string; loginBenefit: string; profileTitle: string; profileSubtitle: string; settingsSubtitle: string };
}> = {
  shop: {
    fr: {
      loginSubtitle: "Connecte-toi pour retrouver tes commandes et tes favoris.",
      loginCta: "Accéder à mon compte",
      loginBenefit: "Suivi de commandes, adresses enregistrées et favoris réunis au même endroit.",
      profileTitle: "Mon compte client",
      profileSubtitle: "Tes informations, tes commandes et tes préférences de livraison.",
      settingsSubtitle: "Gère tes informations d'acheteur et l'apparence de la boutique.",
    },
    en: {
      loginSubtitle: "Sign in to find your orders and saved items.",
      loginCta: "Go to my account",
      loginBenefit: "Order tracking, saved addresses and wishlist in one place.",
      profileTitle: "My customer account",
      profileSubtitle: "Your details, your orders and your delivery preferences.",
      settingsSubtitle: "Manage your shopper details and the store's appearance.",
    },
  },
  food: {
    fr: {
      loginSubtitle: "Connecte-toi pour retrouver tes réservations et tes commandes.",
      loginCta: "Accéder à mon espace",
      loginBenefit: "Tes réservations, tes plats favoris et tes commandes précédentes.",
      profileTitle: "Mon espace",
      profileSubtitle: "Tes réservations, tes commandes et tes préférences.",
      settingsSubtitle: "Gère tes informations et l'apparence du site.",
    },
    en: {
      loginSubtitle: "Sign in to find your bookings and past orders.",
      loginCta: "Go to my space",
      loginBenefit: "Your reservations, favourite dishes and previous orders.",
      profileTitle: "My space",
      profileSubtitle: "Your bookings, your orders and your preferences.",
      settingsSubtitle: "Manage your details and the site's appearance.",
    },
  },
  booking: {
    fr: {
      loginSubtitle: "Connecte-toi pour gérer tes rendez-vous.",
      loginCta: "Voir mes rendez-vous",
      loginBenefit: "Prise de rendez-vous en deux clics, rappels et historique complet.",
      profileTitle: "Mon espace client",
      profileSubtitle: "Tes rendez-vous à venir et ton historique.",
      settingsSubtitle: "Gère tes coordonnées et tes préférences de rappel.",
    },
    en: {
      loginSubtitle: "Sign in to manage your appointments.",
      loginCta: "View my appointments",
      loginBenefit: "Two-click booking, reminders and your full history.",
      profileTitle: "My client space",
      profileSubtitle: "Your upcoming appointments and your history.",
      settingsSubtitle: "Manage your contact details and reminder preferences.",
    },
  },
  saas: {
    fr: {
      loginSubtitle: "Reprends là où tu t'es arrêté.",
      loginCta: "Ouvrir mon espace de travail",
      loginBenefit: "Tes projets, tes données et tes réglages synchronisés sur tous tes appareils.",
      profileTitle: "Mon profil",
      profileSubtitle: "Ton compte et l'accès à ton espace de travail.",
      settingsSubtitle: "Gère ton compte, ton espace de travail et l'apparence.",
    },
    en: {
      loginSubtitle: "Pick up right where you left off.",
      loginCta: "Open my workspace",
      loginBenefit: "Your projects, data and settings synced across every device.",
      profileTitle: "My profile",
      profileSubtitle: "Your account and access to your workspace.",
      settingsSubtitle: "Manage your account, your workspace and the appearance.",
    },
  },
  learn: {
    fr: {
      loginSubtitle: "Connecte-toi pour reprendre ta progression.",
      loginCta: "Reprendre ma formation",
      loginBenefit: "Ta progression, tes cours suivis et tes certificats, sauvegardés.",
      profileTitle: "Mon espace apprenant",
      profileSubtitle: "Ta progression, tes cours et tes certificats.",
      settingsSubtitle: "Gère ton profil d'apprenant et l'apparence de la plateforme.",
    },
    en: {
      loginSubtitle: "Sign in to pick your progress back up.",
      loginCta: "Resume my course",
      loginBenefit: "Your progress, enrolled courses and certificates, all saved.",
      profileTitle: "My learning space",
      profileSubtitle: "Your progress, your courses and your certificates.",
      settingsSubtitle: "Manage your learner profile and the platform's appearance.",
    },
  },
  health: {
    fr: {
      loginSubtitle: "Connecte-toi à ton espace personnel en toute confidentialité.",
      loginCta: "Accéder à mon suivi",
      loginBenefit: "Ton suivi, tes documents et tes rendez-vous, accessibles à toi seul.",
      profileTitle: "Mon espace personnel",
      profileSubtitle: "Ton suivi, tes documents et tes rendez-vous.",
      settingsSubtitle: "Gère tes informations personnelles et l'apparence du site.",
    },
    en: {
      loginSubtitle: "Sign in to your private space.",
      loginCta: "Open my records",
      loginBenefit: "Your progress, documents and appointments — visible to you only.",
      profileTitle: "My personal space",
      profileSubtitle: "Your progress, your documents and your appointments.",
      settingsSubtitle: "Manage your personal details and the site's appearance.",
    },
  },
  realestate: {
    fr: {
      loginSubtitle: "Connecte-toi pour retrouver tes biens sauvegardés.",
      loginCta: "Voir ma sélection",
      loginBenefit: "Tes biens favoris, tes alertes et tes visites programmées.",
      profileTitle: "Mon espace",
      profileSubtitle: "Tes biens favoris, tes alertes et tes visites.",
      settingsSubtitle: "Gère tes coordonnées et tes alertes de recherche.",
    },
    en: {
      loginSubtitle: "Sign in to find your saved listings.",
      loginCta: "View my shortlist",
      loginBenefit: "Your saved listings, search alerts and scheduled viewings.",
      profileTitle: "My space",
      profileSubtitle: "Your saved listings, your alerts and your viewings.",
      settingsSubtitle: "Manage your contact details and search alerts.",
    },
  },
  events: {
    fr: {
      loginSubtitle: "Connecte-toi pour retrouver tes billets.",
      loginCta: "Voir mes billets",
      loginBenefit: "Tes billets, tes inscriptions et le programme, toujours à portée.",
      profileTitle: "Mon espace",
      profileSubtitle: "Tes billets, tes inscriptions et tes événements.",
      settingsSubtitle: "Gère tes informations et tes préférences d'événements.",
    },
    en: {
      loginSubtitle: "Sign in to find your tickets.",
      loginCta: "View my tickets",
      loginBenefit: "Your tickets, registrations and the programme, always at hand.",
      profileTitle: "My space",
      profileSubtitle: "Your tickets, your registrations and your events.",
      settingsSubtitle: "Manage your details and your event preferences.",
    },
  },
  services: {
    fr: {
      loginSubtitle: "Connecte-toi pour accéder à ton espace client.",
      loginCta: "Accéder à mon espace",
      loginBenefit: "Tes demandes, tes documents et l'historique de nos échanges.",
      profileTitle: "Mon espace client",
      profileSubtitle: "Tes demandes en cours et tes documents.",
      settingsSubtitle: "Gère tes informations et l'apparence du site.",
    },
    en: {
      loginSubtitle: "Sign in to reach your client area.",
      loginCta: "Go to my client area",
      loginBenefit: "Your requests, your documents and the history of our exchanges.",
      profileTitle: "My client area",
      profileSubtitle: "Your open requests and your documents.",
      settingsSubtitle: "Manage your details and the site's appearance.",
    },
  },
};

/** Inscription: même logique, formulée pour un NOUVEAU visiteur. */
const SECTOR_SIGNUP: Record<Sector, { fr: { sub: string; cta: string }; en: { sub: string; cta: string } }> = {
  shop: {
    fr: { sub: "Crée ton compte pour commander et suivre tes livraisons.", cta: "Créer mon compte client" },
    en: { sub: "Create your account to order and track deliveries.", cta: "Create my account" },
  },
  food: {
    fr: { sub: "Crée ton compte pour réserver et commander plus vite.", cta: "Créer mon compte" },
    en: { sub: "Create your account to book and order faster.", cta: "Create my account" },
  },
  booking: {
    fr: { sub: "Crée ton compte pour prendre rendez-vous en deux clics.", cta: "Créer mon compte" },
    en: { sub: "Create your account to book in two clicks.", cta: "Create my account" },
  },
  saas: {
    fr: { sub: "Crée ton espace de travail en quelques secondes.", cta: "Créer mon espace" },
    en: { sub: "Set up your workspace in seconds.", cta: "Create my workspace" },
  },
  learn: {
    fr: { sub: "Crée ton compte pour commencer ta formation.", cta: "Commencer ma formation" },
    en: { sub: "Create your account and start learning.", cta: "Start learning" },
  },
  health: {
    fr: { sub: "Crée ton espace personnel, confidentiel et sécurisé.", cta: "Créer mon espace" },
    en: { sub: "Create your private, secure personal space.", cta: "Create my space" },
  },
  realestate: {
    fr: { sub: "Crée ton compte pour sauvegarder tes biens et tes alertes.", cta: "Créer mon compte" },
    en: { sub: "Create your account to save listings and alerts.", cta: "Create my account" },
  },
  events: {
    fr: { sub: "Crée ton compte pour réserver tes billets.", cta: "Créer mon compte" },
    en: { sub: "Create your account to book your tickets.", cta: "Create my account" },
  },
  services: {
    fr: { sub: "Crée ton compte pour suivre tes demandes.", cta: "Créer mon compte" },
    en: { sub: "Create your account to follow your requests.", cta: "Create my account" },
  },
};

/** Repli DÉTERMINISTE: jamais vide, jamais générique — nom d'entreprise +
 *  secteur + langue. C'est déjà suffisant pour que deux projets différents
 *  aient des pages de compte différentes, même si l'IA ne renvoie rien. */
export function defaultAuthCopy(meta: AuthPageMeta): AuthCopy {
  const fr = (meta.lang || "fr") !== "en";
  const co = (meta.companyName || "").trim() || (fr ? "notre équipe" : "our team");
  const sector = detectAuthSector(meta);
  const s = SECTOR_COPY[sector][fr ? "fr" : "en"];
  const g = SECTOR_SIGNUP[sector][fr ? "fr" : "en"];
  return {
    loginTitle: fr ? `Connexion à ${co}` : `Sign in to ${co}`,
    loginSubtitle: s.loginSubtitle,
    loginCta: s.loginCta,
    loginBenefit: (meta.tagline || "").trim() ? `${(meta.tagline || "").trim()} — ${s.loginBenefit}` : s.loginBenefit,
    signupTitle: fr ? `Rejoindre ${co}` : `Join ${co}`,
    signupSubtitle: g.sub,
    signupCta: g.cta,
    profileTitle: s.profileTitle,
    profileSubtitle: s.profileSubtitle,
    settingsTitle: fr ? "Réglages" : "Settings",
    settingsSubtitle: s.settingsSubtitle,
  };
}

const MAX_LEN: Record<keyof AuthCopy, number> = {
  loginTitle: 70,
  loginSubtitle: 140,
  loginCta: 34,
  loginBenefit: 180,
  signupTitle: 70,
  signupSubtitle: 140,
  signupCta: 34,
  profileTitle: 48,
  profileSubtitle: 140,
  settingsTitle: 40,
  settingsSubtitle: 140,
};

/** Refuse les valeurs inutilisables renvoyées par l'IA (vides, placeholders,
 *  « ... », trop longues, JSON échappé) pour ne jamais dégrader la page. */
function usable(key: keyof AuthCopy, v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (t.length < 2 || t.length > MAX_LEN[key]) return false;
  if (/^[.…\-–—]+$/.test(t)) return false;
  if (/^(string|texte?|title|titre|todo|lorem|n\/?a|null|undefined)$/i.test(t)) return false;
  if (/[{}<>]|\\n/.test(t)) return false;
  return true;
}

/** Copy finale = ce que l'IA de design a écrit pour CE projet, par-dessus le
 *  repli sectoriel. Champ par champ: un champ IA invalide ne fait pas perdre
 *  les autres. */
export function resolveAuthCopy(meta: AuthPageMeta): AuthCopy {
  const base = defaultAuthCopy(meta);
  const ai = meta.authCopy || {};
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof AuthCopy)[]) {
    const v = (ai as Record<string, unknown>)[key];
    if (usable(key, v)) out[key] = v.trim();
  }
  return out;
}

/** Gabarit des pages de compte: celui choisi par l'IA s'il est valide, sinon un
 *  hash stable du projet (deux projets ≠ gabarits ≠, même projet = stable). */
export function pickAuthLayout(meta: AuthPageMeta): AuthLayout {
  const asked = (meta.authLayout || "").trim().toLowerCase();
  if ((AUTH_LAYOUTS as string[]).includes(asked)) return asked as AuthLayout;
  const seed = `auth|${meta.companyName || ""}|${meta.slug || ""}|${meta.idea || ""}`;
  return AUTH_LAYOUTS[stableHash(seed) % AUTH_LAYOUTS.length];
}

// ─── Libellés de formulaire (non-IA: purement fonctionnels, FR/EN) ───────────
function labels(fr: boolean) {
  return {
    email: "E-mail",
    password: fr ? "Mot de passe" : "Password",
    name: fr ? "Nom" : "Name",
    invalid: fr ? "Identifiants invalides" : "Invalid credentials",
    noAccount: fr ? "Pas encore de compte ?" : "No account yet?",
    createAccount: fr ? "Créer un compte" : "Create an account",
    memberSince: fr ? "Membre depuis" : "Member since",
    settings: fr ? "Réglages" : "Settings",
    logout: fr ? "Se déconnecter" : "Sign out",
    profileSection: fr ? "Profil" : "Profile",
    save: fr ? "Enregistrer" : "Save",
    saved: fr ? "Enregistré" : "Saved",
    appearance: fr ? "Apparence" : "Appearance",
    appearanceHint: fr ? "Choisis ton thème." : "Pick your theme.",
    light: fr ? "Clair" : "Light",
    dark: fr ? "Sombre" : "Dark",
    backHome: fr ? "Retour à l'accueil" : "Back to home",
  };
}

const J = (s: string) => JSON.stringify(s);

const INPUT_CLS =
  "mt-1 w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2 text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-brand";
const INPUT_CLS_MINIMAL =
  "mt-1 w-full border-0 border-b border-gray-200 dark:border-white/15 bg-transparent px-0 py-2 text-lg text-gray-900 dark:text-white outline-none focus:border-brand focus:ring-0";

/** Bloc marque réutilisé par le gabarit « split » (logo + nom + bénéfice). */
function brandPanel(meta: AuthPageMeta, copy: AuthCopy): string {
  const logo = meta.logoUrl
    ? `          <img src=${J(meta.logoUrl)} alt=${J(meta.companyName)} className="h-10 w-auto object-contain brightness-0 invert" />\n`
    : "";
  return `      <div className="relative hidden lg:flex flex-col justify-between bg-gradient-to-br from-brand to-accent p-12 text-white">
        <div className="flex items-center gap-3">
${logo}          <span className="text-lg font-semibold tracking-tight">${meta.companyName}</span>
        </div>
        <div>
          <p className="text-3xl font-bold leading-tight tracking-tight">${copy.loginSubtitle}</p>
          <p className="mt-4 max-w-sm text-white/80">${copy.loginBenefit}</p>
        </div>
        <div className="h-px w-16 bg-white/40" />
      </div>`;
}

// ─── Login ───────────────────────────────────────────────────────────────────
export function loginPageTsx(meta: AuthPageMeta): string {
  const fr = (meta.lang || "fr") !== "en";
  const t = labels(fr);
  const copy = resolveAuthCopy(meta);
  const layout = pickAuthLayout(meta);

  const head = `import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogIn, Loader2 } from "lucide-react";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try { await login(email, password); navigate("/profile"); }
    catch (err: any) { setError(err?.message || ${J(t.invalid)}); }
    finally { setBusy(false); }
  };
`;

  const form = (inputCls: string, btnCls: string) => `          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">${t.email}</label>
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="${inputCls}" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">${t.password}</label>
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
                className="${inputCls}" />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button type="submit" disabled={busy}
              className="${btnCls}">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} ${copy.loginCta}
            </button>
          </form>
          <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
            ${t.noAccount} <Link to="/signup" className="font-semibold text-brand hover:underline">${t.createAccount}</Link>
          </p>`;

  if (layout === "split") {
    return `${head}
  return (
    <div className="grid min-h-[80vh] lg:grid-cols-2">
${brandPanel(meta, copy)}
      <div className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">${copy.loginTitle}</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 lg:hidden">${copy.loginSubtitle}</p>
${form(INPUT_CLS, "w-full inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:opacity-90 transition disabled:opacity-60")}
        </div>
      </div>
    </div>
  );
}
`;
  }

  if (layout === "minimal") {
    const logo = meta.logoUrl
      ? `          <img src=${J(meta.logoUrl)} alt=${J(meta.companyName)} className="h-9 w-auto object-contain" />\n`
      : "";
    return `${head}
  return (
    <div className="mx-auto flex min-h-[80vh] max-w-lg flex-col justify-center px-6 py-20">
      <div className="mb-10">
${logo}        <p className="mt-6 text-xs uppercase tracking-[0.2em] text-brand">${meta.companyName}</p>
        <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight text-gray-900 dark:text-white">${copy.loginTitle}</h1>
        <p className="mt-3 text-gray-500 dark:text-gray-400">${copy.loginSubtitle}</p>
      </div>
      <div>
${form(INPUT_CLS_MINIMAL, "mt-2 w-full inline-flex items-center justify-center gap-2 rounded-full bg-brand px-6 py-3 font-semibold text-white hover:opacity-90 transition disabled:opacity-60")}
      </div>
      <p className="mt-10 text-xs text-gray-400 dark:text-gray-500">${copy.loginBenefit}</p>
    </div>
  );
}
`;
  }

  // layout === "card"
  const logo = meta.logoUrl
    ? `          <img src=${J(meta.logoUrl)} alt=${J(meta.companyName)} className="mb-5 h-10 w-auto object-contain" />\n`
    : "";
  return `${head}
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-white/5 rounded-2xl shadow-xl border border-gray-100 dark:border-white/10 p-8">
${logo}          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">${copy.loginTitle}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">${copy.loginSubtitle}</p>
${form(INPUT_CLS, "w-full inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:opacity-90 transition disabled:opacity-60")}
        </div>
        <p className="mt-4 text-center text-xs text-gray-400 dark:text-gray-500">${copy.loginBenefit}</p>
      </div>
    </div>
  );
}
`;
}

// ─── Signup ──────────────────────────────────────────────────────────────────
// Même gabarit que Login (sinon /login et /signup n'auraient pas l'air du même
// site). Le consentement RGPD explicite (checkbox + liens Confidentialité/CGU)
// est conservé tel quel: il est obligatoire, il ne dépend pas du gabarit.
export function signupPageTsx(meta: AuthPageMeta): string {
  const fr = (meta.lang || "fr") !== "en";
  const t = labels(fr);
  const copy = resolveAuthCopy(meta);
  const layout = pickAuthLayout(meta);
  const s = {
    fail: fr ? "Inscription impossible" : "Sign up failed",
    mustAccept: fr
      ? "Vous devez accepter la Politique de confidentialité et les Conditions d'utilisation."
      : "You must accept the Privacy Policy and Terms of Service.",
    accept: fr ? "J'accepte la" : "I agree to the",
    privacy: fr ? "Politique de confidentialité" : "Privacy Policy",
    and: fr ? "et les" : "and the",
    terms: fr ? "Conditions d'utilisation" : "Terms of Service",
    have: fr ? "Déjà inscrit ?" : "Already have an account?",
    signin: fr ? "Se connecter" : "Sign in",
  };

  const head = `import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { UserPlus, Loader2 } from "lucide-react";
import { useAuth } from "../lib/auth";

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accepted) { setError(${J(s.mustAccept)}); return; }
    setError(""); setBusy(true);
    try { await signup(name, email, password); navigate("/profile"); }
    catch (err: any) { setError(err?.message || ${J(s.fail)}); }
    finally { setBusy(false); }
  };
`;

  const form = (inputCls: string, btnCls: string) => `          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">${t.name}</label>
              <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
                className="${inputCls}" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">${t.email}</label>
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="${inputCls}" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">${t.password}</label>
              <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
                className="${inputCls}" />
            </div>
            <label className="flex items-start gap-2.5 text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 dark:border-white/20 text-brand focus:ring-brand accent-[color:var(--brand,#4f46e5)]" />
              <span>${s.accept} <Link to="/privacy" target="_blank" className="font-medium text-brand hover:underline">${s.privacy}</Link> ${s.and} <Link to="/terms" target="_blank" className="font-medium text-brand hover:underline">${s.terms}</Link>.</span>
            </label>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button type="submit" disabled={busy || !accepted}
              className="${btnCls}">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} ${copy.signupCta}
            </button>
          </form>
          <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
            ${s.have} <Link to="/login" className="font-semibold text-brand hover:underline">${s.signin}</Link>
          </p>`;

  if (layout === "split") {
    return `${head}
  return (
    <div className="grid min-h-[80vh] lg:grid-cols-2">
${brandPanel(meta, copy)}
      <div className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">${copy.signupTitle}</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">${copy.signupSubtitle}</p>
${form(INPUT_CLS, "w-full inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed")}
        </div>
      </div>
    </div>
  );
}
`;
  }

  if (layout === "minimal") {
    const logo = meta.logoUrl
      ? `        <img src=${J(meta.logoUrl)} alt=${J(meta.companyName)} className="h-9 w-auto object-contain" />\n`
      : "";
    return `${head}
  return (
    <div className="mx-auto flex min-h-[80vh] max-w-lg flex-col justify-center px-6 py-20">
      <div className="mb-8">
${logo}        <p className="mt-6 text-xs uppercase tracking-[0.2em] text-brand">${meta.companyName}</p>
        <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight text-gray-900 dark:text-white">${copy.signupTitle}</h1>
        <p className="mt-3 text-gray-500 dark:text-gray-400">${copy.signupSubtitle}</p>
      </div>
      <div>
${form(INPUT_CLS_MINIMAL, "mt-2 w-full inline-flex items-center justify-center gap-2 rounded-full bg-brand px-6 py-3 font-semibold text-white hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed")}
      </div>
    </div>
  );
}
`;
  }

  // layout === "card"
  const logo = meta.logoUrl
    ? `          <img src=${J(meta.logoUrl)} alt=${J(meta.companyName)} className="mb-5 h-10 w-auto object-contain" />\n`
    : "";
  return `${head}
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-white/5 rounded-2xl shadow-xl border border-gray-100 dark:border-white/10 p-8">
${logo}          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">${copy.signupTitle}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">${copy.signupSubtitle}</p>
${form(INPUT_CLS, "w-full inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed")}
        </div>
      </div>
    </div>
  );
}
`;
}

// ─── Profile ─────────────────────────────────────────────────────────────────
export function profilePageTsx(meta: AuthPageMeta): string {
  const fr = (meta.lang || "fr") !== "en";
  const t = labels(fr);
  const copy = resolveAuthCopy(meta);
  const layout = pickAuthLayout(meta);
  const locale = fr ? "fr-FR" : "en-US";

  const head = `import { User, Mail, Calendar, LogOut, Settings as SettingsIcon } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function Profile() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;

  const initials = user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const memberSince = new Date(user.createdAt).toLocaleDateString(${J(locale)}, { year: "numeric", month: "long" });
  const handleLogout = async () => { await logout(); navigate("/"); };
`;

  const rows = (pad: string) => `${pad}<div className="flex items-center gap-3 rounded-xl bg-gray-50 dark:bg-white/5 px-4 py-3">
${pad}  <User className="h-5 w-5 text-brand" />
${pad}  <div><p className="text-xs text-gray-500 dark:text-gray-400">${t.name}</p><p className="font-medium text-gray-900 dark:text-white">{user.name}</p></div>
${pad}</div>
${pad}<div className="flex items-center gap-3 rounded-xl bg-gray-50 dark:bg-white/5 px-4 py-3">
${pad}  <Mail className="h-5 w-5 text-brand" />
${pad}  <div><p className="text-xs text-gray-500 dark:text-gray-400">${t.email}</p><p className="font-medium text-gray-900 dark:text-white">{user.email}</p></div>
${pad}</div>
${pad}<div className="flex items-center gap-3 rounded-xl bg-gray-50 dark:bg-white/5 px-4 py-3">
${pad}  <Calendar className="h-5 w-5 text-brand" />
${pad}  <div><p className="text-xs text-gray-500 dark:text-gray-400">${t.memberSince}</p><p className="font-medium text-gray-900 dark:text-white">{memberSince}</p></div>
${pad}</div>`;

  const actions = (pad: string) => `${pad}<Link to="/settings" className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 px-4 py-2 font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 transition">
${pad}  <SettingsIcon className="h-4 w-4" /> ${t.settings}
${pad}</Link>
${pad}<button onClick={handleLogout} className="inline-flex items-center gap-2 rounded-lg bg-red-50 dark:bg-red-500/10 px-4 py-2 font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 transition">
${pad}  <LogOut className="h-4 w-4" /> ${t.logout}
${pad}</button>`;

  if (layout === "split") {
    return `${head}
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">${copy.profileTitle}</h1>
      <p className="mt-1 text-gray-500 dark:text-gray-400">${copy.profileSubtitle}</p>
      <div className="mt-10 grid gap-8 md:grid-cols-[260px_1fr]">
        <aside className="rounded-2xl border border-gray-100 dark:border-white/10 bg-white dark:bg-white/5 p-6 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-accent text-xl font-bold text-white">
            {initials}
          </div>
          <p className="mt-4 font-semibold text-gray-900 dark:text-white">{user.name}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 break-all">{user.email}</p>
          <div className="mt-6 flex flex-col gap-3">
${actions("            ")}
          </div>
        </aside>
        <div className="space-y-3">
${rows("          ")}
        </div>
      </div>
    </div>
  );
}
`;
  }

  if (layout === "minimal") {
    return `${head}
  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <p className="text-xs uppercase tracking-[0.2em] text-brand">${meta.companyName}</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight text-gray-900 dark:text-white">${copy.profileTitle}</h1>
      <p className="mt-2 text-gray-500 dark:text-gray-400">${copy.profileSubtitle}</p>

      <div className="mt-12 divide-y divide-gray-100 dark:divide-white/10 border-y border-gray-100 dark:border-white/10">
        <div className="flex items-center justify-between py-4">
          <span className="text-sm text-gray-500 dark:text-gray-400">${t.name}</span>
          <span className="font-medium text-gray-900 dark:text-white">{user.name}</span>
        </div>
        <div className="flex items-center justify-between py-4">
          <span className="text-sm text-gray-500 dark:text-gray-400">${t.email}</span>
          <span className="font-medium text-gray-900 dark:text-white break-all">{user.email}</span>
        </div>
        <div className="flex items-center justify-between py-4">
          <span className="text-sm text-gray-500 dark:text-gray-400">${t.memberSince}</span>
          <span className="font-medium text-gray-900 dark:text-white">{memberSince}</span>
        </div>
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
${actions("        ")}
      </div>
    </div>
  );
}
`;
  }

  // layout === "card"
  return `${head}
  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <div className="bg-white dark:bg-white/5 rounded-2xl shadow-sm border border-gray-100 dark:border-white/10 overflow-hidden">
        <div className="h-28 bg-gradient-to-r from-brand to-accent" />
        <div className="px-8 pb-8">
          <div className="-mt-12 flex items-end gap-4">
            <div className="h-24 w-24 rounded-full bg-gradient-to-br from-brand to-accent flex items-center justify-center text-2xl font-bold text-white ring-4 ring-white dark:ring-[#0b0f19]">
              {initials}
            </div>
            <div className="pb-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{user.name}</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">{user.email}</p>
            </div>
          </div>

          <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">${copy.profileSubtitle}</p>

          <div className="mt-6 space-y-3">
${rows("            ")}
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
${actions("            ")}
          </div>
        </div>
      </div>
    </div>
  );
}
`;
}

// ─── Settings ────────────────────────────────────────────────────────────────
export function settingsPageTsx(meta: AuthPageMeta): string {
  const fr = (meta.lang || "fr") !== "en";
  const t = labels(fr);
  const copy = resolveAuthCopy(meta);
  const layout = pickAuthLayout(meta);
  const inputCls = layout === "minimal" ? INPUT_CLS_MINIMAL : INPUT_CLS;
  const sectionCls =
    layout === "minimal"
      ? "mt-10 border-t border-gray-100 dark:border-white/10 pt-8"
      : "mt-8 bg-white dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-white/10 p-6";
  const sectionCls2 =
    layout === "minimal"
      ? "mt-10 border-t border-gray-100 dark:border-white/10 pt-8"
      : "mt-6 bg-white dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-white/10 p-6";
  const btnCls =
    layout === "minimal"
      ? "inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 font-semibold text-white hover:opacity-90 transition disabled:opacity-60"
      : "inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:opacity-90 transition disabled:opacity-60";

  const header =
    layout === "minimal"
      ? `      <p className="text-xs uppercase tracking-[0.2em] text-brand">${meta.companyName}</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight text-gray-900 dark:text-white">${copy.settingsTitle}</h1>
      <p className="mt-2 text-gray-500 dark:text-gray-400">${copy.settingsSubtitle}</p>`
      : `      <h1 className="text-3xl font-bold text-gray-900 dark:text-white">${copy.settingsTitle}</h1>
      <p className="mt-1 text-gray-500 dark:text-gray-400">${copy.settingsSubtitle}</p>`;

  return `import { useState } from "react";
import { Save, Loader2, Moon, Sun } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";

export default function Settings() {
  const { user, updateProfile } = useAuth();
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setSaved(false);
    try { await updateProfile({ name, email }); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
${header}

      <section className="${sectionCls}">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">${t.profileSection}</h2>
        <form onSubmit={save} className="mt-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">${t.name}</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="${inputCls}" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">${t.email}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="${inputCls}" />
          </div>
          <button type="submit" disabled={busy}
            className="${btnCls}">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} ${t.save}
          </button>
          {saved && <span className="ml-3 text-sm text-green-600 dark:text-green-400">✓ ${t.saved}</span>}
        </form>
      </section>

      <section className="${sectionCls2}">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">${t.appearance}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">${t.appearanceHint}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 max-w-xs">
          <button onClick={() => setTheme("light")}
            className={"flex items-center justify-center gap-2 rounded-lg border px-4 py-3 font-medium transition " + (theme === "light" ? "border-brand bg-brand/10 text-brand" : "border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300")}>
            <Sun className="h-4 w-4" /> ${t.light}
          </button>
          <button onClick={() => setTheme("dark")}
            className={"flex items-center justify-center gap-2 rounded-lg border px-4 py-3 font-medium transition " + (theme === "dark" ? "border-brand bg-brand/10 text-brand" : "border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300")}>
            <Moon className="h-4 w-4" /> ${t.dark}
          </button>
        </div>
      </section>
    </div>
  );
}
`;
}
