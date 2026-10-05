import type { Plugin, ViteDevServer } from "vite";

/**
 * Routage par nom d'hôte, en DEV.
 *
 * Parité avec `src/server.ts` (serveur de production) : un domaine client
 * raccordé — ou un sous-domaine `*.velbaz.site` — doit servir le SITE PUBLIÉ
 * correspondant, pas l'application Velbaz. Et `/s/:subdomain` doit rester
 * accessible en clair (hébergement interne).
 *
 * Pourquoi un plugin séparé : `vite/__plugins/hono-dev-plugin.ts` est
 * template-managed (préfixe `__`, vérifié par `bun run lint`), donc INTERDIT à
 * la modification. Ce plugin est monté AVANT lui et avant `api-stream-plugin`
 * dans `vite.config.ts` : il ne fait que RÉÉCRIRE `req.url` vers la route API
 * interne, puis passe la main. Le transport (streaming inclus) reste géré par
 * les plugins suivants.
 *
 * Résolution réelle en base (cache 30 s dans `api/domains.ts`) ; `null` =
 * application Velbaz (localhost, hôtes d'aperçu Runable, velbaz.site).
 */
export default function customDomainPlugin(): Plugin {
  return {
    name: "custom-domain-host-routing",
    configureServer(server) {
      server.middlewares.use(async (req, _res, next) => {
        const url = req.url;
        if (!url || url.startsWith("/api")) return next();

        // Site publié servi sur une URL propre : /s/:subdomain → API interne.
        if (url === "/s" || url.startsWith("/s/")) {
          req.url = "/api" + url;
          return next();
        }

        try {
          const mod = await server.ssrLoadModule("/src/api/domains.ts");
          // Même règle que src/server.ts : x-velbaz-site-host (Worker signé) d'abord.
          const rawHost: string = mod.siteHostFromHeaders((n: string) => {
            const v = req.headers[n.toLowerCase()];
            return Array.isArray(v) ? v[0] : (v as string | undefined);
          });
          const sub = rawHost ? await resolveHost(server, rawHost) : null;
          if (sub) req.url = `/api/s/${sub}${url === "/" ? "" : url}`;
        } catch (err) {
          console.error("[custom-domain] résolution d'hôte échouée :", err);
        }

        return next();
      });
    },
  };
}

/** Sous-domaine du site publié derrière cet hôte, ou null (app Velbaz). */
async function resolveHost(server: ViteDevServer, rawHost: string): Promise<string | null> {
  const mod = await server.ssrLoadModule("/src/api/domains.ts");
  return mod.subdomainForHost(rawHost);
}
