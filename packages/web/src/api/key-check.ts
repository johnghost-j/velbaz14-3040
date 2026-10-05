// ─── Vérification des clés API importées ─────────────────────────────────────
//
// Objectif : l'admin a rempli son fichier, il ne sait pas si les valeurs sont
// les bonnes. Ce module interroge RÉELLEMENT chaque fournisseur avec la clé
// stockée et répond valide / invalide / non testable.
//
// Règles de sécurité :
//   • aucune valeur n'est renvoyée ni journalisée — seulement les 4 derniers
//     caractères et un statut ;
//   • les requêtes sont en lecture seule (endpoints "whoami" / "list"), jamais
//     d'écriture chez le fournisseur ;
//   • chaque appel a un timeout court et les erreurs réseau sont isolées ;
//   • les messages renvoyés passent par redactForLog().
//
import { getSecret } from './secret-store';
import { redactForLog } from './secret-vault';

export type CheckStatus = 'ok' | 'bad' | 'missing' | 'untestable' | 'error';

export interface KeyCheck {
  name: string;
  label: string;      // service lisible ("Stripe", "Resend"…)
  status: CheckStatus;
  detail: string;     // message court en français, jamais de valeur
  live: boolean;      // true = testé auprès du fournisseur, false = format seul
  last4: string | null;
  required: boolean;  // false = optionnelle, l'app tourne sans
}

function readValue(name: string): string {
  const v = getSecret(name) || process.env[name] || '';
  return v.trim();
}

function last4(s: string): string {
  return s.length <= 4 ? '••••' : s.slice(-4);
}

