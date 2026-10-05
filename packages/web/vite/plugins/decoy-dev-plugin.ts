import type { Plugin, ViteDevServer } from "vite";

/**
 * Sert les leurres (« fausses pistes ») en développement EXACTEMENT comme en
 * production.
 *
 * En production, src/server.ts intercepte les chemins de scan connus
 * (/.env, /wp-login.php, /.git/config, /backup.sql…) demandés à la RACINE —
 * donc hors /api — et les renvoie dans le pipeline honeypot de l'API.
 * Sans ce plugin, en local ces chemins tombent sur le repli SPA de Vite qui
 * répond 200 + index.html : impossible de vérifier que les leurres et le
 * bannissement automatique fonctionnent vraiment avant un déploiement.
 *
 * La logique n'est pas dupliquée : `isDecoyPath()` est le même module que celui
 * utilisé par src/server.ts et par le middleware honeypot de l'API, et la
 * réponse est produite par l'API elle-même (on réécrit juste l'URL vers /api).
 */
export default function decoyDevPlugin(): Plugin {
  return {
    name: "velbaz-decoy-dev",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || req.url.startsWith("/api")) return next();
        const pathname = req.url.split("?")[0];

        let isDecoy = false;
        try {
          const mod = await server.ssrLoadModule("/src/api/honeypot.ts");
          isDecoy = mod.isDecoyPath(pathname);
        } catch (err) {
          console.error("[decoy-dev]", err);
          return next();
        }
        if (!isDecoy) return next();

        try {
          const app = await loadApp(server);
          const url = new URL(req.url, `http://${req.headers.host}`);
          url.pathname = "/api" + url.pathname;
          const headers = new Headers();
          for (const [key, val] of Object.entries(req.headers)) {
            if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
          }
          const response = await app.fetch(
            new Request(url, { method: req.method, headers }),
          );
          res.statusCode = response.status;
          response.headers.forEach((value: string, key: string) => {
            if (key.toLowerCase() !== "set-cookie") res.setHeader(key, value);
          });
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          console.error("[decoy-dev]", err);
          res.statusCode = 404;
          res.end("Not Found");
        }
      });
    },
  };
}

async function loadApp(server: ViteDevServer) {
  const mod = await server.ssrLoadModule("/src/api/index.ts");
  return mod.default;
}
