// ─── IndexNow pour le site Velbaz lui-même ─────────────────────────────────
//
// Johne n'a pas de Google Search Console (validation manuelle par un humain,
// impossible à automatiser). IndexNow est l'inverse : protocole ouvert, aucun
// compte, une simple requête HTTP suffit pour dire « ces URLs sont nouvelles,
// venez les lire ». Il alimente Bing, Yandex, Seznam et Naver.
//
// Pourquoi ça compte ici plus qu'ailleurs : la recherche web de ChatGPT et de
// Copilot s'appuie sur l'index de BING. Être dans Bing n'est donc pas un
// détail pour un moteur secondaire — c'est la condition pour être cité par un
// assistant. Google, lui, finira par crawler seul via robots.txt + sitemap.
//
// Le protocole exige de prouver qu'on contrôle le domaine en servant la clé à
// `https://<host>/<clé>.txt`. La clé est dérivée d'un secret serveur : stable
// entre deux redémarrages (sinon les moteurs ne la retrouvent plus) et non
// devinable (sinon n'importe qui soumettrait des URLs au nom du site).

import { indexNowKey, submitToIndexNow } from "../api/seo/discovery";
import { FACTS, SEO_LANGS, SEO_PATHS } from "./content";

const SECRET =
  process.env.AUTH_SECRET || process.env.VELBAZ_DEPLOY_TOKEN || "velbaz-fallback";

/** Clé IndexNow du site principal (≠ clés des sites publiés par les clients). */
export function mainSiteIndexNowKey(): string {
  return indexNowKey("__velbaz_main_site__", SECRET);
}

/** Chemin où les moteurs viennent vérifier la clé. */
export function mainSiteKeyPath(): string {
  return `/${mainSiteIndexNowKey()}.txt`;
}

/**
 * Annonce les pages SEO aux moteurs. Ne lève jamais et n'attend rien : un
 * échec réseau ne doit pas empêcher le serveur de démarrer.
 * `submitToIndexNow` écarte lui-même les hôtes non publics (localhost, etc.).
 */
export async function pingMainSite(origin = `https://${FACTS.domain}`) {
  const urls = [`${origin}/`, ...SEO_LANGS.map((l) => `${origin}${SEO_PATHS[l]}`)];
  return submitToIndexNow(origin, urls, mainSiteIndexNowKey());
}