async function ping(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 9000);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
    const body = (await r.text().catch(() => '')).slice(0, 400);
    return { status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** Traduit un code HTTP en statut + message français. */
function judge(status: number, body: string): { status: CheckStatus; detail: string } {
  if (status >= 200 && status < 300) return { status: 'ok', detail: 'Clé valide, le service répond.' };
  if (status === 401) return { status: 'bad', detail: 'Refusée (401) : clé invalide, expirée ou révoquée.' };
  if (status === 403) return { status: 'bad', detail: "Refusée (403) : clé reconnue mais sans les droits nécessaires." };
  if (status === 404) return { status: 'bad', detail: 'Ressource introuvable (404) : compte ou identifiant incorrect.' };
  if (status === 429) return { status: 'ok', detail: 'Clé acceptée (quota momentanément atteint, 429).' };
  // Certains fournisseurs (Resend…) répondent 400 avec « API key is invalid ».
  if (/invalid|unauthor|not\s*found|forbidden|expired|revoked|bad\s*credential/i.test(body)) {
    return { status: 'bad', detail: `Refusée par le service (${status}) : clé invalide ou incorrecte.` };
  }
  return { status: 'error', detail: `Réponse inattendue (${status}) ${redactForLog(body).slice(0, 120)}`.trim() };
}

// ── Définitions : un test par clé ────────────────────────────────────────────
// `read` donne accès aux autres clés du même lot (ex. une paire ID + secret).
type Tester = (v: string, read: (name: string) => string) => Promise<{ status: CheckStatus; detail: string }>;

interface Def {
  name: string;
  label: string;
  required: boolean;
  live?: Tester;
  /** Test de forme : renvoie null si la forme est correcte, sinon le problème. */
  shape?: (v: string) => string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
/** "Nom <mail@dom.tld>" ou "mail@dom.tld" */
function isFromAddress(v: string): boolean {
  const m = v.match(/<([^>]+)>\s*$/);
  return EMAIL_RE.test(m ? m[1].trim() : v);
}

const DEFS: Def[] = [
  // ── Stripe ──
  {
    name: 'STRIPE_SECRET_KEY',
    label: 'Stripe',
    required: true,
    shape: (v) =>
      /^(sk|rk)_(live|test)_/.test(v)
        ? null
        : "Ce n'est pas une clé secrète Stripe : elle doit commencer par sk_live_ / sk_test_ (pk_ = clé publique, mauvaise clé).",
    live: async (v) => {
      const r = await ping('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${v}` } });
      const j = judge(r.status, r.body);
      if (j.status === 'ok') {
        const mode = v.includes('_test_') ? 'TEST' : 'LIVE';
        return { status: 'ok', detail: `Clé valide — compte Stripe en mode ${mode}.` };
      }
      return j;
    },
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    label: 'Stripe',
    required: true,
    shape: (v) => (v.startsWith('whsec_') ? null : 'Doit commencer par whsec_ (Stripe → Developers → Webhooks → Signing secret).'),
  },

  // ── Resend ──
  {
    name: 'RESEND_API_KEY',
    label: 'Resend',
    required: true,
    shape: (v) => (v.startsWith('re_') ? null : 'Doit commencer par re_.'),
    live: async (v) => {
      const r = await ping('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${v}` } });
      const j = judge(r.status, r.body);
      if (j.status !== 'ok') return j;
      let n = 0;
      try { n = (JSON.parse(r.body)?.data || []).length; } catch { /* ignore */ }
      return { status: 'ok', detail: `Clé valide — ${n} domaine(s) vérifié(s) sur le compte.` };
    },
  },
  {
    name: 'RESEND_FROM',
    label: 'Resend',
    required: true,
    shape: (v) => (isFromAddress(v) ? null : "Doit être une adresse e-mail (ex. Velbaz <bonjour@tondomaine.com>)."),
  },
  { name: 'EMAIL_WEBHOOK_SECRET', label: 'Resend', required: false },

  // ── Printify ──
  {
    name: 'PRINTIFY_API_TOKEN',
    label: 'Printify',
    required: false,
    live: async (v) => {
      const r = await ping('https://api.printify.com/v1/shops.json', {
        headers: { Authorization: `Bearer ${v}`, 'User-Agent': 'Velbaz' },
      });
      const j = judge(r.status, r.body);
      if (j.status !== 'ok') return j;
      let ids: string[] = [];
      try { ids = (JSON.parse(r.body) || []).map((s: any) => String(s.id)); } catch { /* ignore */ }
      return {
        status: 'ok',
        detail: ids.length
          ? `Clé valide — boutique(s) trouvée(s) : ${ids.join(', ')} (à mettre dans PRINTIFY_SHOP_ID).`
          : 'Clé valide, mais aucune boutique sur ce compte Printify.',
      };
    },
  },
  {
    name: 'PRINTIFY_SHOP_ID',
    label: 'Printify',
    required: false,
    shape: (v) => (/^\d+$/.test(v) ? null : 'Doit être un identifiant numérique (ex. 12345678).'),
  },
  {
    name: 'PRINTIFY_BASE_URL',
    label: 'Printify',
    required: false,
    shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL commençant par https://.'),
  },

  // ── GitHub ──
  {
    name: 'GITHUB_TOKEN',
    label: 'GitHub',
    required: false,
    shape: (v) =>
      /^(gh[pousr]_|github_pat_)/.test(v) ? null : "Forme inhabituelle : un jeton GitHub commence par ghp_ / github_pat_.",
    live: async (v) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 9000);
      let status = 0, body = '', scopes: string | null = null;
      try {
        const r = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${v}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Velbaz' },
          signal: ctrl.signal,
        });
        status = r.status;
        scopes = r.headers.get('x-oauth-scopes');
        body = (await r.text().catch(() => '')).slice(0, 400);
      } finally { clearTimeout(t); }
      const j = judge(status, body);
      if (j.status !== 'ok') return j;
      let login = '';
      try { login = String(JSON.parse(body)?.login || ''); } catch { /* ignore */ }
      const who = login ? ` (compte « ${login} »)` : '';
      // Jeton classique : GitHub renvoie la liste des droits dans x-oauth-scopes.
      if (v.startsWith('ghp_') && scopes !== null) {
        const list = scopes.split(',').map((x) => x.trim());
        if (!list.includes('repo')) {
          return { status: 'bad', detail: `Jeton valide${who} mais sans la case « repo » : l'export GitHub sera refusé (403). Recrée-le avec « repo » coché.` };
        }
        return { status: 'ok', detail: `Clé valide${who}, droit « repo » présent : l'export GitHub fonctionnera.` };
      }
      if (v.startsWith('github_pat_')) {
        return { status: 'ok', detail: `Jeton fine-grained valide${who}. Pour créer des dépôts il lui faut : All repositories + Administration (Read and write) + Contents (Read and write). Sinon utilise un jeton classique avec « repo ».` };
      }
      return { status: 'ok', detail: `Clé valide${who}.` };
    },
  },
  { name: 'GITHUB_OWNER', label: 'GitHub', required: false, shape: (v) => (/^[A-Za-z0-9-]+$/.test(v) ? null : 'Doit être un nom de compte GitHub (sans URL ni slash).') },

  // ── Sentry ──
  {
    name: 'SENTRY_DSN',
    label: 'Sentry',
    required: false,
    shape: (v) => (/^https:\/\/[^@]+@[^/]+\/\d+$/.test(v) ? null : 'Doit ressembler à https://xxxx@oyyy.ingest.sentry.io/123456.'),
  },
  {
    name: 'SENTRY_AUTH_TOKEN',
    label: 'Sentry',
    required: false,
    live: async (v) => {
      const r = await ping('https://sentry.io/api/0/organizations/', { headers: { Authorization: `Bearer ${v}` } });
      return judge(r.status, r.body);
    },
  },
  { name: 'SENTRY_ORG', label: 'Sentry', required: false },
  { name: 'SENTRY_PROJECT', label: 'Sentry', required: false },
  { name: 'SENTRY_API_URL', label: 'Sentry', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL.') },

  // ── Google (connexion sociale) ──
  {
    name: 'GOOGLE_CLIENT_ID',
    label: 'Google',
    required: false,
    shape: (v) =>
      v.endsWith('.apps.googleusercontent.com')
        ? null
        : 'Doit finir par .apps.googleusercontent.com (Google Cloud → Credentials → OAuth client ID).',
  },
  {
    name: 'GOOGLE_CLIENT_SECRET',
    label: 'Google',
    required: false,
    shape: (v) => (v.startsWith('GOCSPX-') ? null : 'Commence normalement par GOCSPX-.'),
  },
  { name: 'GOOGLE_REDIRECT_BASE', label: 'Google', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL commençant par https://.') },

  // ── Replicate (upscale IA print-ready) ──
  {
    name: 'REPLICATE_API_TOKEN',
    label: 'Replicate',
    required: false,
    shape: (v) => (v.startsWith('r8_') ? null : 'Commence normalement par r8_.'),
    live: async (v) => {
      const r = await ping('https://api.replicate.com/v1/account', { headers: { Authorization: `Bearer ${v}` } });
      const j = judge(r.status, r.body);
      if (j.status !== 'ok') return j;
      let u = '';
      try { u = String(JSON.parse(r.body)?.username || ''); } catch { /* ignore */ }
      return { status: 'ok', detail: u ? `Clé valide — compte « ${u} ».` : 'Clé valide.' };
    },
  },

  // ── OpenRouter (modèles non filtrés) ──
  {
    name: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    required: false,
    shape: (v) => (v.startsWith('sk-or-') ? null : 'Commence normalement par sk-or-.'),
    live: async (v) => {
      const r = await ping('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${v}` } });
      return judge(r.status, r.body);
    },
  },

  // ── Bland.ai (appels IA + SMS du Growth Engine) ──
  {
    name: 'BLAND_API_KEY',
    label: 'Bland.ai',
    required: false,
    live: async (v) => {
      const r = await ping('https://api.bland.ai/v1/calls', { headers: { Authorization: v } });
      return judge(r.status, r.body);
    },
  },
  { name: 'BLAND_FROM', label: 'Bland.ai', required: false, shape: (v) => (/^\+[1-9]\d{6,14}$/.test(v) ? null : 'Numéro acheté chez Bland, au format international (ex. +14155550123). Obligatoire pour les SMS.') },

  // ── Discord ──
  {
    name: 'DISCORD_BOT_TOKEN',
    label: 'Discord',
    required: false,
    live: async (v) => {
      const r = await ping('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${v}` } });
      const j = judge(r.status, r.body);
      if (j.status !== 'ok') return j;
      let u = '';
      try { u = String(JSON.parse(r.body)?.username || ''); } catch { /* ignore */ }
      return { status: 'ok', detail: u ? `Jeton valide — bot « ${u} ».` : 'Jeton valide.' };
    },
  },
  { name: 'DISCORD_CLIENT_ID', label: 'Discord', required: false, shape: (v) => (/^\d{15,25}$/.test(v) ? null : 'Doit être un identifiant numérique Discord (15 à 25 chiffres).') },
  { name: 'DISCORD_CLIENT_SECRET', label: 'Discord', required: false },

  // ── Réseaux sociaux (OAuth : pas de test sans échange de jeton) ──
  { name: 'INSTAGRAM_CLIENT_ID', label: 'Instagram', required: false, shape: (v) => (/^\d{8,25}$/.test(v) ? null : 'Doit être un identifiant numérique.') },
  { name: 'INSTAGRAM_CLIENT_SECRET', label: 'Instagram', required: false },
  { name: 'REDDIT_CLIENT_ID', label: 'Reddit', required: false },
  { name: 'REDDIT_CLIENT_SECRET', label: 'Reddit', required: false },
  { name: 'TWITTER_CLIENT_ID', label: 'Twitter / X', required: false },
  { name: 'TWITTER_CLIENT_SECRET', label: 'Twitter / X', required: false },
  {
    name: 'X_LIVE_ENABLED',
    label: 'Twitter / X',
    required: false,
    shape: (v) => (/^(true|false|1|0)$/i.test(v) ? null : 'Doit valoir true ou false.'),
  },

  // ── Firecrawl ──
  {
    name: 'FIRECRAWL_API_KEY',
    label: 'Firecrawl',
    required: false,
    shape: (v) => (v.startsWith('fc-') ? null : 'Commence normalement par fc-.'),
    live: async (v) => {
      const r = await ping('https://api.firecrawl.dev/v1/team/credit-usage', { headers: { Authorization: `Bearer ${v}` } });
      const j = judge(r.status, r.body);
      if (j.status !== 'ok') return j;
      let left: number | null = null;
      try { left = JSON.parse(r.body)?.data?.remaining_credits ?? null; } catch { /* ignore */ }
      return { status: 'ok', detail: left == null ? 'Clé valide.' : `Clé valide — ${left} crédit(s) restant(s).` };
    },
  },
  {
    name: 'TWENTY_FIRST_API_KEY',
    label: '21st.dev',
    required: false,
    // Recherche en lecture seule (1 résultat) : même appel que le builder.
    live: async (v) => {
      const r = await ping('https://api.21st.dev/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': v },
        body: JSON.stringify({ search: 'button', page: 1, per_page: 1 }),
      });
      if (/inactive/i.test(r.body)) return { status: 'bad', detail: 'Clé reconnue mais INACTIVE côté 21st.dev : réactive-la ou régénère-la.' };
      return judge(r.status, r.body);
    },
  },

  // ── Higgsfield (images/vidéos) ──
  { name: 'HF_API_KEY', label: 'Higgsfield', required: false },
  { name: 'HF_API_SECRET', label: 'Higgsfield', required: false },
  { name: 'HF_CREDENTIALS', label: 'Higgsfield', required: false },
  { name: 'HF_BASE_URL', label: 'Higgsfield', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL.') },
  { name: 'HIGGSFIELD_KEY_ID', label: 'Higgsfield', required: false },
  { name: 'HIGGSFIELD_KEY_SECRET', label: 'Higgsfield', required: false },

  // ── OAuth interne ──
  { name: 'OAUTH_REDIRECT_BASE', label: 'OAuth', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL (ex. https://velbaz.com).') },
  { name: 'OAUTH_STATE_SECRET', label: 'OAuth', required: false, shape: (v) => (v.length >= 16 ? null : 'Trop court : 16 caractères minimum.') },

  // ── Serveur de contrôle Velbaz (télémétrie + mur de lancement) ──
  {
    name: 'INGEST_API_KEY',
    label: 'Contrôle Velbaz',
    required: false,
    live: async (v, read) => {
      const base = (read('VELBAZ_CONTROL_BASE_URL') || 'https://velbazw-jixb3k1-preview-4200.runable.site').replace(/\/+$/, '');
      const r = await ping(`${base}/api/v1/verify`, { method: 'POST', headers: { Authorization: `Bearer ${v}`, 'x-api-key': v } });
      return judge(r.status, r.body);
    },
  },
  { name: 'VELBAZ_CONTROL_BASE_URL', label: 'Contrôle Velbaz', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL commençant par https://.') },

  // ── Admin & bêta ──
  {
    name: 'ADMIN_EMAILS',
    label: 'Admin & bêta',
    required: true,
    shape: (v) => (v.split(',').every((e) => EMAIL_RE.test(e.trim())) ? null : 'Adresses e-mail séparées par des virgules.'),
  },
  { name: 'BETA_PUBLIC_CODE', label: 'Admin & bêta', required: false },
  { name: 'BETA_ADMIN_CODE', label: 'Admin & bêta', required: false },
  { name: 'BETA_MAX_TESTERS', label: 'Admin & bêta', required: false, shape: (v) => (/^\d+$/.test(v) ? null : 'Doit être un nombre.') },
  { name: 'VELBAZ_WAITLIST', label: 'Admin & bêta', required: false, shape: (v) => (/^(true|false|1|0|on|off|yes|no)$/i.test(v) ? null : 'Doit valoir 1 (mur actif) ou 0.') },
  { name: 'LAUNCH_INVITE_CODE', label: 'Admin & bêta', required: false },
  { name: 'LAUNCH_GATE_SECRET', label: 'Admin & bêta', required: false, shape: (v) => (v.length >= 16 ? null : 'Trop court : 16 caractères minimum.') },

  // ── URLs ──
  { name: 'PUBLIC_BASE_URL', label: 'URLs', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL.') },
  { name: 'APP_BASE_URL', label: 'URLs', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL.') },
  { name: 'VELBAZ_URL', label: 'URLs', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL.') },
  { name: 'VELBAZ_API_URL', label: 'URLs', required: false, shape: (v) => (/^https?:\/\//.test(v) ? null : 'Doit être une URL.') },
  {
    name: 'SELFHEAL_DISABLED',
    label: 'URLs',
    required: false,
    shape: (v) => (/^(true|false|1|0)$/i.test(v) ? null : 'Doit valoir true ou false.'),
  },

  // ── Domaines (Cloudflare for SaaS + Worker) ──
  {
    name: 'CLOUDFLARE_API_TOKEN',
    label: 'Domaines',
    required: false,
    live: async (v) => {
      const r = await ping('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: `Bearer ${v}` } });
      if (r.status >= 200 && r.status < 300 && /"status"\s*:\s*"active"/.test(r.body)) return { status: 'ok', detail: 'Jeton Cloudflare actif.' };
      if (r.status >= 200 && r.status < 300) return { status: 'bad', detail: "Jeton reconnu mais pas actif (désactivé ou expiré)." };
      return judge(r.status, r.body);
    },
  },
  { name: 'CLOUDFLARE_ZONE_ID', label: 'Domaines', required: false, shape: (v) => (/^[a-f0-9]{32}$/.test(v) ? null : 'Doit être un identifiant de zone Cloudflare (32 caractères hexadécimaux, onglet Overview de la zone).') },
  {
    name: 'VELBAZ_DOMAIN_TARGET',
    label: 'Domaines',
    required: false,
    shape: (v) => (/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(v) ? null : 'Doit être un nom d\'hôte sans https:// (ex. sites.tondomaine.com).'),
  },
  { name: 'VELBAZ_EDGE_SECRET', label: 'Domaines', required: false, shape: (v) => (v.length >= 16 ? null : 'Trop court : 16 caractères minimum (le même que dans le Worker Cloudflare).') },

  // ── Namecheap (pas de test en direct : l'IP du serveur doit être autorisée) ──
  { name: 'NAMECHEAP_API_USER', label: 'Namecheap', required: false, shape: (v) => (/^[A-Za-z0-9_.-]{2,40}$/.test(v) ? null : 'Doit être ton nom d\'utilisateur Namecheap.') },
  { name: 'NAMECHEAP_API_KEY', label: 'Namecheap', required: false, shape: (v) => (/^[a-f0-9]{32}$/i.test(v) ? null : 'Une clé API Namecheap fait 32 caractères hexadécimaux (Profile → Tools → API Access).') },
  { name: 'NAMECHEAP_USERNAME', label: 'Namecheap', required: false, shape: (v) => (/^[A-Za-z0-9_.-]{2,40}$/.test(v) ? null : 'Doit être ton nom d\'utilisateur Namecheap.') },
  {
    name: 'NAMECHEAP_CLIENT_IP',
    label: 'Namecheap',
    required: false,
    shape: (v) => (/^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((n) => Number(n) <= 255) ? null : 'Doit être une adresse IPv4 (celle du serveur, autorisée dans Namecheap → API Access).'),
  },

  // ── Google Ads ──
  { name: 'GOOGLE_ADS_DEVELOPER_TOKEN', label: 'Google Ads', required: false, shape: (v) => (/^[A-Za-z0-9_-]{16,40}$/.test(v) ? null : 'Un developer token Google Ads fait environ 22 caractères (Google Ads → Outils → Centre API).') },
  { name: 'GOOGLE_ADS_CLIENT_ID', label: 'Google Ads', required: false, shape: (v) => (v.endsWith('.apps.googleusercontent.com') ? null : 'Doit se terminer par .apps.googleusercontent.com.') },
  { name: 'GOOGLE_ADS_CLIENT_SECRET', label: 'Google Ads', required: false, shape: (v) => (v.startsWith('GOCSPX-') ? null : 'Commence normalement par GOCSPX-.') },
  { name: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID', label: 'Google Ads', required: false, shape: (v) => (/^\d{10}$/.test(v.replace(/-/g, '')) ? null : 'Doit être un numéro de compte administrateur (MCC) à 10 chiffres, ex. 123-456-7890.') },
  { name: 'GOOGLE_ADS_API_VERSION', label: 'Google Ads', required: false, shape: (v) => (/^v\d+$/.test(v) ? null : 'Doit ressembler à v25.') },

  // ── Meta Ads ──
  {
    name: 'META_APP_ID',
    label: 'Meta Ads',
    required: false,
    shape: (v) => (/^\d{10,20}$/.test(v) ? null : 'Doit être un identifiant numérique d\'app Meta.'),
    live: async (v, read) => {
      const secret = read('META_APP_SECRET');
      if (!secret) return { status: 'untestable', detail: 'Ajoute META_APP_SECRET pour tester la paire.' };
      const r = await ping(`https://graph.facebook.com/oauth/access_token?client_id=${encodeURIComponent(v)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`);
      if (r.status >= 200 && r.status < 300 && /access_token/.test(r.body)) return { status: 'ok', detail: 'ID + secret de l\'app Meta valides.' };
      return judge(r.status, r.body);
    },
  },
  { name: 'META_APP_SECRET', label: 'Meta Ads', required: false, shape: (v) => (/^[a-f0-9]{32}$/i.test(v) ? null : 'Un secret d\'app Meta fait 32 caractères hexadécimaux.') },
  { name: 'META_GRAPH_VERSION', label: 'Meta Ads', required: false, shape: (v) => (/^v\d+\.\d+$/.test(v) ? null : 'Doit ressembler à v26.0.') },
];

/** Les clés que Velbaz sait tester en direct auprès du fournisseur. */
export const LIVE_TESTABLE = DEFS.filter((d) => d.live).map((d) => d.name);

/** Tous les noms que la vérification connaît. */
export const CHECKABLE_KEYS = DEFS.map((d) => d.name);

export interface VerifyReport {
  checkedAt: number;
  results: KeyCheck[];
  summary: { ok: number; bad: number; missing: number; untestable: number; error: number };
}

/**
 * Vérifie des clés.
 * @param only    restreint la vérification à ces noms (facultatif).
 * @param values  valeurs à tester au lieu de celles du coffre : sert à tester
 *                un fichier AVANT de l'importer (rien n'est stocké).
 */
export async function verifyKeys(
  only?: string[],
  values?: Record<string, string>,
): Promise<VerifyReport> {
  const wanted = only && only.length ? new Set(only.map((s) => s.toUpperCase())) : null;
  const defs = wanted ? DEFS.filter((d) => wanted.has(d.name)) : DEFS;
  const read = (name: string): string => (values ? (values[name] || '').trim() : readValue(name));

  const results = await Promise.all(
    defs.map(async (def): Promise<KeyCheck> => {
      const value = read(def.name);
      const base = { name: def.name, label: def.label, required: def.required, live: !!def.live };

      if (!value) {
        return {
          ...base,
          live: false,
          status: 'missing',
          last4: null,
          detail: def.required ? 'Non renseignée — nécessaire au fonctionnement.' : 'Non renseignée (optionnelle).',
        };
      }

      // 1. Contrôle de forme : attrape la clé collée au mauvais endroit.
      if (def.shape) {
        const problem = def.shape(value);
        if (problem) {
          return { ...base, live: false, status: 'bad', last4: last4(value), detail: problem };
        }
      }

      // 2. Test réel auprès du fournisseur quand il existe.
      if (def.live) {
        try {
          const r = await def.live(value, read);
          return { ...base, status: r.status, detail: r.detail, last4: last4(value) };
        } catch (e: any) {
          const reason = e?.name === 'AbortError' ? 'délai dépassé' : String(e?.message || e?.name || 'erreur réseau');
          return { ...base, status: 'error', last4: last4(value), detail: `Test impossible (${redactForLog(reason)}).` };
        }
      }

      // 3. Ni test réel, ni règle de forme : on confirme seulement la présence.
      return {
        ...base,
        live: false,
        status: def.shape ? 'ok' : 'untestable',
        last4: last4(value),
        detail: def.shape
          ? 'Format correct (ce fournisseur ne propose pas de test en ligne).'
          : 'Renseignée — aucun test possible sans appel facturé au fournisseur.',
      };
    }),
  );

  const summary = { ok: 0, bad: 0, missing: 0, untestable: 0, error: 0 };
  for (const r of results) summary[r.status]++;

  // Log volontairement réduit aux compteurs : aucun nom de clé, aucune valeur.
  console.log(
    `[vault] vérification : ${summary.ok} OK, ${summary.bad} invalide(s), ${summary.missing} absente(s), ${summary.error} erreur(s)`,
  );

  return { checkedAt: Date.now(), results, summary };
}
