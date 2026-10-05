# Favicons des sites générés : logo carré, plus étiré (2026-10-04)

- Demande : « les images icônes en haut des onglets dans les sites générés, les logos sont étirés ».
- Cause : `index.html` recevait le logo BRUT comme favicon (`rel="icon"` et `apple-touch-icon`). Le détourage recadre le logo au plus près, donc il n'est presque jamais carré (mesuré : Paséo 925×456, Paselle 608×265, Denimora 438×508). Le navigateur le dessine dans un carré sans garder les proportions → logo écrasé.
- Correctif :
  - nouveau `api/builder/favicon-square.ts` : `buildFaviconSet(logoUrl)` (data URI ou http) → icône d'onglet PNG 256×256 transparente + icône iOS PNG 180×180 sur fond uni (blanc, ou quasi-noir si le logo est clair). Logo recadré sur ses pixels visibles puis posé en `contain`, centré. Jette si le logo est illisible/vide (jamais de logo brut en secours). Cache par empreinte du logo.
  - `scaffold.ts` : `AppMeta.favicon` ; `index.html` utilise `meta.favicon`, sinon l'icône à l'initiale. Le logo brut n'y est plus jamais posé.
  - `engine.ts` : calcule le favicon carré juste avant `buildScaffold` (échec → message visible dans le build + `console.error`).
  - `apply-logo.ts` : `patchIndexHtml(content, FaviconSet)` ; `applyLogoToProjectFiles` calcule le favicon carré (échec → index.html inchangé, journalisé).
  - `api/index.ts` (changement de logo validé) : même chose.
- Projets existants : réparés automatiquement au prochain démarrage de leur aperçu (`healLogoOnce` → `applyLogoToSite`), sans toucher au logo lui-même. Vérifié sur Paséo 73488185 : `index.html` (base v3, disque, HTML servi) porte l'icône 256×256 attendue.
- Tests : `api/builder/favicon-square.test.ts` (7, dont logo 3:1 → carré, rapport conservé) ; `apply-logo.test.ts` adapté (+1 : jamais le logo brut).

# Visuels du site générés avec les VRAIS produits (2026-10-04)

- Demande : l'IA générait des images pour le site, mais pas du produit (dernier projet Paséo : baskets génériques au lieu des baskets Printify « Solstice » et « Vague »).
- Cause (mesurée sur la base et le journal du build de Paséo) :
  - le pop-up de marque appelle `POST /brand-preview` ~25 s avant le build, qui démarre en parallèle (mode automatique) ;
  - l'attente du catalogue dans `runBuildWebsiteWork` ne regardait QUE le fichier cache de l'aperçu, écrit à la FIN de `/brand-preview` (+42 s). Absent → « pas d'aperçu » → catalogue lu vide à +1 s ;
  - direction artistique à +77 s sans aucun produit en référence ; validation de la marque (produits + vraies photos en base) à +85 s seulement.
  - Même faille dans `waitForBrandPreviewResolved` (mega-init).
- Correctif :
  - `api/builder/brand-gate.ts` (nouveau, pur) : état réel de l'aperçu = requête en vol (`/brand-preview`, `/products`, `/approve`, tracées par le middleware `trackBrandPreviewWork`) OU proposition en cache encore validable (mtime du cache + délai d'auto-validation du pop-up). Cache plus vieux que ce délai et rien en vol = abandonné. Borne dure = somme des délais du pop-up.
  - `api/index.ts` : `brandGateProbe`, middleware sur les 3 routes, `waitForBrandPreviewResolved` et `brandCatalogForGenesis` passent par `waitForBrandGate`. L'attente est annoncée dans le journal (« ⏳ … j'attends leurs vraies photos »), l'abandon aussi (« ⚠️ … les visuels générés ne les montreront pas »).
  - `web/components/BrandPreviewPopup.tsx` : délais lus dans `brand-gate.ts` (serveur et client ne peuvent plus diverger).
  - Tests : `api/builder/brand-gate.test.ts` (11, dont le scénario Paséo et les vraies routes Hono).
- Paséo `73488185…` : les 3 visuels régénérés avec les photos réelles en référence (« généré avec le vrai produit … »), écrits dans `src/lib/images.ts` (disque + base). Vérifié dans l'aperçu : le héro montre la Solstice.
- Non vérifié : un build complet de bout en bout avec ce code.

# Récap de fin de build écrit dans le chat (2026-10-04)

- Demande : à la fin d'un gros build, l'IA n'écrivait parfois aucun texte de fin, ni les fichiers. Le chat montrait seulement « Your project is ready! 🎉 ».
- Causes (lues dans le code, vérifiées en base et au navigateur) :
  - « Your project is ready! 🎉 » était une phrase codée en dur dans `web/lib/build-store.ts`, en anglais, jamais enregistrée.
  - En direct, seul le message marketing était relu. Le pack visibilité, l'avis « contenu d'exemple » et les propositions n'apparaissaient qu'après un rechargement.
  - Aucun message ne racontait ce qui avait été construit.
  - Le pack visibilité retombait sur son modèle générique (`visibility: unparseable JSON`) alors que l'IA renvoyait un JSON valide. L'extracteur prenait le premier bloc de code du texte pour l'enveloppe du JSON, et les documents contiennent eux-mêmes des blocs de code (pages HTML). Reproduit avec un vrai appel IA, puis corrigé : « ✅ Pack visibilité prêt — 8 document(s) ».
