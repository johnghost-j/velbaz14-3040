# Tâche — logo PNG transparent + cohérence chromatique logo ↔ site

## Demande
1. Le logo posé dans le site doit être un **PNG à fond transparent** (pas de blanc, pas de noir).
2. Le **site doit suivre les couleurs du logo** et inversement : jamais un logo rouge sur un site bleu.

## Cause racine (confirmée par lecture du code)
- `LOGO_HARD_RULES` (index.ts ~1260) impose « Plain pure white background » ; aucun
  post-traitement ne transforme ce blanc en alpha. Le modèle image (gateway
  `IMAGE_MODEL`, Nano Banana) renvoie un raster opaque → le logo arrive avec un
  carré blanc, visible dans le header/footer/favicon.
- Les couleurs du site et celles du logo sont décidées par **deux appels IA
  indépendants** :
  - logo : `designLogoBrief()` (index.ts ~1321) invente sa propre palette ;
  - site : `engine.ts` (~1490-1560) → design system IA + `twentyFirst.fetchDesignTokens`
    + `deAiPalette()` qui peut encore tout remplacer.
  - Ni `builder/routes.ts` (~572) ni `index.ts` (~4337, genèse) ne passent la
    palette de marque au moteur → aucune des deux ne connaît l'autre.
- La palette validée par l'utilisateur (`/brand-preview/approve`) est stockée en
  `designAssets type='brand_guidelines'` (`lockedByUser: true`) mais **jamais lue
  par le build**.

## Plan
1. `builder/logo-image.ts` — détourage déterministe (sharp) : flood-fill du fond
   quasi-blanc depuis les bords + retrait du blanc intérieur, adoucissement des
   bords, recadrage sur la marque, ré-encodage **PNG avec alpha**. Garde-fous :
   si tout ou rien n'est détouré → on garde l'original (ré-encodé PNG).
   Plus `extractLogoColors()` : couleurs dominantes réelles du logo.
2. `builder/brand-palette.ts` — source unique de vérité :
   `loadBrandPalette(companyId)` = palette verrouillée par l'utilisateur, sinon
   couleurs EXTRAITES du logo. `alignDesignToBrand()` applique primary/accent au
   design du site (avec garde de contraste).
3. Câblage :
   - `LOGO_HARD_RULES` : fond blanc **uniforme** demandé (pour un détourage
     fiable) + interdiction d'utiliser le blanc comme remplissage de la marque.
   - `generateLogoPng()` → détourage sur les 3 chemins de génération de logo
     (init, changement en cours de projet, aperçu de marque).
   - `EngineInput.brandColors` + application APRÈS `deAiPalette` (sinon écrasé).
   - `routes.ts` + genèse `index.ts` : chargent la palette de marque et la passent.
   - Changement de logo en cours de projet : re-synchronise le thème du site
     (styles.css + tailwind.config.js) sur les couleurs du nouveau logo.
4. Tests + `tsc --noEmit` + suite complète (base à battre : 818 pass / 0 fail).

## État
- [x] Investigation
- [x] `logo-image.ts` — détourage + démattage anti-halo + extraction couleurs (21 tests verts)
- [x] `brand-palette.ts` — palette unique de marque (22 tests verts)
- [x] `retheme.ts` — reteintage chirurgical d'un site existant (23 tests verts)
- [x] Câblage `index.ts` (LOGO_HARD_RULES, `generateLogoPng` sur les 3 chemins,
      `/brand-preview/approve`, genèse → `brandColors`)
- [x] Câblage `engine.ts` (`EngineInput.brandColors`, consigne dans le prompt +
      clé de cache, alignement déterministe APRÈS `deAiPalette`/`deAiDesignProfile`)
- [x] Câblage `builder/routes.ts` (`loadBrandPalette` → `brandColors`)
- [x] Re-sync du thème au changement de logo en cours de projet
- [x] `tsc --noEmit` propre
- [x] Vérification fonctionnelle sur un VRAI logo généré : PNG alpha réel
      (hasAlpha, coins à alpha 0, recadré 1408x768 → 522x522), couleurs extraites
      `#BC1D36` → site bleu aligné en rouge, écart de teinte logo↔site = 0°
- [x] Suite complète

## Part F (2026-10-01) — progress
- [x] 1 GitHub forbidden msg (api tsc diff OK)
- [x] 2 lazyRetry chunk reload
- [x] 3 Phone tab removed
- [ ] 4 Ads connect: new module src/api/ad-accounts/ (runtime table ad_connections, OAuth google_ads/meta_ads, list accounts, push draft as PAUSED campaign), UI in Ads tab
- [ ] 5 Domains: HOSTING_KEYS -> only VELBAZ_DEPLOY_TOKEN; template "Domaines"; Cloudflare edge setup (worker fallback origin, x-velbaz-site-host header + secret); live HTTP probe before 'live'; Namecheap setHosts after buy
- [ ] keys: velbaz-api-keys.txt, API-KEYS.md/.pdf, key-check, secret-store, secret-vault, AdminPanel labels
- [ ] verify: api tsc diff, typecheck, tests, build, restart, playwright, cleanup aptest-f1 + tmp-sess-aptest-e2
