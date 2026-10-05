import type { Plugin } from "vite";
import { seoResponse } from "../../src/seo/render";

/**
 * Sert les pages SEO/GEO en développement EXACTEMENT comme en production.
 *
 * Sans ce plugin, tout chemin hors /api tombe sur le middleware SPA de Vite,
 * qui renvoie index.html : impossible de vérifier en local que la page existe
 * vraiment côté serveur. Or c'est précisément ce qu'il faut pouvoir tester —
 * un robot d'IA ne reçoit que ce HTML.
 *
 * Le routage lui-même n'est pas dupliqué : `seoResponse()` est le même module
 * que celui utilisé par src/server.ts.
 */
export default function seoDevPlugin(): Plugin {
  return {
    name: "velbaz-seo-dev",
    configureServer(server) {
      // Enregistré dans configureServer → s'exécute AVANT les middlewares
      // internes de Vite (dont le repli SPA et les fichiers de public/).
      server.middlewares.use((req, res, next) => {
        if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) return next();
        const pathname = req.url.split("?")[0];
        let hit;
        try {
          hit = seoResponse(pathname);
        } catch (err) {
          console.error("[seo-dev]", err);
          return next();
        }
        if (!hit) return next();
        res.statusCode = 200;
        res.setHeader("Content-Type", hit.contentType);
        res.setHeader("Cache-Control", "public, max-age=300");
        res.end(req.method === "HEAD" ? undefined : hit.body);
      });
    },
  };
}