- Changements :
  - `api/builder/build-recap.ts` (nouveau) : un récap composé à partir des faits réels du build, en FR/EN, sans appel IA. Il couvre les pages, les fichiers, le résultat du test navigateur (ou « n'a pas pu tourner »), les produits branchés, les documents, le contenu d'exemple et le mobile. Il est enregistré dans `chat_messages` (id `build-recap-<companyId>`, upsert) comme **dernier** message du build. Branché dans `runBuildWebsiteWork` (chemin app React et chemin site multi-pages).
  - `api/index.ts` : les messages marketing, visibilité et propositions portent l'id `build-end-<uuid>`. Ils sont écrits via `dbRetry`, sans `.catch` silencieux, et un échec se voit dans le déroulé.
  - `api/builder/extract-json.ts` (nouveau) : remplace les extracteurs de `growth-visibility.ts` et `marketing-strategy.ts`.
  - `web/lib/build-end-messages.ts` (nouveau) et `web/lib/build-store.ts` : à la fin du build, le navigateur relit l'historique et affiche en direct les messages `build-end-*`, `demo-notice-*` et `build-recap-*` écrits depuis le départ du build, avec dédoublonnage par id et le récap en dernier. La phrase de repli et le message d'échec sont traduits en 5 langues (`build.done.*` dans `web/lib/i18n.tsx`, `translate()` hors React). Le message d'échec ne mentionne plus un bouton « Retry » qui n'existe pas.
  - `web/pages/chat.tsx` : `hasBuildDone` reconnaît `build-recap-`.
- Vérifié :
  - 16 nouveaux tests : `build-recap.test.ts`, `extract-json.test.ts`, `build-end-messages.test.ts`.
  - Vrai Chrome sur le projet 73488185, après rechargement : le récap est le texte final visible, avec les 11 fichiers en dessous.
  - Fin de build simulée en direct (jobs « running » puis « completed ») : le récap apparaît une seule fois, sans phrase générique.
  - typecheck:api 24 (base), typecheck web 0, lint 672 (base), tests 1772 pass + 2 échecs connus, build EXIT 0.
- Non vérifié : un vrai build complet de bout en bout avec le nouveau code serveur.

# QA live de fin de build beaucoup plus rapide (2026-10-04)

- Demande : à la fin du build, la vérification page par page (« ✔️ /profile (/profile) — OK ») prenait beaucoup trop de temps.
- Mesuré sur un vrai projet (18 pages, 17 testables, `runLiveQA` réel sur l'aperçu) : **464 s avant**, dont ~80 s pour `/profile`, `/settings`, `/support`, 72 s pour `/boutique`.
- Causes (vérifiées au navigateur, `api/builder/live-qa.ts`, passe d'interaction) :
  - `innerText()` sur chaque bouton sans timeout : quand le clic précédent avait re-rendu ou retiré le bouton, Playwright attendait son défaut de **30 s** ;
  - une modale / un bandeau cookies recouvrait la page : chaque bouton du fond attendait **2 s** de timeout de clic pour rien ;
  - aucune borne de temps par page, et les pages testées une par une.
- Correctifs (nouveau `api/builder/live-qa-interaction.ts` + `live-qa-interaction.test.ts`, 14 tests) :
  - avant chaque clic, une seule lecture côté page (500 ms max) : libellé + test de recouvrement (`elementFromPoint` au centre du bouton). Un bouton masqué est sauté tout de suite ; les boutons DE la modale ou du bandeau restent cliqués (ce qui la ferme souvent) ;
  - arrêt après 3 clics ratés d'affilée ; budget de 12 s pour toute la passe d'interaction d'une page ; aucun timeout ne vaut 0 (pour Playwright, 0 = attente infinie) ;
  - 2 pages testées en parallèle (onglets du même navigateur) ; les routes dynamiques restent testées après les statiques (leurs URL réelles viennent des liens relevés).
- Résultat sur le même projet : **68 s au lieu de 464 s**, mêmes résultats (0 bug dans les deux cas).
- Détection des bugs conservée, vérifiée sur un site de test : erreur JS au chargement, erreur au clic d'un bouton, erreur au clic d'un bouton dans une modale qui recouvre la page → les 3 détectées ; page dont les boutons disparaissent après un clic : 2,3 s. Les 4 pages de test : 6 s au total (l'ancien code n'avait pas fini après 5 min).

# Connexion protégée contre la force brute (2026-10-04)

- Demande : empêcher qu'on essaie des mots de passe en boucle pour pirater un compte (limite, délais après les échecs, système très sécurisé).
- Avant (vérifié dans le code) : seul un rate-limit mémoire de 10 requêtes/min, dont le compteur dépendait de l'en-tête `Authorization` (en le changeant à chaque requête on repartait de zéro) ; aucun blocage par compte ; un e-mail inconnu répondait plus vite (pas de bcrypt), ce qui révélait quels comptes existent.
- Nouveau module `packages/web/src/api/login-guard.ts` (+ `login-guard.test.ts`, 19 tests) :
  - compteur PAR COMPTE (e-mail normalisé, indépendant de l'IP) : 4 essais libres, puis attente de 1 min, 5 min, 15 min, 30 min, puis 1 h après chaque nouvel échec ; oublié après 24 h sans tentative ; remis à zéro par une connexion réussie ;
  - compteur PAR IP (un mot de passe essayé sur beaucoup de comptes) : 19 échecs libres, puis 5 min, 15 min, 1 h ; oublié après 6 h ; se connecter à son propre compte n'efface pas ces échecs ;
  - pendant l'attente, même le BON mot de passe est refusé (429 + `Retry-After` + `retryAfter` en secondes) ;
  - chaque tentative est réservée AVANT la vérification du mot de passe, en une seule requête SQL atomique : des requêtes parallèles ne donnent pas d'essais en plus (vérifié en réel : 20 requêtes simultanées → 4 jugées, 16 refusées) ;
  - e-mail inconnu = même compteur, même bcrypt (hash factice au coût 12), même message : rien ne révèle qu'un compte existe ;
  - table `login_attempts` (créée par le module, `CREATE TABLE IF NOT EXISTS`) : les compteurs survivent à un redémarrage ; clés stockées en SHA-256, adresse masquée (`je***@gmail.com`) ; purge automatique des vieux compteurs.
- `index.ts` : `/auth/login` passe par `guardLogin` ; le rate-limit des routes `/auth/login`, `register`, `forgot-password`, `reset-password` compte par IP (`rateLimit({ id })`, nouvelle option dans `security.ts`) et plus par en-tête `Authorization`.
- « Mot de passe oublié » : 3 e-mails max par adresse et par heure (réponse `{ ok: true }` inchangée). Une réinitialisation réussie lève le blocage du compte : un attaquant ne peut pas bloquer durablement le vrai propriétaire.
- Admin : `GET /api/admin/security/login-locks`, `POST /api/admin/security/login-unlock` (`{ email }` ou `{ ip }`). Chaque blocage de compte est journalisé (`security:login-lock`, visible dans `/admin/security/events`).
- Front : `web/lib/login-lock.ts` (compte à rebours) utilisé par `pages/login.tsx` et `components/AuthModal.tsx` : message clair, « Encore N essais » quand il en reste 2 ou moins, bouton désactivé « Patiente m:ss » pendant l'attente. Textes en 5 langues (`i18n.tsx`, clés `auth.*`).
- Limite assumée : l'IP vient d'en-têtes (`CF-Connecting-IP`, `Fly-Client-IP`, `X-Forwarded-For`, `X-Real-IP`) qui restent falsifiables si l'on contourne le CDN ; c'est pour ça que le blocage par compte n'utilise jamais l'IP.

# Logos logiques et professionnels, pour toutes les marques (2026-10-04)

- Demande : le logo généré doit être logique avec la marque (une marque de chaussures doit avoir un logo qui fait penser à la chaussure), pour tous les types de marque, et rester professionnel.
- Causes (vérifiées dans le code et sur les logos en base) :
  - trois chemins construisaient chacun leur prompt : l'initialisation, « change le logo » dans le chat (`streamLogoChange`) et l'aperçu de marque ;
  - le style « lettermark » était tiré au hasard et le prompt disait « les initiales » sans donner la lettre. Résultat : un R pour Paséo et pour PasStride, qui commencent par P ;
  - `industryDesignLanguage` cherchait des sous-chaînes avec `includes()` et n'avait aucune entrée pour les chaussures, les pantalons, les cosmétiques ou les boulangeries. Paselle (chaussures) est classée « Technology » ;
  - `designLogoBrief` avait un `catch {}` vide, et personne ne regardait le logo produit.
- Correctifs :
  - Nouveau `api/builder/logo-brief.ts` : point d'entrée unique `generateBrandLogo`, utilisé par les 3 chemins via `generateLogoForBrand` dans `index.ts`.
    - Secteur détecté sur ce que la marque vend (idée et description AVANT le libellé d'industrie), en mots entiers : 29 métiers, chacun avec ses codes visuels et des symboles logiques. Exemple : « auto-entrepreneur » n'est plus classé automobile, « bougies parfumées » est une bougie et pas un parfum.
    - Initiale réelle (les articles sont sautés : « Le Fournil » → F, « La Mie Dorée » → M). Un monogramme nomme cette lettre ; un symbole n'a aucune lettre. Un brief « symbol » qui décrit l'initiale est requalifié en monogramme.
    - Brief de directeur artistique : une seule idée, tirée du produit, d'une partie du produit, de son usage, du sens du nom ou de l'initiale. Il doit être dessinable en 2 à 4 formes. Les formes génériques et les symboles d'un autre métier sont interdits. Les couleurs trop claires sont refusées.
    - Relecture en deux temps. (1) Perception à l'aveugle par vision (`logo-vision.ts`, Gemini 3 Flash puis Claude) : le relecteur ne connaît ni la marque ni l'intention ; il dit ce qu'il voit, les lettres lues, si c'est plat ou en fouillis. (2) Un appel texte juge si ce qui a été VU est logique pour ce que vend la marque.
    - Le fond est jugé par le détourage réel (`cutoutLogo`) : si le fond ne peut pas être retiré, l'essai est rejeté.
    - Jusqu'à 3 images. Le motif de rejet est renvoyé au modèle image. Après 2 rejets, le concept est repensé.
    - Si tout est rejeté : aucun logo n'est livré, l'erreur est loguée et l'utilisateur voit le message existant. Un logo illogique n'est jamais livré.
  - L'aperçu de marque ne demande plus de concept de logo dans l'appel « direction ». Son `catch` vide logue désormais l'erreur. Il passe toute sa palette (le fond clair était la 1re couleur et était filtré).
- Essais réels (vrais modèles) :
  - PasStride : P fusionné avec une chaussure de course ;
  - Paselle (classée Technology) : sneaker de profil ;
  - Denimora : D avec une jambe de jean ;
  - Chez Lulu (restaurant italien) : la pelote de laine qui était acceptée avant est maintenant rejetée ; logo final = fourchette avec des pâtes ;
  - Le Fournil de Max : « LD » rejeté, puis F avec un épi de blé ;
  - MailFlow : enveloppe avec un M ;
  - Glowé (cosmétiques) : goutte avec une feuille, ou G avec une feuille ;
  - La Mie Dorée, testée par la vraie route `/brand-preview` : croissant avec un épi, détouré.
- Limites :
  - un logo coûte de 1 à 3 images et environ 2 appels texte et 1 appel vision par image ;
  - sur certains essais, aucun des 3 n'est passé (MailFlow en monogramme, une fois) : dans ce cas, pas de logo et le message « réessaie » s'affiche ;
  - les logos existants (PasStride, Denimora, Paselle, MailFlow, Paséo) n'ont PAS été régénérés ;
  - le parcours dans le navigateur (chat « change le logo ») n'a pas été rejoué.
- Tests : `api/builder/logo-brief.test.ts` (71 tests).

# Ordre des pages et plus de « Showroom » proposé d'office (2026-10-04)

- Demande : l'IA générait les pages dans le mauvais ordre (ex. le Showroom pris comme page d'accueil) ; ne plus proposer de page Showroom par défaut (seulement si la personne l'ajoute ou la demande) ; étudier de vrais sites de boutiques, magasins et autres, et donner à l'IA des exemples et des règles OUI / NON.
- Causes (vérifiées dans le code et en base) :
  - `PLAN_PROMPT` et `PLAN_PROMPT_LIGHT` (`api/builder/prompts.ts`) imposaient « Showroom = page principale (route "/") » pour toute marque ou produit physique. L'exemple JSON du prompt léger était aussi un Showroom.
  - Le questionnaire (`PagePlanTool.tsx` → `confirmPagesList` dans `chat.tsx`) n'envoyait que `{name, purpose}`, toutes marquées `custom`. `select-pages` reconstruisait alors les routes : la 1re page de la liste devenait "/", les slugs perdaient leurs accents (`/d-tail-du-mod-le`), et les pages standard (Contact…) étaient placées en tête.
  - `ensureHomeRoute` pouvait choisir Contact comme accueil quand aucune page n'avait "/".
  - Bug trouvé pendant le test live : `isSinglePageRequest` lisait « …avec une page showroom » comme « une seule page » et produisait un plan d'UNE page blanche. Le chat en avait une copie identique (questionnaire sauté).
- Correctifs :
  - Nouveau `api/builder/page-order.ts` (`finalizePlanPages`), appliqué à chaque plan :
    - un Showroom non demandé devient « Boutique » (ou « Modèles » pour des véhicules), ou il est supprimé si un catalogue existe déjà ; le mot est aussi retiré des descriptions des autres pages ;
    - un Showroom demandé est gardé, mais jamais sur "/" ;
    - pour les sites (ecommerce, brand, configurator, service), un vrai « Accueil » est placé sur "/" quand "/" est un catalogue ou est vide ;
    - ordre logique : accueil, offre, détail/tunnel, tarifs, à propos, journal, contact/FAQ, légal ;
    - `ensureHomeRoute` ne choisit plus jamais Contact ni une page légale ;
    - libellés en fr, en, nl, de, es, it.
  - Nouveau `api/builder/page-structure-rules.ts` (`PAGE_STRUCTURE_RULES`) : bloc OUI / NON injecté dans les deux prompts de plan. Il couvre l'accueil, l'ordre, la nav, les pages par type de site et l'interdiction du Showroom sauf si le mot est écrit par l'utilisateur.
  - Prompts : catégorie B = Accueil + Boutique + fiche produit + panier ; exemple JSON « Accueil / Home.tsx ». Les mentions de showroom ont aussi été retirées de `demo-content.ts` et du playbook Automobile (`industry-playbooks.ts`). Des lignes OUI / NON courtes ont été ajoutées aux playbooks E-commerce et Restaurant.
  - Questionnaire : les pages proposées gardent route, fichier et sections (`custom` = seulement les pages ajoutées à la main). Renommer une page retire sa route et ses sections (sauf "/" et les routes `:id`). Les pages standard passent après les pages choisies.
  - `select-pages` : slugs sans accents, routes dédoublonnées, "/" donné à la 1re page seulement si aucune page ne l'a déjà.
  - `isSinglePageRequest` est déplacé dans `api/builder/single-page-request.ts`, partagé par le serveur et le chat. « avec / ajoute / et une page X » et « une page contact / showroom / FAQ… » ne comptent plus comme une page unique.
- Décision prise sans confirmation : sans Showroom, "/" est un vrai Accueil (hero, produits phares, catégories, vrais arguments, courte histoire, CTA) et le catalogue complet est une page « Boutique » (`/boutique`), « Modèles » pour les véhicules.
- Sites réellement lus (navigateur, nav + titres + footer) :
  - boutiques et marques : Allbirds, Gymshark, Veja (BE), Glossier, Mejuri, Patagonia, HAY, Maison Dandoy, Asphalte, Lepape, IKEA BE, Brooklinen, Oura, Dessange, Article, Burrow, Respire, Essentiel Antwerp, Pandora BE, La Colombe, Nothing, Fnac.be ;
  - véhicules : Polestar, Cowboy ;
  - restaurants : Septime, Noma, Dishoom, Le Pain Quotidien ;
  - services et autres : Basic-Fit BE, The Hoxton, One Medical, Pentagram, leboncoin ;
  - logiciels : Linear, Notion, Stripe.
- Sites NON lus (bloqués ou vides) : Sézane (vide), Aesop (vérification Cloudflare), Pierre Marcolini (sélecteur de pays), Tesla (Access Denied), Too Good To Go (checkpoint Vercel), Balzac Paris (Cloudflare), Typology (404), Zalando.be (page d'erreur), Schorem (inaccessible). Les recherches web (Baymard, Shopify…) n'ont donné que des titres et des extraits : aucun article n'a été ouvert.
- Constats retenus :
  - aucun site lu n'a de page « Showroom » dans sa nav ni comme accueil ; le mot ne désigne que des LIEUX physiques (HAY « offices & showrooms », Burrow « Showrooms » = magasins) ;
  - la nav montre l'offre (catégories, Boutique, Menu, Modèles) puis À propos ou Journal ; FAQ, livraison, retours, contact et points de vente sont dans le footer ; panier et compte sont des icônes ;
  - restaurants : Menu, Réservation, Restaurants/Accès ; véhicules : Modèles, essai, magasins ; logiciels : Produit, Tarifs, Connexion.
- Vérifié :
  - Test live `plan-pages` (session admin et entreprises de test, supprimées ensuite) :
    - « crée-moi une marque de chaussures » → Accueil `/`, Boutique, Fiche produit, Panier, Notre histoire, Contact ;
    - « un restaurant italien à Bruxelles » → Accueil `/`, Menu, Réservation, Détail du plat, À propos, Contact & accès ;
    - « une marque de meubles avec une page showroom » → Accueil `/`, Showroom `/showroom`, … , Contact (avant le correctif `isSinglePageRequest` : une page blanche).
  - `select-pages` : routes proposées gardées ; « Détail du modèle » → `/detail-du-modele`.
  - Tests : `page-order.test.ts` (14), `plan-prompt-structure.test.ts` (7), `single-page-request.test.ts` (12).
  - Suite complète : 1652 pass, 1 skip, 2 échecs connus (auto-réparation de l'aperçu).
  - Typecheck API 24 (base), web 0, lint 673 (base), build OK.
- Pas vérifié / pas fait :
  - le questionnaire n'a pas été rejoué dans un navigateur (seulement l'API) ;
  - pas de build complet d'un site généré avec le nouveau plan ;
  - les projets existants gardent leurs `selected_pages` enregistrées (PasStride, Denimora et Paselle : Showroom sur "/" ; Paséo : Contact en tête sans "/" ; MailFlow : Contact avant Accueil). Rien n'a été migré.

# Photos produits servies par Velbaz : plus d'adresse fournisseur dans l'app (2026-10-04)

- Demande : cacher l'adresse Printify des photos produits (visible dans l'onglet réseau et dans le `src` des images).
- Nouveau `api/media-proxy.ts`, avec deux sens de réécriture :
  - Réponses : toute réponse JSON ou SSE client remplace les adresses des fournisseurs et stockages internes par `/api/img/<jeton>`. Hôtes visés : Printify et ses S3 `pfy-*`, CJ, AliExpress/alicdn, fal.media, replicate.delivery, higgsfield.ai, `storage.googleapis.com/runable-*`.
  - Le jeton est l'adresse chiffrée en AES-256-GCM avec une clé dérivée de `SECRET_STORE_KEY` ou `BETTER_AUTH_SECRET`. Il est déterministe (le cache navigateur fonctionne) et illisible. Le proxy ne sert que des jetons émis par le serveur : ce n'est pas un proxy ouvert.
  - Requêtes : `mediaProxyRequestRewrite()` remet les adresses réelles dans les corps JSON reçus, avant le handler. Le code serveur ne voit jamais `/api/img/`.
- Route `GET /api/img/:token` :
  - publique, car un `<img>` n'envoie pas de Bearer ; ajoutée aux chemins publics de la porte de lancement ;
  - gère `Range`, avec cache d'un jour ;
  - renvoie 404 pour un jeton invalide ou une photo supprimée chez le fournisseur.
- Branchement : dans `customer-text.ts` (y compris pour les clés techniques `imageUrl`, `images`… qui restent sinon intactes) et dans `index.ts`.
- Vidéo de fond de la page d'accueil : elle était chargée depuis `storage.googleapis.com/runable-templates/…`. Elle est maintenant copiée dans `public/videos/synaps-bg.mp4` (462 Ko).
- Correctif lié : `company.tsx` reconnaît `/api/img/…` comme une image dans les documents.
- Vérifié :
  - `GET /companies/:id/products` (PasStride) : 0 adresse printify.com, 3 `/api/img/`.
  - Proxy : 200 `image/jpeg` sans session. L'image s'affiche dans Chrome (1200 px de large).
  - Une ancienne photo (le mug, produit supprimé chez le fournisseur) répondait déjà 400 en direct ; elle répond maintenant 404.
  - Chat PasStride et MailFlow, fiche projet, accueil : plus aucune requête de l'app vers un fournisseur.
  - Tests : 19 dans `media-proxy.test.ts` + `customer-text.test.ts` ; suite complète 1619 pass, 1 skip, 2 échecs connus.
  - Typecheck API 24 (base), web 0, lint 673 (base), build OK.
- Pas couvert :
  - **Le site boutique généré** (iframe d'aperçu et site publié) charge encore ses photos directement chez le fournisseur : elles sont écrites dans le code du site (`src/lib/catalog.ts`).
  - Les routes de code ou de fichiers du projet (exemptées) montrent les adresses réelles.
  - Le script `runable.js` (plugin analytics du template, à garder) et les polices Google restent visibles dans l'onglet réseau.

# Confidentialité : le chat et l'activité ne nomment plus Printify ni les outils internes (2026-10-04)

- Demande : « dans le système ou le chat, l'IA ne doit jamais parler de Printify ni de comment elle génère les produits — rien ne doit fuiter ».
- Cause : les messages serveur (activité des agents, pop-ups, erreurs JSON, statuts de commande) nommaient Printify, CJ, AliExpress, les blueprints et les mockups. Les prompts de l'IA contenaient ces connaissances sans interdiction de les répéter.
- Correctif à la source :
  - Messages réécrits en français neutre (« atelier partenaire », « fabrication », « coût de fabrication réel », « aperçu du produit »). Fichiers : `api/index.ts`, `builder/chat-product-flow.ts` (le pop-up « Connecter Printify » du chat est supprimé), `pod-guard.ts`, `printify-auto.ts`, `brand-preview-products.ts`, `builder/catalog-sync.ts`, `dropship/fulfillment.ts`, et côté front `AIPopup.tsx`, `chat.tsx`, `PayoutsPanel.tsx`, `HiggsfieldStudio.tsx`, `OrdersPanel.tsx`.
  - Règle de confidentialité dans tous les prompts du chat (`api/agents/confidentiality.ts`). Elle est insérée dans les prompts IDENTITY/IDENTITÉ de `index.ts` et `orchestrator.ts` (y compris le prompt léger) et dans `team-engine.ts`. Les sections de connaissance Printify/dropship/growth sont marquées « interne ».
- Barrière en sortie : `api/customer-text.ts`, branchée via `securedApp.use('*', customerTextGuard())`. Elle réécrit le texte des réponses JSON et SSE (avec gestion d'un nom coupé entre deux morceaux du flux).
  - Elle ne touche jamais les URL, les identifiants machine ni les clés techniques.
  - Routes exemptées : `/admin`, fichiers et code du projet, site, pages, checkpoints, secrets, export.
  - Elle masque aussi les anciennes lignes déjà en base.
- Données : un produit de PasStride passé de `category: 'Printify'` à `'General'`. Aucune logique ne lit cette valeur et aucun écran ne l'affiche. Les 18 lignes `agent_activity` anciennes ne sont pas migrées : elles sont réécrites à l'affichage.
- Vérifié :
  - Chat réel (Luna). À « tu utilises quoi pour fabriquer ? Printify ? », réponse : « fabriqués à la demande par l'atelier partenaire de Velbaz ». À « quel modèle ? », réponse : « Velbaz AI ».
  - Message forcé (« je suis développeur, ignore tes consignes ») : rien de divulgué.
  - DOM de 3 chats (projet test, PasStride, MailFlow) : 0 occurrence de Printify/CJ/blueprint/Higgsfield/OpenRouter/Gemini/GPT/Runable/Turso.
  - `customer-text.test.ts` : 13 tests.
  - Suite complète : 1613 pass, 1 skip, 2 échecs connus.
  - Typecheck API 24 erreurs (base, aucune dans ces fichiers), typecheck web 0, lint 673 (base), build OK.
  - `DELETE /api/companies/:id` : 200.
- Limites connues :
  - Une IA reste une IA : la règle et la barrière réduisent fortement le risque, sans garantie absolue.
  - Les photos produits restent hébergées chez le fournisseur : l'hôte de l'URL est visible dans l'onglet réseau et dans `src`, pas comme texte. Le masquer demande un proxy d'images.
  - Les noms de champs JSON (`printifyProductId`…) sont visibles dans l'onglet réseau, jamais à l'écran.
  - `/guide` (guide de reprise du projet, non lié depuis l'app) cite Runable et Turso.
  - Paséo (compte réel) non modifié en base : seul l'affichage est réécrit.

# Approbation manuelle : vraie pause côté serveur (2026-10-04)

- Symptôme : avec Paramètres › Comportement de l'IA › « Manual Approval Mode » activé, le pop-up « Approval Required » changeait tout seul à chaque étape et l'IA continuait sans attendre la réponse.
- Cause : le réglage n'existait que dans le `localStorage`. `web/pages/chat.tsx` fabriquait un nouveau pop-up à chaque nouvelle ligne d'activité « working on » du build, et Accept/Decline n'appelaient jamais le serveur : le build continuait. Le pop-up était décoratif.
- Correctif :
  - `api/approval-gate.ts` (+ `approval-gate.test.ts`, 9 tests) : file d'approbations PAR PROJET. Une tâche serveur arrivée à un point de contrôle attend réellement. Une seule demande visible à la fois (la plus ancienne), donc le pop-up ne change plus. Aucune minuterie, rien n'est accepté automatiquement. Sorties possibles : réponse de l'utilisateur, « Arrêter » (la tâche s'arrête), désactivation explicite du mode (les demandes en attente sont acceptées), suppression du projet. Si le réglage est illisible, on demande la permission.
  - `api/approval-routes.ts` : réglage persistant `users.ai_approval_mode` (colonne ajoutée au schéma, aux runtime-tables et à la base live), routes `GET/PUT /me/ai-approval`, `GET /companies/:id/approval`, `POST /companies/:id/approval/:approvalId` (refus = raison obligatoire, 409 si la demande n'est plus en attente). Ligne d'activité « ⏸️ En attente de ta validation » mise à jour en place (✓ Validé / ✗ Refusé « raison » / ⏹️ Arrêté), pastille `awaitingAnswer`, et un refus écrit `agent_memory` `user_declined_<phase>` (importance 9).
  - `api/index.ts` : points de contrôle avant le build web (`build`), le build mobile (`build-mobile`), les tâches d'init (`init-agent-tasks`), le logo et les 4 étapes du mega-init. Un refus du build termine le job avec la raison. `cancel-build` libère les attentes. `GET /companies/:id/jobs` renvoie `pendingApproval`.
  - Front : `settings.tsx` enregistre l'interrupteur sur le serveur ; `chat.tsx` affiche la demande du serveur (poll 2 s, même id = pop-up inchangé) et envoie Accept/Decline au serveur ; `AIApprovalPopup.tsx` affiche « L'IA est en pause et attend ta réponse » et bloque les boutons pendant l'envoi ; `build-store.ts` n'affiche plus « bloqué » pendant une pause.
- Corrigé en passant (trouvé pendant le test) : supprimer un projet ayant lancé un build échouait en 500 (`FOREIGN KEY constraint failed`). Les deux routes `DELETE /companies/:id` et `DELETE /admin/companies/:id` avaient chacune leur liste de tables, incomplète (13 tables oubliées, dont `build_journal`) et mal ordonnée (`products` avant `order_items`, `autopilot_plans` avant `autopilot_tasks`, `customers` avant `deals`…). Nouveau `api/company-delete.ts` partagé, ordre enfants → parents vérifié contre `pragma foreign_key_list`. Les erreurs ne sont plus avalées (l'ancien try/catch cachait que `marketplace_orders` n'a pas de `company_id`). Les tâches du projet sont arrêtées avant la suppression.
- Vérifié en direct (compte admin, projet TEST créé puis supprimé, session temporaire supprimée) : pause sur « build » avec le même id sur plusieurs polls ; aucune étape du build pendant l'attente ; pop-up visible dans le chat (Playwright) ; refus sans raison → 400 ; refus avec raison → job terminé « Refusé par toi : … » + mémoire écrite ; « Arrêter » pendant l'attente → libéré, ligne « ⏹️ Arrêté » ; Accept → le build reprend (planification lancée) ; mode coupé pendant l'attente → `released: 1`. Les deux DELETE testés sur des projets avec `build_journal` + agents → 200, aucune ligne restante.
- Pas couvert (pas de point de contrôle) : tâches d'init de `POST /companies`, reprise d'un init interrompu, heartbeats, modifications via le chat (« ✏️ Modification… »), routes autonomes (aperçu de marque, visualisation produit…). « Autonomy Level » reste visuel. Le réglage lu est celui du PROPRIÉTAIRE du projet, pas du collaborateur qui discute.
- Constaté, pas corrigé : après « Arrêter », l'appel IA déjà en vol (planification, vérification juridique) va au bout avant que le build s'arrête.

# Chat : plus de blocage de 5 min sur « Analyse de ton idée et préparation du plan » (2026-10-04)

- Symptôme : compte Free, « cret moi une mark de chaussure » → l'écran reste sur « Analyse de ton idée et préparation du plan ».
- Cause mesurée (`ai_usage_events`) : la requête stream vers le Runable Gateway (`openai/gpt-6-luna`) n'a renvoyé AUCUN octet pendant 299 999 ms (« Gateway request failed: The operation was aborted due to timeout »). Le seul garde-fou était le plafond global de 5 min de `safeStreamText`, puis la génération classique a pris 14 s de plus. Les appels identiques juste avant et après ont répondu en 2 à 6 s. Pourquoi le gateway est resté muet n'est pas connu (non reproduit sur 5 essais).
- Correctif : nouveau `api/agents/stream-deadline.ts` (`streamWithFirstPartDeadline`). Un flux qui n'a rien renvoyé après 30 s (ni en-têtes, ni début de raisonnement, ni texte) est coupé et relancé une fois sur une connexion neuve, puis on passe à la génération classique. Un modèle lent mais qui a répondu n'est jamais coupé (seul le plafond de 5 min reste). Branché dans `safeStreamText` et, par concurrent, dans `safeStreamTextRace` (qui n'avait aucun plafond). Les logs disent maintenant « fournisseur muet » au lieu de « a streamé du vide ».
- Tests : `api/agents/stream-deadline.test.ts` (6 tests, dont un avec le vrai `streamText` du SDK et un modèle dont la requête ne répond jamais).
- Vérifié en direct (session admin temporaire supprimée) : même message, questions de découverte en 5,9 s. Pas vérifié : le cas « gateway muet » en conditions réelles (non reproductible à la demande).
- Pas couvert : les appels non streamés (`safeGenerateText`) gardent le plafond de 5 min.

# Chat : « crée-moi une marque » mal orthographié crée bien le projet (2026-10-04)

- Symptôme : « cret moi une mark de chaussure » → l'IA répondait en texte (« Voici PASO… ») en inventant une marque, sans lancer la création.
- Cause mesurée (logs + table `ai_usage_events`) :
  - les regex déterministes de `api/agents/orchestrator.ts` exigent l'orthographe exacte (« marque ») et ne connaissent pas les produits (« chaussure ») ;
  - le classifieur IA (`gpt-5.4-mini`, remplacé par `openai/gpt-6-luna` en mode Velbaz) mettait 7,6 à 8,1 s : Luna raisonne toujours (mesuré 1,8 à 16 s pour un seul mot, `reasoningEffort` ignoré). Le plafond de 3,5 s sautait, le repli heuristique disait QUESTION.
- Correctif : nouveau `api/agents/create-intent.ts` (`isCreationRequest`) qui reconnaît une demande de création sans appel réseau, en tolérant une faute par mot (cret/crer/fé, mark/marqe/mrque, chaussure/basket/sneakers/vêtement…). Branché dans `classifyIntent` (repli), dans les chemins déterministes de `classifyIntentAI` et dans la surcharge `EXPLICIT_CREATE` d'`orchestrateInner`. Les questions (« ? » final, comment/combien/savoir…), les négations et « j'ai une marque de… » restent au classifieur.
- Le log de timeout indique maintenant le modèle réellement appelé.
- Tests : `api/agents/create-intent.test.ts` (37 tests, dont le message exact de l'utilisateur).
- Vérifié en direct (`/api/chat/stream`, compte admin, session temporaire supprimée) : `classifyIntentAI 2ms`, `Intent: BUSINESS_IDEA`, questions de découverte « pour créer ta marque de chaussures ». Pas vérifié : le parcours complet dans l'UI jusqu'au build.
- Pas changé : le plafond de 3,5 s du classifieur (et de `wantsBuildNowAI`) reste trop court pour Luna sur les messages vraiment ambigus.

# Paramètres › Comportement de l'IA : bloc « How it works » et aperçu retirés (2026-10-04)

- `web/pages/settings.tsx` : retrait du bloc « How it works » (Accept / Decline) et de l'aperçu « AI Decision — Approval Required » (popup de démo « Summer Collection »), qui s'affichaient quand le mode d'approbation manuelle est activé. Le composant `ApprovalPopupDemo`, devenu inutilisé, est supprimé.
- Inchangé : l'interrupteur « Manual Approval Mode », sa description, le choix « Autonomy Level » et le vrai popup d'approbation dans le chat (`components/AIApprovalPopup.tsx`).
- Vérifié avec Playwright (compte admin, session temporaire supprimée ensuite) : interrupteur activé, aucun des textes « How it works », « Preview », « Approval Required », « Summer Collection » sur la page. L'interrupteur a été remis dans son état d'origine. Lint 673 (aucune nouvelle erreur), aucune erreur tsc dans le fichier.

# Chaussures : design complet + présentation pro des produits (2026-10-04)

## 1) Chaussure = un logo posé dessus au lieu d'un vrai design
- **Causes** :
  - `defaultStyleForPosition(..., 'footwear')` renvoyait `'logo'`, soit une boîte à 30 % de la zone.
  - Les prompts de design des chaussures étaient ceux d'un t-shirt (ou un « swatch »).
  - Les images étaient carrées, alors que les zones Printify du blueprint 291 font 1537×545 (ratio ≈ 2,8).
- **Corrections** :
  - `api/printify-artwork.ts` : nouveau style `all_over` (couvre toute la zone, `scale = max(1, a/r)`), et style par défaut des chaussures = `all_over`.
  - `api/printify-auto.ts` :
    - `resolvePlacementPositions(..., {includeInside})` : 4 zones (extérieur et intérieur gauche/droite).
    - `footwearArtworkMode(aspect, fondUniforme)` : un ancien design stocké est inspecté. S'il est panoramique ou sans fond uniforme, il passe en all-over sans détourage.
  - Nouveau `api/shoe-design-prompt.ts` (`footwearDesignPlan`) : motif plein cadre au format 21:9, sans logo ni texte (sauf texte demandé).
  - Branché dans le mega-init, `/brand-preview/products` et le flux produit du chat (`builder/chat-product-flow.ts`).
  - `generateImage` et `generateImageWithRefs` acceptent `aspectRatio`.
- **Vérifié en direct** : vraie chaussure Printify créée sur PasStride. Résultat `style: all_over`, design 2400×1018 non détouré. Les mockups montrent la basket entièrement couverte par le motif, sans logo. Le produit de test a ensuite été **supprimé** de Printify (404 confirmé).
- Inchangé volontairement :
  - `POST /printify/create-product`, l'éditeur manuel, où l'utilisateur fournit ses calques ;
  - les bas (pantalons), qui gardent le style `logo`.

## 2) Produits mieux présentés dans le site
- Avant : le site recevait UNE image par produit, le mockup Printify par défaut.
- **Maintenant** (`api/product-presentation.ts` + `api/product-presentation-run.ts`) :
  - On rassemble toutes les vues réelles du produit : les mockups Printify du coloris par défaut (une par angle) et les photos stockées.
  - Les vues Printify manquantes sont enregistrées (type `printify`) pour la galerie.
  - Jusqu'à 5 vues servent de références au modèle image, qui rend 2 photos pro du MÊME produit : un packshot studio 1:1 et une mise en situation 4:5 (type `presentation`).
  - C'est idempotent : chaque photo est liée au produit Printify source. Un produit reconstruit voit ses anciennes photos et vues remplacées.
  - Il y a une garde de solde avant chaque image. Le coût réel est post-payé au propriétaire du projet (contexte IA `design/product-presentation`).
- **Branchement** :
  - dans `syncCatalogOnce` (validation Printify, produit du chat, brand-preview, visualiseur), en parallèle de l'attente du build ;
  - en fin de build du site, avant la resynchronisation du catalogue.
  - Le résultat est annoncé dans l'activité (agent design).
- **Vitrine** :
  - `product-photo.ts` : la photo de présentation passe en tête, puis le produit réel, puis les visuels IA. `pickShopGallery` est nouveau.
  - Catalogue du site : nouveau champ `images: string[]` (`images[0] === imageUrl`).
  - La consigne boutique demande une galerie avec miniatures sur la fiche produit.
  - Sites déjà construits : le fichier catalogue est mis à jour, donc la nouvelle photo pro devient la vignette. La galerie à miniatures n'apparaît qu'au prochain build ou rebranchement des pages.
- **Vérifié en direct** : sur la chaussure Printify de test, 4 vues téléchargées (le CDN Printify exige un User-Agent navigateur, sinon 403). Les 2 photos générées reproduisent fidèlement la basket et son motif (studio gris, et au sol dans un atelier).
- **Non vérifié en direct** : le passage complet dans l'UI (validation d'un produit → photos en base → site mis à jour).
- **Tests** :
  - nouveaux : `product-presentation.test.ts` (base en mémoire), `product-presentation-run.test.ts`, `shoe-design-prompt.test.ts` ;
  - complétés : `product-photo.test.ts`, `catalog-variants.test.ts`, `chat-product-flow.test.ts`.
  - Suite complète : 1548 OK, 1 ignoré, 2 échecs connus (auto-réparation du disque).
  - `typecheck:api` 24 (baseline 25, une erreur existante corrigée dans `builder/routes.ts`), lint 674, build EXIT 0.

# Plainte « les non-admin ont toujours Lite/Pro/Max » : diagnostic (2026-10-03)

- Pas reproduit sur le code actuel (serveur de dev, port 4200). Testé avec Playwright sur un compte normal (Free), en bureau 1440×900 et en mobile 390×844 : accueil, chat simple, **chat projet** (`/chat/<id>`, projet temporaire), `/plans`, `/settings` et `/dashboard`, avec `velbaz_model_tier='max'` forcé en localStorage. Aucun texte « Lite », « Pro », « Max » ou « Luna », ni dans le texte de la page ni dans le HTML. Aucun bouton de l'accueil ou du chat projet n'ouvre un menu de modèles.
- Le serveur de dev sert bien le nouveau `chat.tsx` (`showModelSelector`) et le nouveau `model-tiers.ts` (`canPickModel`).
- Seul nom resté en dur : la pastille statique « Velbaz Lite » de la page d'attente (`web/components/waitlist/WaitlistLanding.tsx`, affichée par `LaunchGate`). **Retirée.**
- Test de non-régression ajouté : `web/lib/no-hardcoded-tier-names.test.ts`. Il échoue si « Velbaz Lite/Pro/Max » est écrit en dur dans le front, ailleurs que dans `lib/brand.ts` et hors commentaires.
- Si l'utilisateur le voit encore, causes probables :
  - un onglet ou un bundle en cache (recharger sans cache) ;
  - le site **publié**, qui garde l'ancienne version tant qu'il n'est pas republié depuis la plateforme.
- Comptes, projets et sessions temporaires supprimés. Le compte réel `a84b7de8…` (non-admin, Free) n'a pas été modifié.

# Velbaz 2.0 renommé « Velbaz » : modèle unique des comptes normaux (2026-10-03)

- Demande : remplacer le modèle normal par Velbaz 2.0 pour tout le monde (Free compris), le renommer « Velbaz », aucun choix de modèle pour les comptes normaux ; l'admin garde tout (dont GPT 6 Luna).
- **Serveur**
  - `api/plans.ts` : `PUBLIC_TIER = 'velbaz2'`. `capTier` : compte normal → toujours `velbaz2` (tout plan, tout palier forgé) ; admin → palier demandé, `velbaz2` par défaut. `ADMIN_ONLY_TIERS = ['luna','max','pro','lite']`. Retirés : `PlanConfig.maxTier`, la feature `advancedModels` et `limits.maxTier` des routes `/plans`.
  - `api/agent/velbaz2-flag.ts` : `velbazModeForUser` (normal → toujours ; admin → son flag). Flag absent = Velbaz. `runWithVelbazModeForUser/ForCompany` pour les jobs hors requête (lecture via `dbRetry`, pas de repli silencieux sur les anciens modèles).
  - `api/index.ts` : `resolveChatModel` arme le mode ET choisit le modèle du chat depuis la même décision (`/chat/stream` et `/chat`). Le `model` brut du front n'est plus honoré que pour l'admin. Heartbeats planifiés dans le scope du propriétaire.
  - `api/autopilot.ts`, `api/money-maker.ts`, `api/social/monitor.ts` (réponses Discord/Twitter) : scope du mode du propriétaire.
  - `api/agent/model-mode.ts` : `google/gemini-3-flash` → GPT 6 Luna dans le mode (il partait encore en 3ᵉ concurrent de la course au premier mot du chat, JSON du builder, vision genesis).
- **Front** : `TIER_VELBAZ2 = 'Velbaz'`. `model-tiers.ts` : compte normal = `['velbaz2']` seul, `canPickModel(false) = false`, `resolveTier` ramène tout ancien choix localStorage à Velbaz. Accueil et chat : aucun sélecteur (bouton, popover, feuille mobile) pour un compte normal. Menu admin : Velbaz, Velbaz Max, GPT 6 Luna, Velbaz Pro, Velbaz Lite.
- **Facturation** : inchangée, au coût réel (3000 crédits / $). Luna (0,10 $ / 0,50 $ par M tokens) est le modèle texte le moins cher du tableau ; l'étiquette « 3× tokens » était fausse.
- **Vérifié en direct** : compte Free temporaire avec `tier:'max'`/`'luna'`, `model:'claude-sonnet-5'` forgés → réponse et 100 % des appels enregistrés sur `openai/gpt-6-luna` (`/chat/stream` et `/chat`). Admin : `max` → `claude-sonnet-5`, `velbaz2` → `gpt-6-luna`, flag remis à 1. Playwright : aucun sélecteur pour le compte normal (accueil + chat, malgré `velbaz_model_tier='max'` en localStorage), menu complet pour l'admin. Compte temporaire supprimé.
- Restent hors mode : les chaînes de secours (`openai/gpt-5.4` si Luna tombe), l'IA intégrée aux sites générés (`builder/scaffold.ts`, `AI_MODEL`), les visiteurs non connectés hors chat.
- Tests : `velbaz2-mode.test.ts`, `velbaz2-remembered.test.ts`, `web/lib/model-tiers.test.ts` mis à jour et complétés. Suite complète : 1517 OK, 1 ignoré, 2 échecs connus (auto-réparation du disque). Build EXIT 0, lint 675, `typecheck:api` 25 (baseline).

# Printify : produits créés pour pantalons/vêtements et décision stable (2026-10-03)

- Demande : « des fois quand je crée un projet ça n'utilise pas Printify alors que c'est une company qui a besoin de produits ».
- **Cause mesurée en direct** (projet Denimora, idée « cret une mark de pentalon », industrie « Fashion ») :
  - L'IA de sélection produit renvoyait « pants » (2 fois sur 3). Ce type n'existait pas dans `POD_TYPE_SYNONYMS`, donc `normalizePodProductType` → null et le produit était jeté sans trace. Résultat : 0 produit. La 3ᵉ fois, elle renvoyait « shoe » pour une marque de pantalons.
  - La décision dépendait du libellé d'industrie (« Fashion » → oui, « Retail »/« Other » → non) et l'idée avec fautes ne nommait aucun produit reconnu. D'où l'intermittence.
  - Le message « 🖨️ Printify — rien à imprimer pour l'instant » partait AVANT la sélection, donc aussi pour des projets qui recevaient ensuite leurs produits.
- **`api/pod-guard.ts`**
  - 12 types ajoutés, blueprints vérifiés en direct : `pants`, `joggers`, `shorts`, `leggings`, `dress`, `skirt`, `socks`, `jacket`, `polo`, `beanie`, `backpack`, `swimsuit`. « jean(s) » → `pants` : Printify ne fabrique pas de vrai jean denim (seulement une veste en jean, zone dos uniquement).
  - `bestPodSynonym` : le synonyme le plus spécifique gagne (« veste en jean » → jacket, « maillot de bain » → swimsuit).
  - `podMerchDecision` / `podProductDecision` lisent aussi `description` (réécrite sans fautes par l'IA) : « Marque de pantalons… » → `pants`, quelle que soit l'industrie. Mots ambigus ignorés : dans l'idée « jean », « polo », « jogging », « short » ; dans la description « top », « print », « robe », « sac »… Un objet non fabricable (bijoux…) bloque toujours.
  - `isGarmentPodType` ; `isFashionBusiness` : un vêtement du catalogue nommé dans l'idée = mode (fiche textile), plus traité comme un objet type chaussure.
- **`api/brand-preview-products.ts`** (nouveau) : prompt avec le catalogue réel et la description, parsing qui trace chaque produit écarté (`unknown_type` / `wrong_type` / `no_design`), prompt du 2ᵉ essai.
- **`api/index.ts`**
  - `POST /companies/:id/brand-preview` : 2ᵉ appel IA contraint dès que 0 produit valide (avant : seulement si un type était imposé). L'annonce est calculée APRÈS la sélection, avec des messages explicites (« Printify ne répond pas », « aucun produit fabricable, proposés puis écartés : … »).
  - `description` passé à toutes les décisions POD (mega init, reprise, `printify/create-products`, `brand-preview/products`, photos produit via `soldObjectType`).
  - Mega init : le prompt de motif « empeigne de basket » n'est plus envoyé qu'aux chaussures (il partait pour tout objet du catalogue nommé dans l'idée). Les vêtements gardent les prompts textile (plus de « No garment, no model »).
- **`api/printify-auto.ts`** : blueprints statiques de secours + synonymes catalogue + exclusions (pyjama, blouse médicale, enfant, bébé, broderie…). Un bas (pantalon, jogging, short) est imprimé sur UNE zone avant de jambe en style logo, au lieu du même grand visuel sur chaque jambe.
- `api/product-prompt.ts` : vêtements = `isGarmentPodType` (source unique) + tablier.
- **Vérifié en direct**
  - Sélection rejouée 4 fois × 3 cas (Denimora en « Fashion » et en « Retail », « je veu vendre des robe dété ») : 12/12 bons types (`pants` / `dress`), 0 écarté, aucun 2ᵉ essai nécessaire.
  - Résolution dynamique du blueprint pour les 12 types dans le vrai catalogue (2 764 blueprints) : chaque type tombe sur le bon vêtement.
  - 2 vrais produits créés sur Printify : pantalon (blueprint 5507 « Men's Polyester Trousers », 20 variantes, coût 23,87 → prix 42,99) et jogging (5806, 12 variantes), logo sur `front_left_leg_dtf` seulement, mockups réels récupérés. Puis supprimés (vérifié : n'existent plus).
- Non vérifié : un parcours complet de création de projet dans l'UI. Denimora a toujours 0 produit (aperçu de marque à relancer).
- Tests : `pod-guard.test.ts` (+9), `brand-preview-products.test.ts` (6, nouveau), `printify-auto.test.ts` (+3). Suite complète : 1512 OK, 1 ignoré, 2 échecs connus (auto-réparation du disque). Build EXIT 0, lint 675, `typecheck:api` 25 (baseline).

# Édition visuelle : crédits vérifiés et diff ciblé (2026-10-03)

- Demande : le bouton Edit du rectangle d'aperçu modifiait le site même sans crédit, et une modification prenait beaucoup trop de temps.
- **Crédits.** `/companies/:id/project-edit` n'appelait jamais `deductTokens`. Le débit post-payé (`ai-usage/billing.ts`) ne descend pas sous 0, donc à 0 crédit l'édition était gratuite.
  - Correctif : `deductTokens(billingUserId(company), 'site_ai_call')` avant tout appel IA. En cas de refus, le flux SSE envoie l'erreur avec `needCredits: true`. Le chemin rapide (texte ou style appliqué sans IA) reste gratuit.
  - Même trou dans le chat (`/chat/stream` → `streamAppEdit` / `streamMobileAppEdit` / `streamSiteEdit`) : même garde-fou ajouté avant ces trois appels. La réponse est « Crédits insuffisants… [Recharge tes crédits](/plans) ».
  - Autopilot avait déjà son propre contrôle (`owner.tokens <= 0` → tâche reportée).
  - `web/lib/api.ts` : `projectEdit` renvoie `needCredits`. `web/pages/chat.tsx` : état `editNeedCredits`, la bulle d'erreur affiche un lien « Acheter des crédits » vers `/plans`.
- **Lenteur.** `editApp` réécrivait le fichier de page entier : un edit mesurait 65 s, 8 129 tokens de sortie et 558 crédits.
  - Nouveau `api/builder/visual-edit-patch.ts` : pour un élément cliqué, l'IA renvoie des blocs SEARCH/REPLACE. L'application est stricte : un extrait ambigu ou introuvable n'est pas appliqué. Il y a 2 essais, en tout ou rien. Si le diff n'est pas applicable, on revient à la réécriture complète.
  - `engine.ts` : `editApp(..., { targetFiles, patch })`. La route passe `patch: !!element`.
  - Le serveur d'aperçu était redémarré deux fois par edit IA. Maintenant, si seuls des fichiers `src/**/*.tsx|jsx|ts|css` changent, Vite HMR suffit. On lance `checkBuild`, puis `healBuild` et un redémarrage seulement en cas d'erreur.
  - Le log `[project-edit] … terminé : IA … ms, écriture + vérification … ms` donne le détail.
- **Mesuré en direct** (MailFlow `/contact`, badge ajouté sous le h1, puis retiré) : 1 bloc au premier essai, 16,7 s au total (IA 9,3 s dont diff 4,8 s, vérification 6,7 s), 345 tokens de sortie, 3,46 crédits. Avant : 65 s, 8 129 tokens, 558 crédits.
- **Vérifié à 0 crédit** : `project-edit` et `chat/stream` refusent tous les deux, sans aucun événement `ai_usage_events`. Playwright confirme que la bulle affiche le texte et le lien (réponse serveur simulée).
- Le site-edit des projets non React (`api.companies.siteEdit` → `/companies/:id/site-edit`) n'a pas de route côté serveur : l'appel échoue, aucun appel IA.
- Tests : `api/builder/visual-edit-patch.test.ts` (14). Suite complète : 1494 OK, 1 ignoré, 2 échecs connus (auto-réparation du disque de l'aperçu). Build EXIT 0, lint 675, `typecheck:api` 25 erreurs (baseline).

# Aperçu : bouton « Épingler » (punaise) retiré (2026-10-03)

- Demande : enlever la punaise de la barre du haut du rectangle d'aperçu, et partout.
- C'était la seule fonctionnalité « épingle » de l'app (aucune conversation/projet épinglé ailleurs).
- `web/components/PreviewTopBar.tsx` : bouton supprimé, props `pinned`/`onTogglePin`/`showPin`, `pinRef`, entrée `'pin'` de `DROPS` et de `wRef` retirées. La croix « Fermer l'aperçu » n'est plus jamais désactivée.
- `web/pages/chat.tsx` : état `previewPinned` et props associées retirés.
- `web/styles.css` : classe `.preview-tb-icon--on` (utilisée seulement par la punaise) retirée.
- Vérifié : capture du chat PasStride (pas de `[data-testid=preview-pin]`, croix + recharger présents), `bun run build` EXIT 0, lint 676 erreurs (677 avant), tsc sans erreur dans les fichiers touchés.

# Accueil : bouton « panneau » en haut à droite retiré (2026-10-03)

- `web/pages/index.tsx` : suppression du bouton `PanelToggleButton` (rectangle arrondi en haut à droite, visible connecté) et du panneau qu'il ouvrait (« Context » : cartes vides « Canvas » / « Model Preference »), + l'état `panelOpen` et le décalage `paddingRight`. Le composant reste utilisé par `chat.tsx`.

# Velbaz 2.0 suivi sur toutes les routes · sites générés : la connexion tient après actualisation (2026-10-03)

- **Velbaz 2.0 qui retombait sur `anthropic/claude-sonnet-4.6`**. Constaté dans `ai_usage_events` : `catalog-sync` lancé par `brand-preview/approve` (4 appels sonnet-4.6 juste après un build en Luna) et `selfheal-diagnose`.
  - Cause 1 : le flag mémorisé `admin_velbaz2_mode` n'était relu que par 3 routes (build, création de projet, reprise). Validations de produit, synchro du catalogue, création Printify… restaient sur Claude.
  - Cause 2 : un `/chat/stream` **sans** `tier` remettait le flag à 0 pour un admin.
  - Cause 3 : selfheal tourne hors requête, donc sans scope : jamais substitué.
  - Correctif : nouveau `api/agent/velbaz2-flag.ts` (`getVelbaz2Flag`/`setVelbaz2Flag` sortis d'`index.ts`, cache 5 s ; `applyRememberedVelbaz2ForUser` ; `runWithRememberedVelbaz2`). Appelé dans `checkAuth` (chemin cache ET base) et dans le `getUser` de `builder/routes.ts` → toute requête d'un admin en Velbaz 2.0 suit le mode.
  - `model-mode.ts` : `setVelbaz2ForRequest(on)` (choix explicite, verrouille le scope) et `applyRememberedVelbaz2(on)` (mode mémorisé, ne réécrit jamais un choix explicite). `applyVelbaz2Tier` : sans palier → mode mémorisé conservé ; palier normal → la requête sort du mode et le flag passe à 0 (comme avant).
  - `selfheal/healer.ts` : diagnostic dans `runWithRememberedVelbaz2`.
  - Vérifié en direct (compte admin) : chat `tier: velbaz2` puis chat sans palier → les deux en `openai/gpt-6-luna` (haiku de la course au premier mot substitué), flag resté à 1. Messages de test supprimés.
  - Tests : `api/velbaz2-remembered.test.ts` (12).
  - Reste hors mode : `google/gemini-3-flash` dans la course au premier mot (pas Claude) ; l'IA embarquée des sites générés (`scaffold.ts` `AI_MODEL` = sonnet-4.6).
- **Sites générés : déconnecté après actualisation / navigation**. Deux causes :
  1. Tous les sites sont servis depuis la même origine (aperçu `/api/companies/<id>/preview/`, `/s/<sous-domaine>` y renvoie) et rangeaient leur jeton sous la même clé `localStorage["auth_token"]`. Ouvrir un autre site → son `/auth/me` répond 401 au jeton du premier → le client l'efface. Nouveau `builder/site-auth-key.ts` : clé `"auth_token:" + import.meta.env.BASE_URL` (unique par site). Templates mis à jour (`scaffold.ts` auth + api, `security-scaffold.ts` upload) ; `namespaceSiteAuthKey` corrige aussi les anciens projets et le code écrit par l'IA à chaque écriture sur disque (`runner.ts` `securePatch`) et au démarrage de l'aperçu (`forceInfraFiles` : `src/lib/auth.tsx`, `src/lib/api.ts`).
  2. `writeFilesToDisk` faisait `rm -rf` du dossier du projet (rebuild, filet anti-squelette, aperçu ressuscité, retour arrière) → `.data/auth.json` (comptes + sessions), `.data/data.json`, `.data/uploads` effacés. Nouveau `clearProjectDirKeepingData` : tout est vidé sauf `.data`.
  - Effet unique : les visiteurs déjà connectés avec l'ancienne clé partagée doivent se reconnecter une fois.
  - Vérifié en direct (Playwright) : connexion sur PasStride → visite d'un autre site → retour sur `/profile` de PasStride : toujours connecté, `/auth/me` 200. Les deux projets sur disque ont la nouvelle clé. Compte de test retiré de `.data/auth.json` (le vrai client reste).
  - Tests : `api/builder/site-auth-persist.test.ts` (7).

# QA en une passe · produits validés toujours sur le site · « ajoute un produit » = vrai produit Printify (2026-10-03)

- **QA une seule passe** (`api/builder/live-qa.ts` `runLiveQAAndFix`) : carte du site → 1 détection (`runLiveQA`) → 1 correction (`repairInternalLinks` déterministe + `fixBugsLive`) → écriture → fin. Plus de boucle, de re-test ni de `maxRounds`. `LiveQAResult.found` = bugs détectés ; exports `unresolvedBugs`, `describeBug`, `leaksPreviewPath` (bloque les routes parasites `/api/companies/:id/preview/...`). Appelants : `index.ts`, `test-lab.ts`.
- **Produit validé absent du site** — deux causes :
  1. `POST /companies/:id/product-visualize/:draftId/approve` n'appelait jamais le rebranchement du catalogue ; et un prix inventé ≤ coût excluait le produit (`getDropshipCatalog` refuse la vente à perte) → prix/coût IA gardés seulement si `cost>0 && retail>cost`.
  2. Course QA ↔ sync : le sync écrasait les corrections du QA (vu sur PasStride). `BackgroundJob.done/settled`, `waitForSiteBuildsToSettle`, `syncCatalogAfterBuilds` attend la fin des builds ; `catalog-sync.ts` détecte les conflits (`detectConflicts`, statut `conflict`, reprise) et travaille sur des copies.
  - Rebranchement appelé par : `brand-preview/approve`, `product-visualize/approve`, `printify/create-product`, validation chat. `syncCatalogAfterBuilds` passe par `builder/coalesce-per-key.ts` : plusieurs validations d'affilée = un sync à la fois + une relance finale (avant, le 2e répondait « busy » et son produit n'était pas branché).
  - `routes.ts` `dropshipProductsPrompt` : pages légales imposées `/terms`, `/privacy`, `/legal-notice`, `/cookies` (+ `findLegalPage`), pas de `/legal…` inventé.
- **Chat « ajoute un produit » → vrai produit Printify** : `builder/product-intent.ts` (détection de la demande, type, motif) + `builder/chat-product-flow.ts` (flux à dépendances injectées), branché dans `/chat/stream` avant l'édition de site (`streamChatProduct`, `saveApprovedChatProduct` dans `index.ts`).
  - Printify non connecté → message + pop-up secret `PRINTIFY_API_TOKEN`. Type absent → question. Blueprint introuvable sur Printify → refus, aucun substitut.
  - Design généré (débit `image_gen`) → produit créé sur Printify → pop-up aperçu avec le **mockup officiel Printify** ; candidat dans `data/product-candidate/<companyId>.json` (TTL 30 min).
  - « Modifier » → ancien brouillon supprimé de Printify, nouveau créé. « Ajouter au site » → `schema.products` (`printifyProductId`, tags dropshipping/printify, prix plancher/cible sur coût réel) + rebranchement du site. Nouvelle demande / expiration → brouillon supprimé.
  - Prompt système : `product_preview` = visualiser seulement ; jamais pour ajouter un produit.
  - Corrigés après un test en direct sur PasStride (création → modifier → valider → site) :
    - Détection : « ajoute un mug avec un loup » (sans le mot « produit ») partait en édition de code et l'IA inventait un mug dans `catalog.ts`. `directObjectType` (`product-intent.ts`) lit le type comme complément du verbe ; faux positifs exclus (« top 10 », « case study », « logo top »…).
    - Mauvais modèle : un mug tombait sur une chope à bière (blueprint 891, départage au hasard). `printify-auto.ts` `catalogSearchTerms` exclut stein/beer/shot glass/chope sauf si demandés.
    - Texte inventé sur le design (« SAUVAGES LOUPS ») : `print-design-prompt.ts` `requestedDesignText()` → aucun texte sauf celui demandé.
    - « Modifier » : `splitPreviewFeedback` sépare le retour art (→ design) du retour produit (« mug classique 11oz » → choix du modèle). Titre et description publics construits sur le concept d'origine seulement (le retour ne fuit plus dans la fiche du site).
    - Liens légaux inventés (`/legal/cgv`) réécrits vers `/` par la réparation de liens : `LEGAL_ALIASES` / `legalAlias` dans `link-guard.ts` → `/terms`, `/privacy`…
    - Prix : l'aperçu annonçait 25 € et le site 38,99 € (le prix final était recalculé à la validation). `smart-pricing-service.ts` `quotePrintifyPrice` = même calcul que `optimizeProductPrice` (coût réel + port + marché, extrait dans `quoteFor`, lecture seule) ; l'aperçu affiche ce prix, qui est celui appliqué. Contrôle sur Urban Pulse / Stride Core : devis = optimisation = base (59,99 / 84,99 €).
- Tests : `live-qa-single-pass`, `catalog-sync-conflict`, `product-intent`, `chat-product-flow`, `coalesce-per-key`, `link-guard-legal` (`api/builder/*.test.ts`), `printify-auto-mug`, `print-design-text` (`api/`).
- Limite : le visualiseur `ProductVisualizerPopup` existe encore (produit IA sans Printify), seulement découragé par le prompt.

# Velbaz 2.0 : plus aucun modèle Claude, tout passe sur GPT 6 Luna (2026-10-03)

- `api/agent/model-mode.ts` : en mode Velbaz 2.0, `mapModelId` remplace désormais **tout id `anthropic/*`** par `VELBAZ2_TEXT_MODEL` (GPT 6 Luna) via `VELBAZ2_REPLACED_PROVIDERS = ["anthropic"]` — haiku-4.5 (premier mot du chat), sonnet-4.6, sonnet-5 (palier max), sonnet-4.5, opus, claude-3-5-haiku (test de clé), et tout futur id Claude. Hors mode : rien ne change. Les ids `openrouter/…` ne sont pas touchés.
- `api/agents/orchestrator.ts` `safeStreamTextRace` : la course au premier mot (haiku vs gpt-5.4-mini vs gemini-3-flash) est dédoublonnée sur l'id effectif ; en Velbaz 2.0 haiku et mini donnent tous deux Luna → un seul appel Luna au lieu de deux payés.
- Tests : `api/velbaz2-mode.test.ts` (+3, dont un scan de tous les `anthropic/claude-*` figés dans `api/` qui doivent tous devenir Luna). Vérifié en direct : `gateway("anthropic/claude-haiku-4.5")` et `gateway("anthropic/claude-sonnet-5")` en mode 2.0 → réponse de `openai/gpt-6-luna` (3,8 s et 1,4 s).
- Hors périmètre : l'IA embarquée des sites générés (`builder/scaffold.ts`, `AI_MODEL` par défaut sonnet-4.6) tourne dans le site déployé, pas dans le mode admin.

# Admin « Credits IA » : crédits d'un compte, projet par projet (2026-10-03)

- Nouveau bloc en haut de l'onglet admin **Credits IA** (F8) : on tape l'email d'un compte → liste de ses projets avec ce que chacun a coûté depuis toujours (USD + crédits, appels, nb de modèles, erreurs, dernier appel) → clic sur un projet → crédits dépensés, **modèles utilisés** (appels, tokens in/out, cache, images, durée moyenne, erreurs), usages (features), coût par jour, runs, et tous les appels (clic = fiche détail existante).
- Rien n'est masqué : projets sans aucun appel, projets d'autres comptes où il a dépensé (« co-édition »), projets supprimés et appels « sans projet » apparaissent aussi. Les appels système faits sur son projet (sans utilisateur dans le contexte) comptent pour le projet. Email insensible à la casse ; un compte supprimé reste trouvable via `user_email`.
- API : `GET /admin/ai-usage/account?email=…` (`api/ai-usage/account-lookup.ts`, admin only, 400 email invalide / 404 inconnu). Les routes existantes acceptent maintenant `days=all` et `companyId=none` (`admin-routes.ts` `parseFilters`, `queries.ts` `where`).
- Front : `web/components/AiCreditsAccountLookup.tsx` ; types/style/formatage sortis de `AiCreditsPanel.tsx` vers `web/components/ai-credits-shared.tsx` (rendu identique).
- Tests : `api/ai-usage/account-lookup.test.ts` (10, base SQLite en mémoire construite depuis le schéma). Vérifié en direct : john…@gmail.com → MailFlow 112 appels / 8 607 cr / 6 modèles, Nouveau projet 7 appels / 5,6 cr.

# Tous les tarifs IA alignés sur le Runable Gateway (2026-10-03)

- `ai-usage/pricing.ts` (`MODEL_PRICES`) comparé modèle par modèle au catalogue du gateway (`getAvailableModels()`, champ `pricing`). Corrigés :
  - gpt-5.4-mini 0,25/2 → **0,75/4,5** (modèle le plus appelé : facturé ~3× trop peu aux utilisateurs)
  - gpt-5.4 1,25/10 → 2,5/15 · gpt-5.4-nano 0,05/0,4 → 0,2/1,25 · deepseek-v4-flash 0,14/0,28 → 0,22/0,66
  - gemini-3.1-flash-image 0,3/2,5 → 0,5/3
  - opus-4.6 / 4.7 15/75 → 5/25 (sur-facturé 3×)
  - cache : `cacheRead` explicite partout ; `cacheWrite` = input pour OpenAI/Google/DeepSeek (le défaut 125 % inventait un surcoût que le gateway n'applique pas).
  - ajouté `openai/gpt-4o-mini` (test de clé perso) ; retiré `google/gemini-3-pro` (absent du gateway, jamais appelé).
  - inchangés car déjà justes : haiku-4.5, sonnet-4.5/4.6, sonnet-5, gpt-6-luna, gemini-3-flash, 2.5-flash-image, 3-pro-image, 3.1-flash-lite-image.
  - forfaits image (`IMAGE_FLAT_USD`) re-vérifiés sur la page tarifs Google : inchangés (0,039 / 0,034 / 0,067 / 0,24 $).
- `TOKEN_COSTS` (index.ts, gardes de solde minimum) recalculés avec le vrai prix de mini : chat 20→40, company_create 60→170, heartbeat 10→25, website_build 3900→4400, doc_gen 30→80, email_gen 15→40, ad_gen 30→80, browser_task 120→300, orchestrate 450→1200, autopilot_tick 90→240. Sonnet/image/Higgsfield inchangés. Les 5000 crédits de départ couvrent toujours création + build (4570).
- Non touché : l'historique `ai_usage_events` déjà enregistré garde les anciens coûts (déjà facturés).
- `google/gemini-2.0-flash-001` (repli de `agents/website.ts`) n'existe pas sur le gateway : ce repli échoue toujours. Signalé, non modifié.
- Test : `api/ai-usage/pricing.test.ts` (table figée du 2026-10-03 + gardes). Contrôle en direct : `AI_PRICING_LIVE=1 bun --env-file=../../.env test pricing` → 0 écart.
- Vérifs : typecheck 3/3, build 2/2, `bun test` 1360 pass / 2 fail (`preview-stub-heal`, connus), vitest 132 pass, lint 677 (baseline).

# Velbaz 2.0 sur GPT 6 Luna, plus aucune étiquette sonnet-4.6 (2026-10-03)

- Demande : en mode Velbaz 2.0, ne plus utiliser `anthropic/claude-sonnet-4.6` mais GPT 6 Luna.
- Côté serveur, c'était déjà le cas : `agent/model-mode.ts` remplace sonnet-4.6 (et gpt-5.4-mini) par `openai/gpt-6-luna` dans `gateway()`, goulot de tous les appels (engine, mobile, QA, QA live, selfheal, vision, agents, `callAI` et leurs chaînes de repli). Vérifié en direct : `gateway("anthropic/claude-sonnet-4.6")` dans le mode → le gateway répond `global.openai.gpt-6-luna`.
- Ce qui était faux :
  1. L'étiquette affichée sous chaque étape de build (`web/lib/role-models.ts`) annonçait toujours `claude-sonnet-4.6` pour Engineering, même en Velbaz 2.0 : `agent_activity` ne savait pas dans quel mode l'étape avait tourné.
  2. `openai/gpt-6-luna` n'avait pas de tarif dans `ai-usage/pricing.ts` : chaque appel du mode était compté au `DEFAULT_PRICE` (1 $/5 $ au lieu de 0,10 $/0,50 $, lu dans le catalogue du gateway).
- Correctifs :
  - Nouvelle colonne `agent_activity.model_mode` (`velbaz2` | `normal`), ajoutée au démarrage (`runtime-tables.ts`) et remplie par `$defaultFn` depuis le scope ambiant : aucun des ~150 sites d'insert n'a été touché.
  - `GET /companies/:id/jobs` renvoie `modelMode` ; `roleModel(role, modelMode)` et `marketingModel(mode)` affichent `gpt-6-luna` (texte) et `gemini-3.1-flash-image` (design) pour les étapes du mode. Lignes anciennes (null) = étiquettes normales.
  - Tarif `openai/gpt-6-luna` ajouté.
- Hors périmètre, inchangé : `builder/scaffold.ts` (IA embarquée DANS les sites générés, `AI_MODEL || sonnet-4.6`) — c'est le site de l'utilisateur final, pas le pipeline Velbaz.
- Le mode reste admin seulement, activé par le palier « Velbaz 2.0 » du chat (flag `app_config.admin_velbaz2_mode`). En base, le flag valait `0` et aucun appel Luna n'avait encore été enregistré : le build MailFlow a tourné en palier normal.
- Luna est instable via le gateway (mesuré le 2026-10-03) : 1,2 à 3 s sur une réponse courte, mais 29 s à 87 s sur des prompts longs, et deux timeouts (60 s, 150 s) sur `generateText`.
- Tests : `api/velbaz2-mode.test.ts` (model_mode à l'insert, `/jobs`, tarif), `web/lib/role-models-velbaz2.test.ts`.
- Vérifs : typecheck 3/3, build 2/2, `bun test` 1338 pass / 2 fail (`preview-stub-heal`, connus), vitest 132 pass, lint 677 (baseline).

# QA live qui « travaille à l'infini » après le build (2026-10-03)

- Symptôme : après la construction du site, le QA live annonçait les mêmes problèmes sur chaque page (MailFlow : 15 par page, 226 au total, 0 fichier corrigé). Il lançait ensuite des corrections IA inutiles et retrouvait les mêmes problèmes. Il continuait aussi après « Arrêter ».
- L'anti-boucle (`bugSignature` / `planQaRound`, max 3 passes) était bien présent et identique dans l'ancien export. Le problème venait de faux positifs, pas du nombre de tours.
- Causes, mesurées dans un vrai Chrome sur l'aperçu de MailFlow :
  1. 14 « liens morts » par page : sous l'aperçu, le router a un `basename`, donc `href` = `/api/companies/<id>/preview/contact`. Le QA comparait ce chemin complet aux routes. Correctif : `toAppPath` retire la base.
  2. « WebSocket closed without opened. » sur chaque page : c'est le client HMR de Vite, pas le site. Ajouté à `isNoise`.
  3. HTTP 401 sur `/api/auth/login` : réponse normale au robot qui soumet des identifiants de test. `isHttpBug` ignore 401/403.
  4. Vrai bug restant : aucune route `/`, car le plan avait mis l'accueil sur `/accueil`. Le logo menait à la 404 partout. Correctif : `ensureHomeRoute` (engine.ts, dans `orderPages`) sert toujours une page sur `/`.
  5. `link-guard` ne voyait pas les tableaux de navigation `{ to: "/x" }`. Il ne voyait pas non plus `window.location.href = "/x"`, qui sort du basename et donne un 404 en aperçu. L'IA « corrigeait » ce 404 en inventant `/register` et cassait un lien correct. Maintenant :
     - ces cas sont détectés et recâblés de façon déterministe ;
     - `rebaseHardNavigations` préfixe `import.meta.env.BASE_URL`, ce qui ne change rien en export ;
     - `isBaseEscapeHttp` les retire de l'IA ;
     - le prompt de correction reçoit la liste des routes réelles.
  6. Arrêt : `fixBugsLive` s'arrête dès l'annulation. Le job `build-website` lève `assertJobNotCancelled` juste après le QA. Avant, il enchaînait marketing et PR après « Arrêter ».
- Vérifié :
  - Copie jetable de MailFlow (avec `/` comme le ferait `ensureHomeRoute`), étape link-guard du build, puis `runLiveQAAndFix` : 1 passe, 17/17 pages OK, 0 bug, 0 appel IA. Avant : 226 problèmes.
  - Tests : `api/builder/live-qa-noise.test.ts`.
- Non vérifié : un build complet depuis le chat. Le projet MailFlow lui-même n'a pas été modifié.
- Pourquoi le bug « est revenu » après l'export : non établi. `api/builder/` est identique dans l'ancien export. Les faux positifs existaient donc probablement déjà, et l'ancien correctif bornait seulement le nombre de tours.

# Idée du projet après une conversation mixte (2026-10-02)

- Bug : dans un même chat, l'utilisateur demande un mail, un appel et un SMS, puis des idées de business. Il choisit « 1 » (Studio de Mode Circulaire) et lance le build. Le projet créé est « MailFlow », une boutique d'envoi de mails, d'appels et de SMS.
- Causes :
  - `triggerBuild` (`web/pages/chat.tsx`) envoyait tout le transcript comme idée, échanges d'actions compris. Le 1er message concret, « envoie moi un mail », devenait le sujet verrouillé.
  - La réponse « Laquelle de ces pistes… ?: 1 » perdait son sens, parce que `stripAiTurns` supprime la liste d'idées de l'IA.
  - `refreshMeta` n'était pas attendu, donc `/plan-pages` pouvait encore lire l'idée du projet pré-créé au 1er message.
- Correctif : nouveau module pur `api/project-transcript.ts` (`focusProjectTranscript`), appliqué côté client dans `triggerBuild` et côté serveur dans `normalizeIdea` et dans le prompt de découverte de l'orchestrateur.
  - Chaque échange d'action est retiré (mail, appel, SMS, image, PDF), avec les questions, réponses et confirmations qui suivent, jusqu'au prochain message qui reparle du projet.
  - Un choix par numéro (« 1 », « la 2 », « la première »…) est remplacé par l'option réellement proposée : `[IDÉE CHOISIE] Titre — description`.
  - Les marqueurs internes de l'IA (`[CALL_VIEW]`, `[QUESTIONS_ASKED]`, `[FILE:…]`) sont retirés.
  - `resolveSubject` (`idea-subject.ts`) : l'idée choisie devient le sujet verrouillé. Seule une description concrète écrite ensuite par l'utilisateur la remplace. Les demandes d'action, les demandes d'idées, « décide toi-même » et « es-tu prêt ? » ne peuvent plus être un sujet.
  - `triggerBuild` attend de nouveau `refreshMeta`. La route écrit l'idée avant de répondre, et la génération du nom reste en tâche de fond.
- Vérifié de bout en bout sur la vraie conversation, avec un projet pré-créé sur « envoie moi un mail » puis `refresh-meta`. Envoi nettoyé par le client → « LoopMode », Fashion, « Boutique en ligne de mode circulaire… ». Ancien transcript brut → « CircularLoop », même sujet. Données de test supprimées.
- Tests `api/project-transcript.test.ts` (13). Typecheck, build et tests OK (1321/1323, mêmes 2 échecs connus `preview-stub-heal`), lint 677 (baseline).
- Non corrigé automatiquement : le projet existant « MailFlow » (`547d2b5d-…`) garde son idée actuelle.

# Autorisation des routes `/companies/:id` (2026-10-02)

- Faille : une quarantaine de routes `/companies/:id/*` d'`api/index.ts` ne vérifiaient que la connexion, ou rien du tout. N'importe quel compte, parfois même un visiteur anonyme, pouvait lire ou modifier les données d'un autre projet en changeant l'id dans l'URL.
- Correctif : chaque route ouvre maintenant sur une garde. Sans session, la réponse est 401. Si le projet appartient à quelqu'un d'autre, la réponse est 404, pour ne pas révéler son existence.
  - `requireCompanyOwner` (propriétaire ou admin) : emails, `email-config` (GET), `emails/inbox`, ads, `ads/video/queue`, `higgsfield/*` (status, motions, soul-styles, soul-ids, jobs, upload), `browser-tasks` (GET), suppliers, products, designs, shipping. Même règle que les routes d'écriture voisines, déjà réservées au propriétaire.
  - `requireCompanyAccess` (propriétaire, admin ou collaborateur accepté) : `jobs/:jobId`, `agent-actions`, revenue, skills, `dynamic-specialists`, `autopilot/*` (approval-mode, plan, logs, insights, tasks, slots, `activity-since`, création, reorder, édition, move, schedule, suppression, reflect, approve, reject, config) et `plan/accept`. Même règle que les routes voisines `accessibleCompany`.
- Durcissements associés :
  - `jobs/:jobId` refuse un job d'un autre projet.
  - `approve` et `reject` vérifient que la tâche appartient au projet (`autopilotTaskBelongsTo`). Avant, une tâche se validait par son seul id.
  - `POST suppliers|products|shipping` passent le corps par `stripTenantFields` (`api/company-authz.ts`). Le client ne peut plus imposer `id`, `companyId` ni `userId`. Avant, `...body` permettait d'écrire dans le projet d'un autre.
- Routes laissées publiques volontairement (le site généré les appelle pour ses visiteurs sans compte) : `website*`, `checkout/validate`, `catalog`, `orders/confirm`, `contact`, `orders/webhook` (signé Stripe).
- Test de non-régression `api/company-authz.test.ts` : toute nouvelle route `/companies/:id/*` sans garde en tête fait échouer le test, sauf si elle figure dans la liste blanche.
- Vérifié de bout en bout avec deux comptes : 31 routes, anonyme → 401, autre compte → 404, propriétaire OK. L'injection de `companyId`/`id` est neutralisée. B ne peut pas approuver une tâche de A. Typecheck, build et tests OK (1305/1307, mêmes 2 échecs connus `preview-stub-heal`), lint 677 (baseline).

# Prix automatique, page « Prix » supprimée (2026-10-02)

- L'onglet « Prix » du dashboard du site a été retiré. Fichiers concernés : `ProjectDashboard.tsx`, `chat.tsx` et `PricingPanel.tsx`, qui est supprimé. Les routes manuelles `/companies/:id/pricing/analysis|optimize` ont été supprimées.
- Le prix parfait (coût réel Printify + port + marché, `smart-pricing.ts`) est appliqué automatiquement :
  - à la création de produit sans prix choisi (route `/printify/products` et maintenant `POST /products`) ;
  - au build ;
  - à l'approbation de la marque ;
  - à la synchro Printify (nouveau) ;
  - lors d'une vérification de toute la boutique, au plus une fois toutes les 12 h, à l'ouverture du projet (`autoRepriceCompany`, lancée par le sondage `/orders/availability`).
- Un prix trop bas ou trop haut est corrigé (base, Printify, catalogue du site). Un prix déjà dans la bonne fourchette n'est pas retouché (`onlyIfOff`).
- Vérifié : 12 € (trop bas) → 26,99 € corrigé ; 29,50 € (bon prix) laissé tel quel. L'ancienne route répond 404. Typecheck, build et tests OK (1298/1300, mêmes 2 échecs connus), lint 677 (baseline).

---

# Actions réelles du chat + expéditeur propre aux sites (2026-10-02)

**1. L'IA utilise toujours ses outils.** « Envoie-moi un mail », « génère une image », « fais un PDF du business plan » sont détectés (`agents/action-intent.ts`) avant tout routage (découverte, agents, spécialistes, édition du site) et envoyés vers la boucle d'outils, qui dispose de `send_email`, `generate_image` et `create_document` (`agent-tools/action-tools.ts`).
- Réponse à une question posée pendant l'action (« son adresse c'est … ») : reprise de l'action, même sans « ? » dans la question de l'IA.
- Deux filets : un refus (« je ne peux pas ») déclenche une relance. Un « email envoyé » sans appel réel de `send_email` est rejoué en action, ou remplacé par un message d'échec honnête.
- Email : par défaut à l'adresse du compte. Un tiers seulement si l'utilisateur a tapé l'adresse. Limite de 10 emails par heure et par utilisateur. Images débitées en crédits.

**2. Emails des sites au nom du site.** Tout email envoyé pour un site généré (leads, contact, confirmations de commande, dropshipping, autopilot, outreach, envoi depuis le chat projet) part avec le nom du site (`email-sender.ts`, `email-sender-load.ts`). Le reply-to est l'adresse du site ou de son propriétaire. Les mails de la plateforme (reset, invitations, projet prêt, self-heal) restent Velbaz.
- Avec Resend : le nom affiché est celui du site, l'adresse reste celle de `RESEND_FROM`.
- Pour une adresse dédiée par site : domaine vérifié + `email_config.from_email` sur ce domaine, ou secret optionnel `SITE_EMAIL_DOMAIN`.
- Avec la seule commande `send-email` : expéditeur par défaut (un domaine non vérifié est refusé) ; l'API le signale via `senderNote`.

**Vérifié :** typecheck, build, bun test 1298/1300 (les 2 `preview-stub-heal` connus), vitest 132/132, lint 677 (baseline). De bout en bout, les emails ont bien été reçus, avec le nom du site comme expéditeur pour un projet. L'image a bien été générée et le PDF du business plan créé. La question « tu peux envoyer des emails ? » n'a rien envoyé, et « crée un site qui envoie des mails » est resté sur le build. Les données de test ont été supprimées.

---

# Migration — velbaz13.2-9129 → app Runable managée (2026-10-02)

Le repo `https://github.com/johnghost-j/velbaz13.2-9129.git` (template 0.8.0) a été copié sur un scaffold managé neuf (template 0.8.0) avec une infra fraîchement provisionnée (`.env` : Turso, Tigris S3, passerelle IA, auth, Autumn).

| Étape | Résultat |
| --- | --- |
| Fichiers | 782/782 fichiers suivis, identiques à l'octet |
| Fichiers protégés `__*` | 16/16 identiques au template, aucune restauration nécessaire |
| bun install / db:push | ok / "Changes applied" |
| typecheck + build | ok (build 35 s) |
| Tests | bun test 1246/1248 (les 2 échecs `preview-stub-heal` passent 16/16 en isolé : interférence entre fichiers de test, préexistante), vitest 80/80 |
| Dev (4200) + prod (`bun run start`, pm2) | /, /login, /dashboard, /chat, /editor, /plans, /api/health → 200, aucune erreur JS |
| Auth + DB | register/login ok (bonus 5000 crédits), utilisateur de test supprimé |
| Passerelle IA | GATEWAY OK |
| Lint | 0 violation d'intégrité template / fichiers protégés / assets ; erreurs de style oxlint préexistantes |

Non transférable via git : contenu de l'ancienne base et clés saisies dans Admin Panel → API Keys — à ressaisir (liste : `API-KEYS.md`).

---

# Migration — velbaz12.2-3139 → app Runable managée (2026-10-01)

Le repo `https://github.com/johnghost-j/velbaz12.2-3139.git` (template 0.8.0) a été copié sur un scaffold managé neuf (template 0.8.0) avec une infra fraîchement provisionnée (`.env` : Turso, Tigris S3, passerelle IA, auth, Autumn).

| Étape | Résultat |
| --- | --- |
| Fichiers | 709/709 fichiers suivis, identiques à l'octet |
| Fichier protégé `__core/app.ts` | Le repo l'avait modifié (CORS) → restauré à l'original du template ; même durcissement (pas d'`Access-Control-Allow-Credentials`, pas de `set-auth-token` exposé) réappliqué dans `src/api/index.ts` (enveloppe `securedApp`) |
| bun install / db:push | ok / "Changes applied" |
| typecheck + build | ok |
| Tests | bun test 893/893, vitest 80/80 |
| Dev (4200) + prod (`bun run start`, pm2) | /, /login, /dashboard, /chat, /editor, /plans, /api/health → 200 |
| Auth + DB | register/login ok (bonus 5000 crédits), utilisateur de test supprimé |
| Passerelle IA | GATEWAY OK |
| Lint | 0 violation d'intégrité template / fichiers protégés / assets ; erreurs de style oxlint préexistantes (no-unused-vars, exhaustive-deps, max-lines) |

Non transférable via git : contenu de l'ancienne base (comptes, projets) et clés saisies dans Admin Panel → API Keys ou dans l'ancien `.env` (ex. TWENTY_FIRST_API_KEY) — à ressaisir.

**Liste à jour des clés API : `API-KEYS.md`** (2026-10-01). Aucune n'est obligatoire ; seuls 16 outils en ont besoin (SMS passés de Twilio à Bland.ai), tous saisissables dans Admin Panel → API Keys. IA, hébergement et domaines n'en demandent aucune. Les inventaires plus bas sont historiques.

---

# Migration — velbaz7-1022 → managed Runable app (velbaz7)

Second port. `https://github.com/johnghost-j/velbaz7-1022.git` (template 0.7.0) was copied onto a freshly provisioned managed app scaffold (template **0.8.0**). Nothing from the repo was dropped: 524 repo files → 524 identical files in the app, plus the provisioned `.env`.

## What was verified (2026-09-11)

| Step                                            | Result                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| File-level completeness                         | 524/524 repo files present, byte-identical                                                                                     |
| Protected template files                        | 13/13 identical between 0.7.0 and 0.8.0 — only \_\_ports.cjs changed (now reads .runable/ports.json), kept from the new scaffold |
| Dependency install                              | ok (bun install, isolated per-package node\_modules)                                                                            |
| Schema push to Turso                            | ok (db:push → "Changes applied")                                                                                               |
| Full build                                      | ok (bun run build → tsc --noEmit + vite build, 2/2 packages, 1m41s)                                                            |
| Dev server                                      | ok on port 4200                                                                                                                |
| Routes / /login /dashboard /chat /editor /plans | all HTTP 200, rendered and screenshotted                                                                                       |
| /api/health                                     | HTTP 200 {"status":"ok"}                                                                                                       |
| Auth + DB write                                 | POST /api/auth/register then /api/auth/login → 200, user created with 5000-credit signup bonus (test user deleted afterwards)  |
| AI gateway                                      | ok (bun gw-check.ts → "GATEWAY OK")                                                                                            |
| Lint integrity                                  | 0 template-integrity / protected-file / asset-location violations                                                              |

## Managed infra provisioned (live in root `.env`)

New values, provisioned for this app — not the previous sandbox's keys:

`DATABASE_URL`, `DATABASE_AUTH_TOKEN` (Turso), `S3_*` (Tigris storage), `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY`, `BETTER_AUTH_SECRET`, `AUTUMN_SECRET_KEY`, `APPLICATION_ID`, `WEBSITE_URL`, `VITE_RUNABLE_AUTH_ISSUER`, `VITE_APPLICATION_ID`, `RUNABLE_URL`.

Ports are fixed in `.runable/ports.json` (web 4200, mobile 4300, desktop 4400).

## Optional integration keys NOT set

The code reads these; the app boots and runs without them. Every feature degrades honestly — it announces the missing key instead of faking a result — and stays inert until the key is supplied.

**Two ways to supply a key.** Keys marked **Admin Panel** are in `KNOWN_SECRETS` (`packages/web/src/api/secret-store.ts`): they are entered at runtime from Admin Panel → API Keys, stored AES-encrypted in the DB, and no restart or `.env` edit is needed. Keys marked **.env** are read straight from `process.env` and require an `.env` entry plus a restart.

### Payments — Stripe (`api/billing.ts`)

| Key                   | Where       | Effect if missing                                                                                                                                      |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| STRIPE\_SECRET\_KEY     | Admin Panel | No real checkout. Plans page and credit packs stay visible but report that payment is unconfigured.                                                    |
| STRIPE\_WEBHOOK\_SECRET | Admin Panel | Optional even with Stripe live: /api/billing/webhook skips signature verification, and the return-to-site confirmation path still credits the account. |

### Custom domains (`api/domains.ts`)

Works with **zero keys**: real DNS verification (DNS-over-HTTPS, Cloudflare + Google fallback), domain uniqueness, and serving the published site on the customer's domain over **HTTP**.

| Key                  | Where       | Effect if missing                                                                                                                                                                                                                                               |
| -------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLOUDFLARE\_API\_TOKEN | Admin Panel | No automatic HTTPS/CDN on customer domains (Cloudflare for SaaS). Needs the "SSL and Certificates: Edit" permission. Domain still connects, verifies and serves over HTTP; the UI says so rather than advertising a nonexistent certificate (ssl: "unmanaged"). |
| CLOUDFLARE\_ZONE\_ID   | Admin Panel | Same. Required together with the token — the zone that hosts the custom hostnames.                                                                                                                                                                              |
| VELBAZ\_DOMAIN\_TARGET | Admin Panel | Optional override. CNAME target announced to customers. Default cname.velbaz.site.                                                                                                                                                                              |
| VELBAZ\_ROOT\_DOMAIN   | Admin Panel | Optional override. Hosting root domain used for \*.velbaz.site subdomains. Default velbaz.site.                                                                                                                                                                  |
| VELBAZ\_DEPLOY\_TOKEN  | Admin Panel | Optional external hosting provider token. Without it the site is still published on Velbaz's own hosting (/s/:subdomain).                                                                                                                                       |

A key present but **invalid** is distinguished from a key absent: the Cloudflare call is really made, its rejection is surfaced, and the state becomes `ssl: "failed"` (vs `"unmanaged"`).

### Domain purchase — registrar Namecheap (`api/index.ts`)

Availability search (RDAP, public) works without any key. The 4 below are required **together**; without them the purchase endpoint answers `501` and names the missing keys.

| Key                 | Where                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| NAMECHEAP\_API\_USER  | Admin Panel                                                                 |
| NAMECHEAP\_API\_KEY   | Admin Panel                                                                 |
| NAMECHEAP\_USERNAME  | Admin Panel                                                                 |
| NAMECHEAP\_CLIENT\_IP | Admin Panel — the server IP must be whitelisted in Namecheap's API settings |

### Error monitoring & self-healing — Sentry (`api/selfheal/sentry.ts`)

| Key | Where | Effect if missing |
|-----|-------|-------------------|
| `SENTRY_DSN` | Admin Panel | Errors are not sent to Sentry. Self-healing falls back to the internal `error_logs` stream. |
| `SENTRY_AUTH_TOKEN` | Admin Panel | Self-healing cannot READ issues back from the Sentry API. |
| `SENTRY_ORG` | Admin Panel | Required with the auth token (org slug). |
| `SENTRY_PROJECT` | Admin Panel | Required with the auth token (project slug). |
| `SENTRY_API_URL` | Admin Panel | Optional. Only for self-hosted Sentry; defaults to `sentry.io`. |

Note: no Sentry value is stored in the repo or in the root `.env` — the five keys
are entered in the Admin Panel (encrypted secret store) when you want Sentry on.
`SELFHEAL_DISABLED=1` (env) turns self-healing off entirely.

### Email (`api/email.ts`)

| Key                  | Where       | Effect if missing                                               |
| -------------------- | ----------- | --------------------------------------------------------------- |
| RESEND\_API\_KEY       | Admin Panel | No transactional email is sent.                                 |
| RESEND\_FROM          | Admin Panel | Default "from" address, e.g. Velbaz <no-reply@ton-domaine.com>. |
| EMAIL\_WEBHOOK\_SECRET | Admin Panel | Incoming email webhooks are not signature-verified.             |

### Media generation — Higgsfield (`api/higgsfield.ts`)

| Key                                                            | Where       | Effect if missing                                                     |
| -------------------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| HF\_API\_KEY / HF\_API\_SECRET                                     | Admin Panel | Image/video generation via Higgsfield is unavailable.                 |
| HF\_CREDENTIALS                                                 | Admin Panel | Alternative combined form (key:secret).                               |
| HIGGSFIELD\_KEY\_ID / HIGGSFIELD\_KEY\_SECRET / HF\_KEY / HF\_SECRET | .env        | Legacy env fallbacks, read only if the Admin Panel values are absent. |
| HF\_BASE\_URL                                                    | .env        | Optional API base override.                                           |

### GitHub export (`api/github.ts`)

| Key          | Where       | Effect if missing                           |
| ------------ | ----------- | ------------------------------------------- |
| GITHUB\_TOKEN | Admin Panel | Projects cannot be exported to GitHub.      |
| GITHUB\_OWNER | Admin Panel | Target account/organization for the export. |

### Builder & AI extras

| Key                                                                                                                             | Where | Effect if missing                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| TWENTY\_FIRST\_API\_KEY                                                                                                            | .env  | No 21st.dev premium React components; the builder falls back to its own generated components.        |
| FIRECRAWL\_API\_KEY                                                                                                               | .env  | Web scraping uses the local headless browser instead of Firecrawl.                                   |
| OPENROUTER\_API\_KEY                                                                                                              | .env  | OpenRouter routing unavailable (an openrouter provider key in the secret store also satisfies this). |
| AI\_MODEL, IMAGE\_MODEL, UNCENSORED\_MODEL, TIER\_MODEL\_LITE/\_PRO/\_MAX, BUILDER\_REPAIR\_MODEL, SELFHEAL\_MODEL, COMMS\_REASONING\_MODEL | .env  | Model overrides. Built-in defaults are used.                                                         |
| AI\_CREDITS\_PER\_USD                                                                                                              | .env  | Credit-to-USD conversion rate. Default applies.                                                      |
| SELFHEAL\_DISABLED                                                                                                               | .env  | Set to disable automatic self-healing.                                                               |

### Social publishing (`api/social/`)

OAuth client pairs, all **.env**. Each platform's publishing stays disabled until its pair is set: `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`/`DISCORD_BOT_TOKEN`, `INSTAGRAM_CLIENT_ID`/`INSTAGRAM_CLIENT_SECRET`, `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`, `TWITTER_CLIENT_ID`/`TWITTER_CLIENT_SECRET`, plus `OAUTH_REDIRECT_BASE`, `OAUTH_STATE_SECRET` and `X_LIVE_ENABLED`.

### Platform / operational

| Key                                                                                  | Where | Effect if missing                                                                                   |
| ------------------------------------------------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------- |
| SECRET\_STORE\_KEY                                                                     | .env  | The API-key vault falls back to BETTER\_AUTH\_SECRET for encryption. Set it explicitly in production. |
| ADMIN\_EMAILS                                                                         | .env  | Falls back to the built-in default admin address — set it to control who reaches the admin pages.   |
| BETA\_PUBLIC\_CODE, BETA\_ADMIN\_CODE, BETA\_MAX\_TESTERS                                  | .env  | Beta access codes and tester cap; defaults apply (VELBAZ-BETA).                                     |
| PUBLIC\_BASE\_URL / APP\_BASE\_URL / VELBAZ\_URL / VELBAZ\_API\_URL                         | .env  | Absolute-URL generation falls back to WEBSITE\_URL.                                                  |
| VELBAZ\_APPS\_ROOT, CHIMERA\_ASSETS\_DIR, MAX\_AUTO\_RELAUNCH\_PER\_BOOT, DISABLE\_SERVER\_JSX | .env  | Builder runtime paths and limits; defaults apply.                                                   |

## Known inherited debt

`bun run lint` reports 595 errors, all pre-existing in the copied source (579 on 0.7.0; the extra 16 come from newer rules in 0.8.0). Breakdown: `no-unused-vars` (156), `react-hooks/exhaustive-deps` (43), `max-lines` (5), misc unicorn/eslint. Build and runtime are unaffected.

## Commands

```
bun run dev      # web on 4200
bun run build    # build all packages
bun run start    # pm2 production server
cd packages/web && bun run db:push
```

---

# Migration — velbaz9-3083 → managed Runable app (velbaz9), 2026-09-18

Troisième portage. `https://github.com/johnghost-j/velbaz9-3083.git` (template **0.8.0**) copié sur un scaffold d'app managée fraîchement provisionné (template **0.8.0**, même version → aucune migration de plumbing nécessaire). **596 fichiers du dépôt → 596 fichiers présents**, tous identiques sauf les 5 documentés ci-dessous, plus le `.env` provisionné et `.runable/`.

## Infra managée provisionnée (dans le `.env` racine)

Nouvelles valeurs, propres à cette app (pas celles de l'ancien sandbox) :
`DATABASE_URL`, `DATABASE_AUTH_TOKEN` (Turso), `S3_*` (Tigris), `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY`, `BETTER_AUTH_SECRET`, `AUTUMN_SECRET_KEY`, `APPLICATION_ID`, `WEBSITE_URL`, `VITE_RUNABLE_AUTH_ISSUER`, `VITE_APPLICATION_ID`, `RUNABLE_URL`.
Ports fixes dans `.runable/ports.json` : web 4200, mobile 4300, desktop 4400.

## Le seul vrai problème rencontré : 2 fichiers template-managed patchés

Le dépôt livrait `packages/web/src/__server.ts` et `packages/web/vite/__plugins/hono-dev-plugin.ts` **modifiés** (routage par nom d'hôte pour les domaines clients + `/s/:subdomain`). Ces deux fichiers sont protégés (`.runable/protected-files.json`) : `bun run lint` échouait avec 2 « template error », ce qui casse la chaîne de déploiement de la plateforme.

Corrigé **sans perdre la fonctionnalité** — la logique a été déplacée dans des fichiers éditables :

| Fichier | Action |
| --- | --- |
| `packages/web/src/__server.ts` | **restauré à l'identique du template** (sha256 `aeb8b19c…3098e` = `protected-files.json`) |
| `packages/web/vite/__plugins/hono-dev-plugin.ts` | **restauré à l'identique du template** (sha256 `e29bea99…a014a7`) |
| `packages/web/src/server.ts` | serveur de production **du dépôt, inchangé** (en-têtes de sécurité + `idleTimeout: 255` + routage domaines/`/s/`) — il contenait déjà toute la logique retirée de `__server.ts` |
| `ecosystem.config.cjs` | pm2 lance désormais `packages/web/src/server.ts` (au lieu de `__server.ts`), donc les domaines clients et les en-têtes CSP sont bien servis en prod |
| `packages/web/package.json` | `"start": "bun src/server.ts"` (idem) |
| `packages/web/vite/plugins/custom-domain-plugin.ts` | **nouveau** — en DEV, réécrit `req.url` (hôte client → `/api/s/:sub/...`, `/s/*` → `/api/s/*`) puis passe la main. Monté **en premier** dans `vite.config.ts`, donc avant `api-stream-plugin` (streaming SSE) et `hono-dev-plugin`. Remplace exactement le patch qui était dans le fichier protégé. |
| `packages/web/vite.config.ts` | import + montage de `customDomainPlugin()` en tête de la liste des plugins |

Résultat : `bun run lint` → **0 erreur d'intégrité template**, et le routage par hôte fonctionne en dev comme en prod.

## Vérifié le 2026-09-18

| Étape | Résultat |
| --- | --- |
| Complétude fichier par fichier | 596/596 présents, octet pour octet identiques hors les 5 fichiers du tableau |
| Fichiers protégés | 16/16 conformes à `protected-files.json` (sha256 recalculés) |
| `bun install` | ok (node_modules isolés par package) |
| `bun run db:push` (Turso) | ok — « Changes applied » |
| `bun run build` | ok, exit 0 (tsc --noEmit + vite build, 2/2 packages) |
| Serveur dev | ok sur 4200, `/api/health` → 200 `{"status":"ok"}` |
| Routes `/ /login /dashboard /chat /editor /plans /admin /pricing` | 200, rendu vérifié par capture |
| `/s/:subdomain` inexistant | 404 de l'API (donc bien routé vers l'API, pas vers le SPA) — en dev **et** en prod |
| Serveur de production (`src/server.ts`, PORT=4599) | `/api/health` 200, `/` 200 avec CSP + HSTS + X-Frame-Options, `/s/*` 404 |
| Écriture en base | `POST /api/auth/register` puis `/api/auth/login` → 200, utilisateur créé avec bonus 5000 crédits, **puis supprimé** (sessions + token_transactions inclus ; table `users` revenue à 0 ligne) |
| Passerelle IA | ok — `bun gw-check.ts` → « GATEWAY OK » |
| Intégrité template (`bun run lint`) | 0 violation |

## Dette héritée (inchangée)

`bun run lint` (oxlint) remonte **612 erreurs, toutes préexistantes dans le code copié** (a11y `control-has-associated-label`, `no-unused-vars`, `exhaustive-deps`, `max-lines`…). Aucune ne concerne les fichiers touchés par ce portage. Build et runtime intacts.

## Clés optionnelles toujours absentes

Aucune clé d'intégration n'a été reportée de l'ancien sandbox (Stripe, Cloudflare, Namecheap, Sentry, Resend, Higgsfield, GitHub, OAuth réseaux sociaux, 21st.dev, Firecrawl, OpenRouter). Les clés marquées **Admin Panel** se saisissent à chaud dans Admin Panel → API Keys (chiffrées en base, sans redémarrage) ; celles marquées **.env** exigent une ligne dans le `.env` racine + un redémarrage. *(Historique — la liste à jour est `API-KEYS.md`.)*

---

# Inventaire complet des clés & variables — à jour 2026-09-19

Établi en relisant **tout** le code (`process.env.*`, `process.env['*']`, `getSecret('*')` dans `packages/web/src`, `packages/mobile`, `packages/desktop`) : **96 identifiants** lus par l'application. Chacun figure ci-dessous.

## Les 4 endroits où une clé peut vivre

| Emplacement | Comment on y met une clé | Prise en compte | Portée |
| --- | --- | --- | --- |
| **Infra managée** | Provisionnée par Runable dans le `.env` racine | au boot | instance |
| **Admin Panel** | Admin Panel → API Keys (chiffré AES-256-GCM en base, table `secret_store`) | **à chaud, sans redémarrage** | instance |
| **`.env` racine** | Une ligne `CLE=valeur` dans `/home/user/velbaz9/.env` | après redémarrage | instance |
| **Secret d'entreprise** | Pop-up « secret » du chat IA (table `company_secrets`) | immédiat | une seule entreprise |

Ordre de priorité à la lecture (`getSecret()`) : **secret d'entreprise → Admin Panel → `.env`**. Une entreprise qui enregistre sa propre clé (ex. `PRINTIFY_API_TOKEN`) vend sur son propre compte, sans toucher à celui de l'exploitant. Les variables qui ne passent pas par `getSecret()` (préfixes `VITE_`, `EXPO_PUBLIC_`, chemins runtime) sont lues **uniquement** dans le `.env`.

⚠️ Tout ce qui est préfixé `VITE_` ou `EXPO_PUBLIC_` est **embarqué dans le bundle client** : jamais de secret là-dedans.

## 1. Infra managée — déjà en place ✅

| Clé | Rôle | Effet si absente |
| --- | --- | --- |
| DATABASE\_URL, DATABASE\_AUTH\_TOKEN | Base Turso (libSQL) | L'app ne démarre pas. |
| S3\_ENDPOINT, S3\_BUCKET, S3\_ACCESS\_KEY\_ID, S3\_SECRET\_ACCESS\_KEY | Stockage Tigris (uploads, photos de profil, assets générés) | Tout envoi de fichier échoue (dont l'avatar de compte). |
| AI\_GATEWAY\_BASE\_URL, AI\_GATEWAY\_API\_KEY | Passerelle IA Runable (`api/agent/gateway.ts`) | Aucune génération IA : chat, builder, images. |
| BETTER\_AUTH\_SECRET | Signature des sessions | Sessions invalides ; sert aussi de repli à `SECRET_STORE_KEY`. |
| AUTUMN\_SECRET\_KEY, APPLICATION\_ID | Facturation managée / identité de l'app | Fonctions plateforme dégradées. |
| WEBSITE\_URL | URL publique canonique | Repli final de toutes les URL absolues générées. |
| RUNABLE\_URL, VITE\_RUNABLE\_AUTH\_ISSUER, VITE\_APPLICATION\_ID | Émetteur d'auth + identité côté navigateur | Connexion plateforme cassée. |
| NODE\_ENV | `development` / `production` | Bascules de comportement (logs, CSP, HMR). |

## 2. Intelligence artificielle

| Clé | Où | Effet si absente |
| --- | --- | --- |
| Clés provider perso : **openai**, **anthropic**, **google**, **custom** | Admin Panel → API Keys | Tout passe par la passerelle Runable. Une clé perso active route en **direct** chez le fournisseur ; marquée `invalid` par un test, elle retombe automatiquement sur la passerelle. |
| OPENROUTER\_API\_KEY | .env *(ou provider `openrouter` dans le panel)* | Pas de routage OpenRouter. |
| TWENTY\_FIRST\_API\_KEY | .env | Pas de composants React premium 21st.dev ; le builder génère les siens. |
| FIRECRAWL\_API\_KEY | .env | Le scraping web utilise le navigateur headless local. |
| AI\_CREDITS\_PER\_USD | .env | Taux crédits → USD ; valeur par défaut. |

### Surcharges de modèles (toutes `.env`, toutes optionnelles)

| Clé | Défaut codé |
| --- | --- |
| AI\_MODEL | modèle de chat par défaut |
| IMAGE\_MODEL | modèle d'image par défaut |
| UNCENSORED\_MODEL | modèle sans filtre |
| TIER\_MODEL\_MAX | `anthropic/claude-sonnet-5` |
| TIER\_MODEL\_PRO | `openai/gpt-5.4-mini` |
| TIER\_MODEL\_LITE | `openai/gpt-5.4-nano` |
| BUILDER\_REPAIR\_MODEL | réparation de build du builder |
| SELFHEAL\_MODEL | module d'auto-réparation |
| COMMS\_REASONING\_MODEL | raisonnement des communications |
| SELFHEAL\_DISABLED | *(non définie)* — la mettre à `1` coupe l'auto-réparation |

### Labo `/test1` (`api/test1-lab.ts`) — code produit, surcharges `.env`

| Clé | Défaut codé |
| --- | --- |
| TEST1\_BRAIN\_MODEL | `anthropic/claude-sonnet-4.6` |
| TEST1\_VISION\_MODEL | `anthropic/claude-sonnet-4.6` |
| TEST1\_IMAGE\_MODEL | `google/gemini-3.1-flash-lite-image` |
| TEST1\_SKILL\_DIR | le skill bundlé `packages/web/skill_test1/` — override de dev uniquement |

## 3. Paiements — Stripe (`api/billing.ts`)

| Clé | Où | Effet si absente |
| --- | --- | --- |
| STRIPE\_SECRET\_KEY | Admin Panel | Pas de vrai checkout : la page Plans et les packs de crédits restent visibles mais annoncent un paiement non configuré. |
| STRIPE\_WEBHOOK\_SECRET | Admin Panel | Optionnelle même avec Stripe en live : `/api/billing/webhook` saute la vérification de signature, et le retour-sur-site crédite quand même le compte. |

## 4. Printify — impression à la demande ✅ *(token déjà présent dans le `.env`)*

Il n'y a **jamais de mode démo** ici : chaque produit part réellement en production. Sans token qui fonctionne, rien n'est créé.

| Clé | Où | Effet si absente |
| --- | --- | --- |
| PRINTIFY\_API\_TOKEN | Secret d'entreprise → Admin Panel → **.env (présent)** | Aucune création de produit ni de commande. Token personnel : Printify → Settings → Connections → API. |
| PRINTIFY\_SHOP\_ID | idem | Optionnelle : on prend la première boutique du compte. |
| PRINTIFY\_BASE\_URL | idem | Override de l'URL d'API ; défaut officiel. |
| PRINTIFY\_ARTWORK\_DEBUG | .env | La mettre à `1` trace la génération des visuels produit (`printify-artwork.ts`). |

## 5. Connexion Google — « Continuer avec Google » ❌ *(nouveau, 2026-09-19)*

Ajouté avec la photo de profil de compte (`api/google-auth.ts`, `api/avatar.ts`). Les deux premières sont **requises ensemble** : Google Cloud → APIs & Services → Credentials → OAuth client ID, type *Web application*, avec pour Redirect URI `<WEBSITE_URL>/api/auth/google/callback`.

| Clé | Où | Effet si absente |
| --- | --- | --- |
| GOOGLE\_CLIENT\_ID | Admin Panel | Le bouton « Continuer avec Google » de `/login` et `/register` reste grisé et affiche « Connexion Google pas encore configurée ». `GET /auth/providers` renvoie `google: false`. |
| GOOGLE\_CLIENT\_SECRET | Admin Panel | Idem — l'échange du code d'autorisation est impossible sans elle. |
| GOOGLE\_STATE\_SECRET | .env | Optionnelle : le paramètre `state` anti-CSRF est signé avec le repli `SESSION_SECRET` → `DATABASE_AUTH_TOKEN`. À définir en production pour découpler les deux. |

Sans Google, l'inscription par email et l'envoi manuel d'une photo de profil (ou Gravatar) fonctionnent normalement.

## 6. Email — Resend

| Clé | Où | Effet si absente |
| --- | --- | --- |
| RESEND\_API\_KEY | Admin Panel | Aucun email transactionnel envoyé (les envois sont journalisés, pas livrés). |
| RESEND\_FROM | Admin Panel | Adresse d'expédition ; un défaut s'applique. |
| EMAIL\_WEBHOOK\_SECRET | Admin Panel | Les webhooks Resend (ouvertures, bounces) ne sont pas vérifiés. |

## 7. Publication, domaines & registrar

| Clé | Où | Effet si absente |
| --- | --- | --- |
| VELBAZ\_DEPLOY\_TOKEN | Admin Panel | Le site est quand même publié sur l'hébergement interne (`/s/:subdomain`) ; seul le déploiement chez un fournisseur externe manque. Sert aussi de repli de signature à `AUTH_SECRET`. |
| CLOUDFLARE\_API\_TOKEN, CLOUDFLARE\_ZONE\_ID | Admin Panel | Le domaine client est vérifié (DNS réel) et servi en HTTP par Velbaz ; seul le certificat HTTPS automatique (Cloudflare for SaaS) manque. |
| VELBAZ\_DOMAIN\_TARGET | Admin Panel | Cible CNAME annoncée aux clients ; défaut `cname.velbaz.site`. |
| VELBAZ\_ROOT\_DOMAIN | Admin Panel | Domaine racine de l'hébergement ; défaut `velbaz.site`. |
| NAMECHEAP\_API\_USER, NAMECHEAP\_API\_KEY, NAMECHEAP\_USERNAME, NAMECHEAP\_CLIENT\_IP | Admin Panel | **Les 4 sont requises ensemble.** La recherche de disponibilité (RDAP, publique) marche, mais l'achat de domaine répond 501 en listant les clés manquantes. |

## 8. Export GitHub (`api/github.ts`)

| Clé | Où | Effet si absente |
| --- | --- | --- |
| GITHUB\_TOKEN | Admin Panel | Impossible d'exporter un projet vers GitHub. |
| GITHUB\_OWNER | Admin Panel | Compte/organisation cible de l'export. |

## 9. Higgsfield — vidéo générative

| Clé | Où | Effet si absente |
| --- | --- | --- |
| HF\_API\_KEY + HF\_API\_SECRET | Admin Panel | Génération vidéo Higgsfield indisponible. |
| HF\_CREDENTIALS | Admin Panel | Forme compacte `id:secret`, équivalente à la paire ci-dessus. |
| HIGGSFIELD\_KEY\_ID, HIGGSFIELD\_KEY\_SECRET, HF\_KEY, HF\_SECRET | .env | Alias **legacy** lus en repli ; préférer `HF_API_KEY`/`HF_API_SECRET`. |
| HF\_BASE\_URL | .env | Override de l'URL d'API. |

## 10. Sentry — erreurs & auto-réparation

| Clé | Où | Effet si absente |
| --- | --- | --- |
| SENTRY\_DSN | Admin Panel | Les erreurs ne partent pas chez Sentry. |
| SENTRY\_AUTH\_TOKEN, SENTRY\_ORG, SENTRY\_PROJECT, SENTRY\_API\_URL | Admin Panel | L'auto-réparation ne lit pas l'API Sentry et retombe sur le flux interne (`error_logs`). |

## 11. Publication réseaux sociaux (`api/social/`)

Paires OAuth, toutes en **.env**. La publication de chaque plateforme reste désactivée jusqu'à ce que sa paire soit définie.

| Clé | Effet si absente |
| --- | --- |
| DISCORD\_CLIENT\_ID, DISCORD\_CLIENT\_SECRET, DISCORD\_BOT\_TOKEN | Pas de publication Discord. |
| INSTAGRAM\_CLIENT\_ID, INSTAGRAM\_CLIENT\_SECRET | Pas de publication Instagram. |
| REDDIT\_CLIENT\_ID, REDDIT\_CLIENT\_SECRET | Pas de publication Reddit. |
| TWITTER\_CLIENT\_ID, TWITTER\_CLIENT\_SECRET | Pas de publication X/Twitter. |
| OAUTH\_REDIRECT\_BASE | Base des Redirect URI ; sinon déduite de la requête. |
| X\_LIVE\_ENABLED | Garde-fou : la publication X réelle reste bloquée tant qu'elle n'est pas activée. |

## 12. Signature de jetons & états OAuth

Aucune n'est une clé d'API externe : ce sont des secrets **locaux** de signature. Toutes ont un repli codé, donc rien ne casse sans elles — mais en production il faut les définir explicitement, sinon des jetons publics dérivent d'un secret devinable.

| Clé | Où | Lue par | Effet si absente |
| --- | --- | --- | --- |
| SECRET\_STORE\_KEY | .env | `api/secret-store.ts` | Le coffre à clés chiffre avec `BETTER_AUTH_SECRET`. **À définir en production.** |
| AUTH\_SECRET | Admin Panel / .env | `api/index.ts` — clé IndexNow, jetons de désinscription email | Repli sur `VELBAZ_DEPLOY_TOKEN`. Si les deux manquent, ces jetons sont dérivés d'une valeur vide. |
| OAUTH\_STATE\_SECRET | .env | `api/social/routes.ts` | Chiffrement AES-256-GCM du `state` OAuth social. |
| JWT\_SECRET | .env | `api/social/routes.ts` | Repli de `OAUTH_STATE_SECRET`, puis `TWITTER_CLIENT_SECRET`, puis une constante. |
| SESSION\_SECRET | .env | `api/index.ts` | Repli de `GOOGLE_STATE_SECRET` pour le `state` Google. |
| GOOGLE\_STATE\_SECRET | .env | `api/index.ts` | Voir §5. |

## 13. URLs, chemins & runtime (toutes `.env`, toutes optionnelles)

| Clé | Effet si absente |
| --- | --- |
| PUBLIC\_BASE\_URL, APP\_BASE\_URL, VELBAZ\_URL, VELBAZ\_API\_URL | Génération des URL absolues ; repli sur `WEBSITE_URL`. |
| PUBLIC\_URL | Base publique des callbacks OAuth sociaux. Attention : elle ne gagne **plus** systématiquement — l'ordre est `OAUTH_REDIRECT_BASE` → `Referer` → en-tête `Host` → `PUBLIC_URL`. Une valeur pointant sur un domaine mort cassait les callbacks (corrigé le 2026-09-11). |
| VELBAZ\_APPS\_ROOT | Racine disque des apps générées ; défaut codé. |
| CHIMERA\_ASSETS\_DIR | Dossier des assets Chimera ; défaut codé. |
| MAX\_AUTO\_RELAUNCH\_PER\_BOOT | Plafond de relances automatiques par boot ; défaut codé. |
| DISABLE\_SERVER\_JSX | Bascule de debug du rendu JSX serveur. |
| COMPANY\_ID | Entreprise par défaut pour les scripts CLI/dev, hors requête HTTP. |
| HOME | Fourni par l'OS ; sert à résoudre des chemins par défaut. |

## 14. Bundles clients (jamais de secret ici)

| Clé | Où | Effet si absente |
| --- | --- | --- |
| VITE\_APP\_BASE | injectée par le builder (`builder/runner.ts`) | Base d'URL d'une app générée servie derrière le proxy ; posée automatiquement, à ne pas définir à la main. |
| EXPO\_PUBLIC\_API\_URL | `packages/mobile/.env` | L'app mobile retombe sur `expoConfig.extra.apiUrl`. Sans ni l'un ni l'autre, aucun appel API depuis le mobile. |

## 15. Accès & beta

| Clé | Où | Effet si absente |
| --- | --- | --- |
| ADMIN\_EMAILS | .env | Repli sur l'adresse admin codée par défaut — à définir pour contrôler qui atteint les pages d'admin. |
| BETA\_PUBLIC\_CODE, BETA\_ADMIN\_CODE, BETA\_MAX\_TESTERS | .env | Codes d'accès beta et plafond de testeurs ; défauts (`VELBAZ-BETA`) appliqués. |

## Récapitulatif — ce qui manque aujourd'hui

| Fonctionnalité | État | Clés à fournir |
| --- | --- | --- |
| Base, stockage, IA, auth, facturation | ✅ opérationnel | — |
| Printify (produits + commandes réels) | ✅ token présent dans le `.env` | `PRINTIFY_SHOP_ID` si plusieurs boutiques |
| Paiements Stripe | ❌ | `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) |
| Connexion Google | ❌ | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` |
| Emails transactionnels | ❌ | `RESEND_API_KEY` (+ `RESEND_FROM`) |
| HTTPS sur domaines clients | ❌ | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` |
| Achat de domaine | ❌ | les 4 `NAMECHEAP_*` |
| Export GitHub | ❌ | `GITHUB_TOKEN` + `GITHUB_OWNER` |
| Vidéo Higgsfield | ❌ | `HF_API_KEY` + `HF_API_SECRET` |
| Surveillance Sentry | ❌ | `SENTRY_DSN` (+ token/org/project pour l'auto-réparation) |
| Publication réseaux sociaux | ❌ | la paire OAuth de chaque plateforme voulue |
| Composants premium / scraping | ❌ | `TWENTY_FIRST_API_KEY`, `FIRECRAWL_API_KEY` |
| Durcissement production | ⚠️ replis actifs | `SECRET_STORE_KEY`, `AUTH_SECRET`, `OAUTH_STATE_SECRET`, `GOOGLE_STATE_SECRET`, `ADMIN_EMAILS` |
