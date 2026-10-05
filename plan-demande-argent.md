# Plan — Popup « Demande d'argent de l'IA » dans le chat

L'IA, quand elle a besoin d'argent pour faire avancer l'entreprise (budget pub, outil payant,
facture d'un partenaire, acompte...), affiche une **popup de demande de financement** directement
dans le chat : montant, cadence, raison, et 4 actions — **Payer**, **Refuser**, **En savoir plus**,
**Négocier le montant**.

Comme confirmé : **les deux canaux existent, et c'est l'IA qui choisit** selon la demande.

---

## 1. Les deux canaux

| Canal | `channel` | Ce qui se passe | Exemple |
|---|---|---|---|
| **Budget interne** | `budget` | L'utilisateur paie Velbaz (Stripe Velbaz). Le montant crédite le **budget de dépense de l'entreprise**, que l'IA consomme ensuite (pub, outils, API...). | « +200 €/mois de budget pub Meta » |
| **Paiement externe** | `external` | Velbaz **n'encaisse rien**. La popup affiche le bénéficiaire, le montant et le lien/IBAN/instructions de paiement fournis par l'IA. L'utilisateur paie le tiers, puis confirme « payé » → l'IA continue. | « Payer la facture du partenaire X », « abonnement Canva Pro » |

Règle donnée à l'IA : si l'argent sert à **une dépense que l'IA exécute elle-même** → `budget`.
Si l'argent va à **un tiers identifié** (facture, abonnement, prestataire, partenariat) → `external`.

---

## 2. Base de données (`packages/web/src/api/database/schema.ts`)

