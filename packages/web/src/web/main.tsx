// Bootstrap du template — les providers globaux sont dans components/provider.tsx
// et les routes dans app.tsx.
//
// Importé en PREMIER : bloque les rechargements complets automatiques du client
// HMR de Vite (voir lib/no-auto-reload.ts). L'app ne s'actualise plus toute
// seule ; en production ce module est inerte.
import "./lib/no-auto-reload";
// Retour Stripe égaré sur l'hôte Velbaz (/success?session_id=cs_…) : on
// renvoie AVANT tout rendu vers la page de remerciement du bon site généré.
import "./lib/checkout-return-redirect";
import "./__main";
