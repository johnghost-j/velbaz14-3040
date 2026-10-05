import { client } from "./client";

// ─── Runtime idempotent table creation ───────────────────────────────────────
// Nouvelles tables ajoutées sans passer par `db:push` : on les crée au démarrage
// avec CREATE TABLE IF NOT EXISTS pour que la feature marche immédiatement.
let _ensured: Promise<void> | null = null;
export function ensureRuntimeTables(): Promise<void> {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    try {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS dynamic_specialists (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          label TEXT NOT NULL,
          label_en TEXT,
          descr TEXT,
          emoji TEXT,
          color TEXT,
          domain TEXT,
          brief TEXT,
          system_prompt TEXT NOT NULL,
          keywords TEXT,
          use_count INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch())
        )`);
      await client.execute(`CREATE INDEX IF NOT EXISTS dyn_spec_company_idx ON dynamic_specialists (company_id)`);
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS dyn_spec_company_slug_idx ON dynamic_specialists (company_id, slug)`);
      // Jetons de réinitialisation de mot de passe (mot de passe oublié)
      await client.execute(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch())
        )`);
      await client.execute(`CREATE INDEX IF NOT EXISTS prt_user_idx ON password_reset_tokens (user_id)`);
      // Collaborateurs de projet (invitation d'un ami à co-éditer un projet)
      await client.execute(`
        CREATE TABLE IF NOT EXISTS project_collaborators (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          email TEXT NOT NULL,
          user_id TEXT,
          role TEXT NOT NULL DEFAULT 'editor',
          status TEXT NOT NULL DEFAULT 'pending',
          invite_token TEXT NOT NULL,
          invited_by_user_id TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          accepted_at INTEGER
        )`);
      await client.execute(`CREATE INDEX IF NOT EXISTS pc_company_idx ON project_collaborators (company_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS pc_user_idx ON project_collaborators (user_id)`);
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS pc_token_idx ON project_collaborators (invite_token)`);
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS pc_company_email_idx ON project_collaborators (company_id, email)`);
      // "Made with Velbaz" badge — colonne ajoutée sans db:push. Défaut 0 (badge visible).
      // Ne peut être mis à 1 que si le propriétaire a un plan payant ; sinon le
      // badge réapparaît (contrôle live au moment de servir la page).
      await client.execute(`ALTER TABLE companies ADD COLUMN badge_hidden INTEGER DEFAULT 0`)
        .catch(() => {}); // colonne déjà présente → ignore
      // [2026-09-21] Pastille "build prêt" (rond vert dans la sidebar) : mémorise
      // la dernière visite du projet pour éteindre le rond une fois vu (avant :
      // restait vert pour toujours, même après être entré dans le projet).
      await client.execute(`ALTER TABLE companies ADD COLUMN ready_seen_at INTEGER`).catch(() => {});
      // ── Publication du site ("Publish your website") — colonnes ajoutées sans db:push ──
      await client.execute(`ALTER TABLE companies ADD COLUMN subdomain TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN published INTEGER DEFAULT 0`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN published_at INTEGER`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN availability_mode TEXT DEFAULT 'wake'`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN visibility TEXT DEFAULT 'public'`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN custom_domain TEXT`).catch(() => {});
      // Facturation de l'hébergement (Availability) : dernier débit + mode facturé.
      await client.execute(`ALTER TABLE companies ADD COLUMN hosting_billed_at INTEGER`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN hosting_billed_mode TEXT`).catch(() => {});
      // [2026-10-03] Mode de modèles d'une étape de build (cf. schema.ts agentActivity.modelMode).
      await client.execute(`ALTER TABLE agent_activity ADD COLUMN model_mode TEXT`).catch(() => {});
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS companies_subdomain_idx ON companies (subdomain)`).catch(() => {});
      // ── Raccordement d'un domaine personnalisé (api/domains.ts) ──
      // Statut réel du domaine : issu d'une lecture DNS publique (DoH) + état du
      // certificat chez Cloudflare for SaaS quand les clés sont configurées.
      await client.execute(`ALTER TABLE companies ADD COLUMN custom_domain_status TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN custom_domain_verified_at INTEGER`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN custom_domain_checked_at INTEGER`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN custom_domain_ssl TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN custom_domain_provider_id TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE companies ADD COLUMN custom_domain_error TEXT`).catch(() => {});
      // Un domaine ne peut servir qu'un seul site (les NULL ne comptent pas en
      // SQLite, donc les projets sans domaine ne se gênent pas).
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS companies_custom_domain_idx ON companies (custom_domain)`).catch(() => {});
      // ── Stripe Connect : colonnes vendeur sur users (ajout sans db:push) ──
      await client.execute(`ALTER TABLE users ADD COLUMN stripe_account_id TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE users ADD COLUMN stripe_onboarding_completed INTEGER DEFAULT 0`).catch(() => {});
      await client.execute(`ALTER TABLE users ADD COLUMN stripe_payouts_enabled INTEGER DEFAULT 0`).catch(() => {});
      // ── Fin d'abonnement (null = sans date de fin) ──
      await client.execute(`ALTER TABLE users ADD COLUMN plan_expires_at INTEGER`).catch(() => {});
      // ── Mode « approbation manuelle » de l'IA (api/approval-routes.ts) ──
      await client.execute(`ALTER TABLE users ADD COLUMN ai_approval_mode INTEGER DEFAULT 0`).catch(() => {});
      // ── Table des paiements Stripe Connect (marketplace) ──
      await client.execute(`
        CREATE TABLE IF NOT EXISTS stripe_connect_orders (
          id TEXT PRIMARY KEY,
          buyer_user_id TEXT,
          seller_user_id TEXT,
          seller_account_id TEXT NOT NULL,
          product_id TEXT,
          amount INTEGER NOT NULL,
          currency TEXT NOT NULL DEFAULT 'eur',
          application_fee_amount INTEGER NOT NULL DEFAULT 0,
          stripe_session_id TEXT,
          stripe_payment_intent_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          metadata TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        )`);
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS sco_session_idx ON stripe_connect_orders (stripe_session_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS sco_seller_idx ON stripe_connect_orders (seller_user_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS sco_buyer_idx ON stripe_connect_orders (buyer_user_id)`);
      // ── Paiements plateforme Velbaz (commission + solde en attente) ──
      await client.execute(`
        CREATE TABLE IF NOT EXISTS platform_payments (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          owner_user_id TEXT,
          source_ref TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'checkout',
          stripe_session_id TEXT,
          stripe_payment_intent_id TEXT,
          stripe_charge_id TEXT,
          stripe_subscription_id TEXT,
          route TEXT NOT NULL DEFAULT 'hold',
          gross_cents INTEGER NOT NULL DEFAULT 0,
          fee_cents INTEGER NOT NULL DEFAULT 0,
          net_cents INTEGER NOT NULL DEFAULT 0,
          fee_percent REAL,
          currency TEXT NOT NULL DEFAULT 'eur',
          status TEXT NOT NULL DEFAULT 'pending',
          destination_account TEXT,
          transfer_id TEXT,
          last_error TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          released_at INTEGER
        )`);
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS pp_source_idx ON platform_payments (source_ref)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS pp_company_idx ON platform_payments (company_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS pp_owner_status_idx ON platform_payments (owner_user_id, status)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS pp_charge_idx ON platform_payments (stripe_charge_id)`);
      await client.execute(`ALTER TABLE platform_payments ADD COLUMN cost_cents INTEGER DEFAULT 0`).catch(() => {});
      await client.execute(`ALTER TABLE platform_payments ADD COLUMN reserved_cents INTEGER DEFAULT 0`).catch(() => {});
      // ── ENTRAÎNEMENT COMMUNICATION / PUB / MARKETING ────────────────────
      // `comms_training_examples` : chaque test lancé depuis la console admin
      // (message étudié → réponse produite), plus la note 1-10 et la correction
      // écrite par l'admin. C'est la mémoire brute de l'entraînement.
      await client.execute(`
        CREATE TABLE IF NOT EXISTS comms_training_examples (
          id TEXT PRIMARY KEY,
          company_id TEXT,
          task TEXT NOT NULL,
          input TEXT NOT NULL,
          context TEXT,
          lang TEXT,
          study TEXT,
          output TEXT,
          variants TEXT,
          self_score REAL,
          score REAL,
          correction TEXT,
          model TEXT,
          duration_ms INTEGER,
          created_by TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          rated_at INTEGER
        )`);
      await client.execute(`CREATE INDEX IF NOT EXISTS cte_task_idx ON comms_training_examples (task)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS cte_company_idx ON comms_training_examples (company_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS cte_score_idx ON comms_training_examples (score)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS cte_created_idx ON comms_training_examples (created_at)`);
      // `comms_playbook` : les LEÇONS distillées à partir des notes/corrections.
      // C'est ce que l'IA relit avant chaque réponse en production — le vrai
      // support de « l'entraînement » (pas de fine-tuning, mais un savoir qui
      // s'accumule et pèse sur chaque génération).
      await client.execute(`
        CREATE TABLE IF NOT EXISTS comms_playbook (
          id TEXT PRIMARY KEY,
          company_id TEXT,
          task TEXT NOT NULL,
          rule TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'do',
          weight REAL NOT NULL DEFAULT 1,
          hits INTEGER NOT NULL DEFAULT 0,
          source_example_id TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        )`);
      await client.execute(`CREATE INDEX IF NOT EXISTS cpb_task_idx ON comms_playbook (task)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS cpb_company_idx ON comms_playbook (company_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS cpb_active_idx ON comms_playbook (active)`);
      // `site_visits` : la mesure du monde réel. Sans elle, les agents pilotent
      // à l'aveugle — aucune donnée de trafic, de canal d'acquisition ni de
      // taux de conversion n'existait avant. Une ligne = un événement
      // (pageview, lead, checkout_start, purchase) sur un site généré.
      await client.execute(`
        CREATE TABLE IF NOT EXISTS site_visits (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          event TEXT NOT NULL DEFAULT 'pageview',
          path TEXT NOT NULL DEFAULT '/',
          channel TEXT NOT NULL DEFAULT 'direct',
          referrer_host TEXT,
          utm_source TEXT,
          utm_medium TEXT,
          utm_campaign TEXT,
          device TEXT,
          country TEXT,
          value REAL,
          meta TEXT,
          stripe_session_id TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )`);
      // Ajout rétro-compatible : les bases créées avant l'attribution du CA
      // n'ont pas la colonne. Échec silencieux = colonne déjà là.
      await client.execute(`ALTER TABLE site_visits ADD COLUMN stripe_session_id TEXT`).catch(() => {});
      await client.execute(`CREATE INDEX IF NOT EXISTS sv_stripe_idx ON site_visits (stripe_session_id)`).catch(() => {});
      await client.execute(`CREATE INDEX IF NOT EXISTS sv_company_idx ON site_visits (company_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS sv_company_created_idx ON site_visits (company_id, created_at)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS sv_session_idx ON site_visits (session_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS sv_event_idx ON site_visits (event)`);

      // ── Facturation Velbaz (Stripe Checkout : abonnements + crédits) ──
      // Colonnes ajoutées sans db:push ; échec silencieux = déjà présentes.
      await client.execute(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE users ADD COLUMN billing_cycle TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE users ADD COLUMN billing_status TEXT`).catch(() => {});
      await client.execute(`CREATE INDEX IF NOT EXISTS users_stripe_sub_idx ON users (stripe_subscription_id)`).catch(() => {});
      // Journal des paiements + verrou d'idempotence (une session = une ligne).
      await client.execute(`
        CREATE TABLE IF NOT EXISTS billing_checkouts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          plan TEXT,
          billing TEXT,
          package_id TEXT,
          credits INTEGER DEFAULT 0,
          amount_cents INTEGER NOT NULL,
          currency TEXT NOT NULL DEFAULT 'eur',
          stripe_session_id TEXT,
          stripe_subscription_id TEXT,
          stripe_payment_intent_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          applied_at INTEGER,
          error TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        )`);
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS bco_session_idx ON billing_checkouts (stripe_session_id)`).catch(() => {});
      await client.execute(`CREATE INDEX IF NOT EXISTS bco_user_idx ON billing_checkouts (user_id)`).catch(() => {});
      // ── Photo de profil du compte (cf. api/avatar.ts) — ajout sans db:push ──
      // Le rond de profil affiche la vraie photo du compte : envoyée par
      // l'utilisateur, issue de Google, ou détectée via Gravatar.
      await client.execute(`ALTER TABLE users ADD COLUMN avatar_url TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE users ADD COLUMN avatar_source TEXT`).catch(() => {});
      await client.execute(`ALTER TABLE users ADD COLUMN google_id TEXT`).catch(() => {});
      // Un compte Google ne peut être lié qu'à un seul utilisateur (les NULL
      // ne comptent pas en SQLite : les comptes e-mail/mot de passe cohabitent).
      await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users (google_id)`).catch(() => {});
      // Événements webhook déjà traités (Stripe rejoue : l'id est la clé).
      await client.execute(`
        CREATE TABLE IF NOT EXISTS billing_events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          payload_id TEXT,
          handled_at INTEGER DEFAULT (unixepoch())
        )`);
    } catch (e: any) {
      console.error("[db] ensureRuntimeTables failed:", e?.message);
    }
  })();
  return _ensured;
}
// Lance la création au chargement du module (non bloquant).
ensureRuntimeTables();
