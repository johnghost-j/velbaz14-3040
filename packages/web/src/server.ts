import app from "./api";
import { DOCUMENT_SECURITY_HEADERS } from "./api/security";
import { isDecoyPath } from "./api/honeypot";
import { subdomainForHost, siteHostFromHeaders } from "./api/domains";
import { seoResponse } from "./seo/render";
import { pingMainSite } from "./seo/indexnow";

const port = Number(process.env.PORT ?? 3000);
const distDir = `${import.meta.dir}/../dist`;
const indexPath = `${distDir}/index.html`;

// Applique les en-têtes de sécurité (CSP, X-Frame-Options, HSTS…) sur toute
// réponse statique/HTML servie par ce process (le site Velbaz lui-même).
function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(DOCUMENT_SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const server = Bun.serve({
  port,
  // Les réponses de chat sont en STREAMING et un appel IA peut prendre >10s
  // (analyse, clone de site, équipe d'agents). Bun.serve coupe par défaut toute
  // requête « idle » après 10s → le stream mourait avant la 1re réponse et le
  // chargement « Structuration de la réponse » tournait à l'infini. On pousse le
  // timeout d'inactivité au maximum autorisé par Bun (255s).
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return app.fetch(request);
    }

    // Chemins de sondage demandés à la RACINE (/.env, /wp-login.php,
    // /backup.zip, /.git/config…). Sans ça, le repli SPA plus bas leur
    // répondrait 200 + index.html : un scanner en déduit « serveur vivant,
    // continue ». On les renvoie au middleware de leurres monté sur /api, qui
    // sert un faux contenu piégé (canaris) et bannit l'IP au 3e essai.
    if (isDecoyPath(url.pathname)) {
      const decoyUrl = new URL(request.url);
      decoyUrl.pathname = "/api" + url.pathname;
      return app.fetch(new Request(decoyUrl.toString(), request));
    }

    // Sites publiés servis sur une URL propre : /s/:subdomain → API interne.
    // (Permet un lien "publish" lisible sans /api.)
    if (url.pathname === "/s" || url.pathname.startsWith("/s/")) {
      const apiUrl = new URL(request.url);
      apiUrl.pathname = "/api" + url.pathname;
      return app.fetch(new Request(apiUrl.toString(), request));
    }

    // Domaine personnalisé / sous-domaine client : l'hôte entrant décide quel
    // site servir. example.com (raccordé + publié) sert le site du client, pas
    // l'application Velbaz. Résolution réelle en base, cache 30s.
    // Renvoie null pour l'app elle-même (localhost, velbaz.site, previews).
    // Derrière le Worker Cloudflare des domaines clients, l'hôte d'origine
    // arrive dans x-velbaz-site-host (signé par VELBAZ_EDGE_SECRET).
    const siteSub = await subdomainForHost(
      siteHostFromHeaders((n) => request.headers.get(n)),
    ).catch(() => null);
    if (siteSub) {
      const siteUrl = new URL(request.url);
      siteUrl.pathname = `/api/s/${siteSub}${url.pathname === "/" ? "" : url.pathname}`;
      return app.fetch(new Request(siteUrl.toString(), request));
    }

    // Retour Stripe égaré sur l'hôte Velbaz (anciens liens de paiement) :
    // /success?session_id=cs_… → page de remerciement du bon site généré.
    if (url.pathname === "/success" && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(url.searchParams.get("session_id") || "")) {
      return Response.redirect(new URL(`/api/checkout/return?session_id=${encodeURIComponent(url.searchParams.get("session_id")!)}`, url).toString(), 302);
    }

    // Pages SEO/GEO, llms.txt et sitemap.xml : rendus ici en HTML/texte complet.
    // Obligatoire AVANT le repli SPA plus bas — les robots des assistants IA
    // (GPTBot, PerplexityBot, ClaudeBot) n'exécutent pas le JavaScript, donc
    // index.html leur apparaîtrait comme une page vide.
    const seo = seoResponse(url.pathname);
    if (seo) {
      return withSecurityHeaders(new Response(seo.body, {
        headers: {
          "Content-Type": seo.contentType,
          "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
        },
      }));
    }

    const filePath = getStaticFilePath(url.pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      const res = withSecurityHeaders(new Response(file));
      // [2026-09-22] Scaling 10k+ : les fichiers sous /assets/ sont hashés par
      // Vite (nom change à chaque build) — cache navigateur/CDN agressif et
      // sûr : une nouvelle version a forcément un nouveau nom de fichier.
      // Coupe une part significative du trafic répétitif (JS/CSS/images) sous
      // forte charge concurrente sans jamais servir un asset périmé.
      if (url.pathname.startsWith("/assets/")) {
        res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      }
      return res;
    }

    const index = Bun.file(indexPath);
    if (await index.exists()) {
      return withSecurityHeaders(new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }));
    }

    return withSecurityHeaders(new Response("Build output not found. Run `bun run build` first.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));
  },
});

console.log(`Web server listening on http://localhost:${server.port}`);

// Annonce les pages SEO à Bing/Yandex au démarrage (IndexNow). Sans Search
// Console, c'est le seul moyen automatisable de signaler une nouvelle URL ;
// l'appel est ignoré en local (hôte non public) et n'échoue jamais bruyamment.
pingMainSite()
  .then((r) => {
    if (r.submitted) console.log(`[seo] IndexNow: ${r.urls} URLs soumises (${r.status})`);
    else if (r.reason !== "non_public_host") console.log(`[seo] IndexNow ignoré: ${r.reason || r.status}`);
  })
  .catch(() => {});

function getStaticFilePath(pathname: string) {
  const cleanPath = decodeURIComponent(pathname)
    .replace(/^\/+/, "")
    .replaceAll("..", "");

  return cleanPath ? `${distDir}/${cleanPath}` : indexPath;
}
