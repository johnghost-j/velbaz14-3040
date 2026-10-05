/**
 * [2026-10-04] Règles OUI / NON de STRUCTURE de site (pages, ordre, nav),
 * injectées dans PLAN_PROMPT et PLAN_PROMPT_LIGHT.
 *
 * Source : relevé réel (navigateur, 2026-10-04) de la nav, des titres de la
 * page d'accueil et du footer de sites de boutiques/marques (Allbirds, Veja,
 * Gymshark, Glossier, Mejuri, Brooklinen, Patagonia, HAY, IKEA, Lepape,
 * Asphalte, Maison Dandoy, Oura…), de restaurants (Septime, Noma, Dishoom), de
 * logiciels (Linear, Notion, Stripe), de véhicules (Polestar, Cowboy) et de
 * services/marques (voir MIGRATION.md pour la liste exacte et ce qui n'a pas
 * pu être lu). Constats qui fondent les règles :
 *  - aucun de ces sites n'a de page « Showroom » dans sa nav ni comme
 *    accueil ; le mot n'apparaît que pour des LIEUX physiques (HAY : « offices
 *    & showrooms », dans le footer) ;
 *  - l'accueil = hero + best-sellers/produits phares + catégories + histoire
 *    de marque + arguments (livraison, retours) ; jamais une grille nue ;
 *  - la nav = l'offre (catégories, Boutique, Menu, Modèles), À propos/Journal
 *    ensuite ; FAQ, livraison, retours, contact, points de vente = FOOTER ;
 *  - panier et compte = icônes à droite, pas des entrées de nav ;
 *  - restaurants : Menu, Réservation, Horaires, Contact visibles d'emblée ;
 *  - logiciels : Produit, Tarifs, Clients, Contact ; Connexion/Inscription à
 *    droite ; « / » d'une APP générée = l'espace de travail.
 * Gardé COURT : il part dans chaque planification.
 */
export const PAGE_STRUCTURE_RULES = `## 🗺️ STRUCTURE DES PAGES — CE QUE FONT LES VRAIS SITES (OUI / NON)
Relevé sur de vrais sites (boutiques : Allbirds, Veja, Glossier, Mejuri, Brooklinen, IKEA ; restaurants : Septime, Noma, Dishoom ; logiciels : Linear, Notion). Suis ces règles.

✅ OUI
- Route "/" = la page « Accueil » (name "Accueil" / "Home", file "Home.tsx"), sauf pour un LOGICIEL (A) où "/" est l'espace de travail. Un vrai accueil = hero clair (qui / quoi / 1 CTA) → produits ou prestations phares (lus via data.list) → catégories → arguments VRAIS (livraison, retours, paiement) → courte histoire de la marque → CTA final.
- Ordre logique : Accueil → page de l'offre (Boutique / Menu / Prestations / Modèles) → fiche détail (:id) et tunnel (panier, commande) → Tarifs → À propos → Journal → Contact / FAQ en dernier.
- Nav du haut : 3 à 5 mots simples qui disent ce qu'on trouve (« Boutique », « Nouveautés », « Collections », « À propos », « Contact »). Panier et compte = icônes à droite. FAQ, livraison, retours, points de vente = footer.
- Boutique / marque : Accueil, Boutique (grille + filtres + tri), Fiche produit (:id : galerie, prix, taille/couleur, « Ajouter au panier », livraison/retours), Panier, À propos (« Notre histoire »), Contact. Ex. « crée-moi une marque de chaussures » ⇒ Accueil, Boutique, Fiche produit, Panier, Notre histoire, Contact.
- Restaurant / café : Accueil (photo, horaires + adresse visibles, CTA « Réserver »), Menu (HTML avec prix, jamais un PDF), Réservation, À propos, Contact & accès.
- Service (salon, artisan, cabinet, coach) : Accueil, Prestations (prix de départ, durée), Prise de rendez-vous, Tarifs, À propos, Contact (zone, horaires).
- Véhicule / bien non achetable en un clic : Accueil, Modèles, Fiche modèle (:id), Essai ou demande d'info, Points de vente.
- Logiciel (A) : "/" = l'app elle-même ; liste, détail (:id), création ; Tarifs/Facturation en fin de liste.

❌ NON
- JAMAIS de page « Showroom » (ni route "/showroom", ni fichier Showroom.tsx, ni le mot dans les sections) sauf si l'utilisateur a écrit lui-même « showroom ». Le catalogue s'appelle « Boutique » (ou « Modèles » pour des véhicules, « Collections » pour de la mode si plusieurs collections).
- JAMAIS en "/" : une grille de catalogue, un dashboard de gestion, Contact, Panier, Tarifs, À propos, FAQ ou une page légale.
- Pas de doublons (Boutique + Catalogue + Produits = une seule page) ; pas de page qui répète le hero de l'accueil.
- Pas de pages de remplissage non demandées (Carrières, Presse, Investisseurs, Partenaires, Blog vide).
- Pas de libellé de nav en jargon (« L'Univers », « Expérience », « Le Lab ») quand un mot simple existe.
- Pas de Panier, Commande, Paiement ni fiche détail dans la nav du haut (showInNav=false).`;