**`money_requests`** — une ligne par demande de l'IA
`id`, `companyId`, `sessionId`, `agentRole`, `channel` (`budget|external`),
`amount` (réel), `currency` (`eur` par défaut), `cadence` (`once|weekly|monthly|quarterly`),
`title`, `reason` (l'explication courte de l'IA), `detail` (le « en savoir plus » long),
`expectedReturn` (ce que ça doit rapporter, optionnel),
`payee` + `payUrl` + `payInstructions` (canal externe uniquement),
`status` (`pending|paid|refused|negotiating|expired`), `refusedReason`,
`counterAmount` (contre-proposition de l'utilisateur), `stripeSessionId`, `stripeSubscriptionId`,
`createdAt`, `decidedAt`, `paidAt`. Index par `companyId` et par `sessionId`.

**`company_budget_events`** — le **ledger** du budget interne (source de vérité, jamais
d'incrément en place, même philosophie que `revenue/ledger.ts`)
`id`, `companyId`, `type` (`topup|spend|refund|adjustment`), `amount`, `currency`,
`moneyRequestId`, `label`, `meta`, `createdAt`.
Le solde = somme du ledger, calculé à la lecture (+ cache sur `companies` si besoin d'affichage rapide).

---

## 3. Protocole chat (`packages/web/src/api/index.ts`)

Nouveau bloc ajouté à `BLOCKS_PROTOCOL`, dans le même style que les 20 blocs existants :

```
[MONEY_REQUEST]{"channel":"budget","amount":200,"currency":"eur","cadence":"monthly",
"title":"Budget publicité Meta","reason":"...","detail":"...","expectedReturn":"..."}[/MONEY_REQUEST]
```

Consignes ajoutées au prompt :
- montants **réels et justifiés**, jamais inventés « pour faire joli » ;
- une seule demande à la fois, jamais de demande sans raison chiffrée ;
- `channel: external` **oblige** `payee` et (`payUrl` ou `payInstructions`) ;
- si l'utilisateur refuse, l'IA propose une alternative moins chère au lieu de re-demander la même chose ;
- si l'utilisateur contre-propose, l'IA dit clairement ce qu'elle peut faire avec ce montant.

Côté serveur, avant de renvoyer le message : le bloc est **persisté** en `money_requests`
(status `pending`) et l'`id` réel est injecté dans le JSON envoyé au front. Le front ne fait
jamais confiance au montant du JSON pour payer — le paiement relit le montant en base.

---

## 4. API (`packages/web/src/api/money-requests.ts`, monté comme les autres sous-routers)

- `GET  /money-requests/:id` — état courant (pour le rendu et le polling après retour de Stripe)
- `POST /money-requests/:id/pay` — canal `budget` : crée une session Stripe Checkout
  (`mode: 'payment'` si `once`, `mode: 'subscription'` avec `recurring.interval` si `monthly`/etc.),
  `metadata: { app:'velbaz', kind:'money_request', moneyRequestId, companyId, userId }`,
  renvoie l'URL. Même schéma que `POST /billing/checkout/credits`.
- `POST /money-requests/:id/mark-external-paid` — canal `external` : passe en `paid`, aucune
  transaction Velbaz, trace dans le ledger uniquement si l'IA doit en tenir compte (`type: spend` externe).
- `POST /money-requests/:id/refuse` — status `refused` + raison ; injecte un message système dans
  le chat pour que l'IA en tienne compte.
- `POST /money-requests/:id/negotiate` — enregistre `counterAmount`, status `negotiating`, et
  renvoie la main à l'IA dans le chat.
- Webhook : extension de `POST /billing/webhook` existant — sur `checkout.session.completed` /
  `invoice.paid` avec `metadata.kind === 'money_request'` → status `paid` + écriture `topup` dans
  `company_budget_events`. Réutilise la vérification de signature et l'idempotence
  (`billingEvents`) déjà en place, plus le fallback `/billing/confirm` au retour sur le site.

**Garde-fous** (non négociables, alignés sur `billing.ts`) : vérification de propriété
utilisateur↔entreprise↔demande, montant relu en base, plafond serveur par demande et par jour,
statut jamais modifiable par l'IA, signature webhook + idempotence, 503 propre si Stripe non configuré.

---

## 5. Frontend

- **`packages/web/src/web/components/MoneyRequestPopup.tsx`** — la carte/popup, dans le langage
  visuel d'`AIApprovalPopup.tsx` mais plus riche : bandeau de canal, **montant en très gros**
  avec animation slot-machine (comme tous les compteurs du site), badge de cadence
  (« une fois » / « par mois »), la raison, le retour attendu, et les 4 actions :
  **Payer** (bouton principal) · **Refuser** · **En savoir plus** (déplie `detail`) ·
  **Négocier** (champ montant inline + slider, envoie la contre-proposition).
  États visuels distincts pour `paid` / `refused` / `negotiating` — la carte reste dans
  l'historique du chat avec son verdict.
- Câblage dans `packages/web/src/web/pages/chat.tsx` : tag `MONEY_REQUEST` ajouté à `BLOCK_TAGS`
  (~l.8296) + `case 'moneyrequest'` dans le `switch` de rendu (~l.8341).
- Helpers dans `packages/web/src/web/lib/api.ts` (même style que `checkout/credits`).
- **Panneau budget** : petit indicateur du solde de budget de l'entreprise (somme du ledger) +
  historique des demandes, pour que l'utilisateur voie où part l'argent.
- Tout en français.

---

## 6. Ordre d'exécution

1. Schéma + `db:push`
2. Sous-router `money-requests.ts` + extension du webhook
3. Bloc `[MONEY_REQUEST]` dans le prompt + persistance serveur
4. `MoneyRequestPopup.tsx` + câblage chat
5. Indicateur de budget + historique
6. `bunx tsc --noEmit` + test réel du parcours en mode test Stripe

---

## À valider avant de coder

1. **Plafond** par demande (ex. 500 € max par demande, 2 000 €/mois) — quel montant ?
2. **Devise** : EUR uniquement, ou aussi USD ?
3. Le canal `budget` en mensuel = **vrai abonnement Stripe** (prélèvement auto chaque mois) ou
   l'IA re-demande chaque mois ?
4. Faut-il un **mode « autorisation automatique »** (« sous 50 €, paie sans me demander ») ?
