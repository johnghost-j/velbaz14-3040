# Velbaz / Synaps — Design

Plateforme web (Bun + Vite + React + Hono + Drizzle) où une IA fait tourner l'entreprise de
l'utilisateur : chat par projet, dashboard projet (app, domaines, revenus, **budget**, activité,
tâches, growth, ads, emails, docs, rapports, autopilot).

Direction visuelle : **sombre par défaut, quasi-noir, sans couleur décorative.** Une seule
teinte d'accent (bleu-cyan `#4EAADC`) et des surfaces qui se distinguent de 2 à 4 % de
luminosité, pas plus. Rien ne clignote, rien ne crie : ce qui attire l'œil est le chiffre,
jamais le décor. Toute l'interface du produit est en **français**.

## Brand & Colors

Source de vérité unique : les variables CSS de `packages/web/src/web/styles.css`
(`:root` = sombre, `:root[data-theme="light"]` = clair). On ne code **jamais** une couleur en
dur dans un composant — sauf les 5 couleurs de catégorie (`--chart-1..5`) reprises telles quelles
pour les KPI.

| Token | Sombre | Clair | Usage |
|-------|--------|-------|-------|
| `--surface-0` | `#1A1A1A` | `#FFFFFF` | Fond de page |
| `--surface-1` | `#1E1E1E` | — | Bloc intérieur (montant, panneau déplié) |
| `--surface-2` | `#222222` | `#FFFFFF` | Cartes, lignes de liste |
| `--surface-3` | `#252525` | `#F5F5F5` | Boutons secondaires, puces, onglet actif |
| `--surface-4` | `#2A2A2A` | `#EBEBEB` | Piste de barre de progression |
| `--border-subtle` | `#2A2A2A` | `#DDDDDD` | Filets internes |
| `--border-default` | `#333333` | `#CCCCCC` | Bordure de carte |
| `--text-primary` | `#E8E8E8` | `#1A1A1A` | Montants, titres |
| `--text-secondary` | `#dddddd` | `#333333` | Corps |
| `--text-muted` / `--text-dim` / `--text-ghost` | `#999` / `#666` / `#555` | — | Hiérarchie descendante des libellés |
| `--teal` | `#4EAADC` | `#4EAADC` | Accent unique : solde, état « en attente », focus |
| `--green-text` | `#4ade80` | — | Payé / confirmé |
| `--red-text` | `#ff6b6b` | `#DC2626` | Refus, erreur, **état non confirmé** |
| `--btn-primary-bg` | `#E8E8E8` | `#1A1A1A` | Action principale (contraste inversé) |

Les couples « subtle » (`--teal-subtle-bg` / `-border`, `--green-subtle-*`, `--red-subtle-*`)
servent aux pastilles d'état : fond teinté à ~8 %, bordure à ~20 %, texte pleine teinte.

## Typography

Police système (pile `-apple-system / Segoe UI / Inter`), pas de fonte chargée. Échelle serrée,
en demi-pixels quand il faut : **10–11 px** libellés capitales avec `letter-spacing: 0.06em`,
**12,5–13,5 px** corps, **15 px** titre de carte (`font-weight: 650`), **18 px** KPI,
**26–30 px** montant (`font-weight: 700`, `letter-spacing: -0.02em`, `font-variant-numeric:
tabular-nums` pour que les chiffres ne bougent pas pendant l'animation).

## Animation

- **Tous** les compteurs chiffrés passent par `AnimatedCounter` (`components/AnimatedCounter.tsx`) :
  roulement type machine à sous, **1 500 ms** quelle que soit la taille, et **aucune** animation
  au premier montage (seul un changement de valeur roule).
- Ouverture de panneau : `mreq-open`, 220 ms, translation de 4 px + fondu.
- `@media (prefers-reduced-motion: reduce)` coupe les animations de carte.

## Pages & Screens

- **Chat projet** (`src/web/pages/chat.tsx`) — le fil. Les blocs émis par l'IA
  (`[TABLE_VIEW]`, `[MONEY_REQUEST]`…) sont rendus comme composants ; la balise brute n'est
  jamais visible.
- **Dashboard projet** (`src/web/pages/company.tsx`) — barre d'onglets, puis une phrase
  d'explication simple sous les onglets (`TAB_DESCRIPTIONS`).
- **Popup de demande d'argent** (`src/web/components/MoneyRequestPopup.tsx`, styles `.mreq*`
  dans `styles.css`) — capture : `shots/mreq-1-chat.png`.
- **Panneau Budget** (`src/web/components/BudgetPanel.tsx`, onglet `?tab=budget`) — capture :
  `shots/budget-1-onglet.png`.

## La demande d'argent — le motif visuel de référence

Capture de référence : `shots/mreq-1-chat.png`, `-2-detail`, `-3-negocier`, `-4-externe`,
`-5-mobile`, `-6-non-confirme`.

Carte `.mreq`, rayon 18 px, **aucun liseré vertical à gauche** : l'état se lit uniquement à la
puce d'état (`.mreq-pill`) et à l'icône d'en-tête, jamais par une barre de couleur sur le bord
de la carte. De haut en bas :

1. **En-tête** — icône 34 px en carré arrondi sur fond `--teal-subtle`, sur-titre en capitales
   (`DEMANDE DE BUDGET` ou `PAIEMENT À RÉGLER`), titre, puce d'état à droite.
2. **Bloc montant + destination** (`--surface-1`, rayon 13 px) — le montant à 30 px à gauche,
   la destination alignée à droite avec une ligne d'explication en `--text-dim`
   (« utilisable seulement pour ce poste », « paiement direct, Velbaz n'encaisse rien »).
   C'est le seul bloc encadré de la carte : ce qui est **figé** est visuellement enfermé.
3. **Bandeau rouge « état non confirmé »** (`.mreq-stale`) — n'apparaît que si le `GET` de
   relecture a échoué. Fond `--red-subtle-bg`, bordure `--red-subtle-border` sur les 4 côtés
   (pas de liseré gauche accentué).
4. **Le pourquoi** puis **attendu en retour**.
5. **Actions** — hauteur 36 px, rayon 10 px : `Payer` en primaire clair, puis `Négocier`,
   `En savoir plus`, et `Refuser` en fantôme (qui ne devient rouge qu'au survol).
6. **Note de pied** en 11 px : ce qui est verrouillé, et qui encaisse.

Panneaux dépliables (détail, négociation) : même rayon, fond `--surface-1`, liste de faits en
deux colonnes (libellé `--text-dim` à gauche, valeur `--text-secondary` en gras à droite).

## Règle de design non négociable

Aucun montant affiché n'est calculé par le navigateur. La popup et le panneau Budget lisent le
serveur ; en cas d'échec, ils **montrent l'échec** (bandeau rouge, ou message + « Réessayer »)
plutôt qu'un chiffre. Un solde absent vaut mieux qu'un solde faux.

## Architecture

- **API** : routes Hono dans `src/api/` (`money-requests.ts` porte le grand livre et les routes
  `/money-requests/*` + `/companies/:id/budget`). Le front appelle `/api/...` avec le jeton de
  `lib/token.ts` (`localStorage['velbaz_token']`).
- **Base** : Drizzle + SQLite/libsql — `money_requests`, `company_budget_events`
  (grand livre append-only, index unique sur `dedupeKey` = crédit une seule fois).
- **Vérification visuelle** : `packages/web/scripts/visual-money.ts` sème un décor jetable,
  `visual-money.py` et `visual-budget.py` prennent les captures dans `shots/` via Chrome.
