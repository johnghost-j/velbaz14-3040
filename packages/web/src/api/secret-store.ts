// ─── Secret Store sécurisé (AES-256-GCM) + résolveur runtime ─────────────────
//
// Objectif : permettre à l'admin de saisir des clés API depuis le panel admin,
// les stocker CHIFFRÉES au repos, et les résoudre au runtime — SANS jamais
// exposer la valeur en clair au front (write-only).
//
// Sécurité :
//   - Chiffrement AES-256-GCM. La master key est dérivée (scrypt) d'un secret
//     serveur (SECRET_STORE_KEY, repli BETTER_AUTH_SECRET). Elle vit UNIQUEMENT
//     dans l'env, jamais en base. Sans elle, les valeurs chiffrées sont illisibles.
//   - L'API ne renvoie jamais la valeur déchiffrée : seulement { isSet, last4 }.
//   - Déchiffrement uniquement ici, côté serveur, au moment de l'usage.
//   - Cache mémoire (déchiffré) pour éviter de taper la DB à chaque appel IA ;
//     rafraîchi à chaque écriture/suppression + au boot.
//
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { db } from './database/index';
import * as schema from './database/schema';
import { eq } from 'drizzle-orm';
import { setProviderKeys, type CustomProvider } from './agent/gateway';

// ── Master key (dérivée, jamais stockée) ──
function masterKey(): Buffer {
  const secret =
    process.env.SECRET_STORE_KEY ||
    process.env.BETTER_AUTH_SECRET ||
    'velbaz-insecure-dev-fallback-change-me';
  // Sel fixe : on veut une clé déterministe par déploiement (sinon on ne pourrait
  // plus déchiffrer). La robustesse vient du secret lui-même (48 octets aléatoires).
  return scryptSync(secret, 'velbaz-secret-store::v1', 32);
}

/** Chiffre une valeur en clair -> "v1:ivB64:tagB64:cipherB64". */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Déchiffre "v1:iv:tag:cipher" -> clair. Renvoie null si corrompu / mauvaise clé. */
export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    const [v, ivB64, tagB64, dataB64] = payload.split(':');
    if (v !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

function last4(s: string): string {
  return s.length <= 4 ? '••••' : s.slice(-4);
}

// ── Caches mémoire (valeurs déchiffrées, jamais envoyées au front) ──
const secretCache: Map<string, string> = ((globalThis as any).__velbaz_secret_cache ??= new Map());
const providerCache: Map<string, { apiKey: string; baseUrl?: string; enabled: boolean; status: string }> =
  ((globalThis as any).__velbaz_provider_cache ??= new Map());

// Noms de secrets "génériques" gérés par le panel (hors clés IA providers).
export const KNOWN_SECRETS = [
  'RESEND_API_KEY',
  'RESEND_FROM',
  'HF_CREDENTIALS',
  'HF_API_KEY',
  'HF_API_SECRET',
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'EMAIL_WEBHOOK_SECRET',
  // ── Stripe (clé secrète live/test + secret de signature webhook) ──
  // Stockées CHIFFRÉES, saisies depuis l'Admin Panel. Jamais hardcodées.
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  // Commission Velbaz (%) prélevée sur chaque vente des sites générés encaissée
  // via le Stripe Velbaz (api/platform-payments.ts). Défaut 10.
  'VELBAZ_PLATFORM_FEE_PERCENT',
  // ── Printify (print-on-demand RÉEL : produits + commandes en production) ──
  // Token API personnel généré dans Printify → Settings → Connections → API.
  // Renseigné ici, il sert de compte Printify par défaut pour TOUTES les
  // entreprises de l'instance (une entreprise qui enregistre son propre
  // PRINTIFY_API_TOKEN dans ses secrets garde la priorité). SHOP_ID optionnel :
  // sans lui on prend la première boutique du compte. BASE_URL : override API.
  'PRINTIFY_API_TOKEN',
  'PRINTIFY_SHOP_ID',
  'PRINTIFY_BASE_URL',
  // ── Publication / hébergement ("Publish your website") ──
  // Jeton du fournisseur de déploiement (ex. Vercel/Netlify) utilisé pour
  // provisionner un vrai domaine + un domaine personnalisé. Optionnel : sans lui,
  // le site est quand même publié sur l'hébergement interne Velbaz (/s/:subdomain).
  'VELBAZ_DEPLOY_TOKEN',
  // ── Domaines personnalisés (api/domains.ts) ──
  // HTTPS + CDN automatiques sur le domaine du client via Cloudflare for SaaS.
  // Optionnel : sans ces deux clés, le domaine est quand même vérifié (DNS réel)
  // et servi en HTTP par l'hébergement Velbaz ; seul le certificat auto manque.
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ZONE_ID',
  // Cible CNAME annoncée aux clients (défaut : cname.velbaz.site) et domaine
  // racine de l'hébergement (défaut : velbaz.site). Optionnels.
  'VELBAZ_DOMAIN_TARGET',
  'VELBAZ_ROOT_DOMAIN',
  // Secret partagé avec le Worker Cloudflare placé devant les domaines clients
  // (en-tête x-velbaz-site-host). Sans lui, l'hôte d'origine n'est pas cru.
  'VELBAZ_EDGE_SECRET',
  // ── Achat de domaine depuis Velbaz (registrar Namecheap) ──
  // Les 4 sont requises ensemble. Sans elles, la recherche de disponibilité
  // (RDAP, publique) fonctionne mais l'achat répond 501 + clés manquantes.
  'NAMECHEAP_API_USER',
  'NAMECHEAP_API_KEY',
  'NAMECHEAP_USERNAME',
  'NAMECHEAP_CLIENT_IP',
  // ── Sentry (surveillance des erreurs de Velbaz + auto-réparation) ──
  // DSN : envoi des erreurs. Les trois autres : lecture de l'API Sentry par
  // le module d'auto-réparation (selfheal). Tout est optionnel — sans eux,
  // l'auto-réparation retombe sur le flux d'erreurs interne (error_logs).
  'SENTRY_DSN',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'SENTRY_API_URL',
  // ── Connexion Google ("Continuer avec Google") — cf. api/google-auth.ts ──
  // Les deux sont requises ensemble (Google Cloud → API & Services →
  // Credentials → OAuth client ID, type "Web application"). Optionnelles :
  // sans elles, le bouton Google est simplement masqué et la photo de profil
  // vient de Gravatar ou de l'image envoyée par l'utilisateur.
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  // Optionnel : fige la base des URL de retour OAuth Google (sinon déduite de
  // la requête). Utile derrière un domaine personnalisé.
  'GOOGLE_REDIRECT_BASE',
  // ── Builder : composants 21st.dev + scraping Firecrawl ──
  // Avant : lues uniquement dans process.env (impossibles à saisir au panel).
  'TWENTY_FIRST_API_KEY',
  'FIRECRAWL_API_KEY',
  // ── OpenRouter : seul chemin vers les modèles non filtrés (sinon repli
  // gateway Runable). Optionnel.
  'OPENROUTER_API_KEY',
  // ── Upscale IA print-ready (Real-ESRGAN via Replicate). Sans : sharp local.
  // Une entreprise qui a son propre REPLICATE_API_TOKEN garde la priorité.
  'REPLICATE_API_TOKEN',
  // ── Growth Engine : appels IA + SMS (Bland.ai, BLAND_FROM requis pour SMS) ──
  // Sans elles : mode démo affiché comme tel, zéro appel payant.
  'BLAND_API_KEY',
  'BLAND_FROM',
  // ── Publication réseaux sociaux (api/social/) — paires OAuth ──
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'INSTAGRAM_CLIENT_ID',
  'INSTAGRAM_CLIENT_SECRET',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'TWITTER_CLIENT_ID',
  'TWITTER_CLIENT_SECRET',
  'OAUTH_REDIRECT_BASE',
  'OAUTH_STATE_SECRET',
  // ── Régies publicitaires (api/ad-accounts/) : chaque client connecte SON
  // compte Google Ads / Meta Ads ; l'IA y crée des campagnes EN PAUSE. ──
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_API_VERSION',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_GRAPH_VERSION',
  // ── Serveur de contrôle Velbaz (télémétrie + mur de lancement distant) ──
  'INGEST_API_KEY',
  'VELBAZ_CONTROL_BASE_URL',
] as const;

export const AI_PROVIDERS = ['openai', 'anthropic', 'google', 'custom'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// ─── Résolution runtime d'un secret : cache -> DB -> process.env ─────────────
export function getSecret(name: string): string {
  const cached = secretCache.get(name);
  if (cached !== undefined) return cached;
  // Pas en cache : repli env (le cache est peuplé au boot par loadAllSecrets()).
  return process.env[name] || '';
}

/** Pousse la config providers déchiffrée vers le gateway (routing clé perso). */
function syncGateway() {
  const map: Record<string, CustomProvider> = {};
  for (const [provider, cfg] of providerCache) {
    // Routage DIRECT uniquement si : activé + clé présente + PAS marquée invalide.
    // Une clé non encore testée ('unknown') est tentée en direct ; dès qu'un test
    // la marque 'invalid', elle est retirée -> repli automatique sur le gateway.
    if (cfg.enabled && cfg.apiKey && cfg.status !== 'invalid') {
      map[provider] = { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl };
    }
  }
  // Clé OpenRouter saisie au panel (API Keys) → routage direct des modèles
  // "openrouter/…" (non filtrés). Repli process.env.OPENROUTER_API_KEY dans gateway.ts.
  const orKey = secretCache.get('OPENROUTER_API_KEY');
  if (!map.openrouter && orKey) map.openrouter = { apiKey: orKey };
  setProviderKeys(map);
}

// ─── Chargement initial (boot) : DB -> caches ────────────────────────────────
export async function loadAllSecrets(): Promise<void> {
  try {
    const rows = await db.select().from(schema.secretStore);
    secretCache.clear();
    for (const r of rows) {
      const v = decryptSecret(r.valueEnc);
      if (v != null) secretCache.set(r.name, v);
    }
    const providers = await db.select().from(schema.aiProviderConfig);
    providerCache.clear();
    for (const p of providers) {
      const key = decryptSecret(p.apiKeyEnc);
      if (key != null) {
        providerCache.set(p.provider, {
          apiKey: key,
          baseUrl: p.baseUrl || undefined,
          enabled: !!p.enabled,
          status: p.status || 'unknown',
        });
      }
    }
    syncGateway();
    console.log(
      `[secret-store] chargé : ${secretCache.size} secret(s), ${providerCache.size} provider(s) IA`,
    );
  } catch (e) {
    console.warn('[secret-store] chargement initial échoué (tables manquantes ?) :', (e as Error).message);
  }
}

// ─── Écriture / suppression secrets génériques ───────────────────────────────
export async function setSecret(name: string, value: string, updatedBy?: string): Promise<void> {
  const enc = encryptSecret(value);
  const now = new Date();
  await db
    .insert(schema.secretStore)
    .values({ name, valueEnc: enc, last4: last4(value), updatedBy: updatedBy || null, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.secretStore.name,
      set: { valueEnc: enc, last4: last4(value), updatedBy: updatedBy || null, updatedAt: now },
    });
  secretCache.set(name, value);
  if (name === 'OPENROUTER_API_KEY') syncGateway();
}

export async function deleteSecret(name: string): Promise<void> {
  await db.delete(schema.secretStore).where(eq(schema.secretStore.name, name));
  secretCache.delete(name);
  if (name === 'OPENROUTER_API_KEY') syncGateway();
}

// ─── Amorçage du cache mémoire (utilisé par le coffre d'import) ──────────────
// Ces deux fonctions n'écrivent RIEN en base : elles alimentent seulement le
// cache déchiffré du process, pour que getSecret() voie les valeurs réarmées
// après un « unlock » du coffre scellé (secret-vault.ts).

/** Place une valeur déjà déchiffrée dans le cache mémoire (aucune écriture DB). */
export function primeSecretCache(name: string, value: string): void {
  secretCache.set(name, value);
  if (name === 'OPENROUTER_API_KEY') syncGateway();
}

/** Retire une valeur du cache mémoire (aucune suppression en base). */
export function unprimeSecretCache(name: string): void {
  secretCache.delete(name);
  if (name === 'OPENROUTER_API_KEY') syncGateway();
}

// ─── Écriture / suppression providers IA ─────────────────────────────────────
export async function setAiProvider(
  provider: AiProvider,
  apiKey: string,
  opts: { baseUrl?: string; updatedBy?: string } = {},
): Promise<void> {
  const enc = encryptSecret(apiKey);
  const now = new Date();
  await db
    .insert(schema.aiProviderConfig)
    .values({
      provider,
      apiKeyEnc: enc,
      baseUrl: opts.baseUrl || null,
      enabled: true,
      status: 'unknown',
      last4: last4(apiKey),
      updatedBy: opts.updatedBy || null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.aiProviderConfig.provider,
      set: {
        apiKeyEnc: enc,
        baseUrl: opts.baseUrl || null,
        enabled: true,
        status: 'unknown',
        last4: last4(apiKey),
        updatedBy: opts.updatedBy || null,
        updatedAt: now,
      },
    });
  providerCache.set(provider, { apiKey, baseUrl: opts.baseUrl, enabled: true, status: 'unknown' });
  syncGateway();
}

export async function setAiProviderEnabled(provider: AiProvider, enabled: boolean): Promise<void> {
  await db
    .update(schema.aiProviderConfig)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(schema.aiProviderConfig.provider, provider));
  const cur = providerCache.get(provider);
  if (cur) providerCache.set(provider, { ...cur, enabled });
  syncGateway();
}

export async function deleteAiProvider(provider: AiProvider): Promise<void> {
  await db.delete(schema.aiProviderConfig).where(eq(schema.aiProviderConfig.provider, provider));
  providerCache.delete(provider);
  syncGateway();
}

export async function setAiProviderStatus(
  provider: AiProvider,
  status: 'valid' | 'invalid' | 'unknown',
  message?: string,
): Promise<void> {
  await db
    .update(schema.aiProviderConfig)
    .set({ status, statusMessage: message || null, updatedAt: new Date() })
    .where(eq(schema.aiProviderConfig.provider, provider));
  const cur = providerCache.get(provider);
  if (cur) providerCache.set(provider, { ...cur, status });
  // Re-synchronise le gateway : une clé marquée 'invalid' est retirée du routage
  // direct (repli gateway) ; une clé re-validée y est réintégrée.
  syncGateway();
}

/** Renvoie la clé déchiffrée d'un provider (usage serveur uniquement, ex. test). */
export function getAiProviderKey(provider: string): { apiKey: string; baseUrl?: string } | null {
  const c = providerCache.get(provider);
  return c && c.apiKey ? { apiKey: c.apiKey, baseUrl: c.baseUrl } : null;
}

// ─── Statuts write-only pour le panel (JAMAIS la valeur en clair) ────────────
export async function listSecretStatus(): Promise<
  Array<{ name: string; isSet: boolean; last4: string | null; updatedAt: number | null; source: 'db' | 'env' | 'none' }>
> {
  const rows = await db.select().from(schema.secretStore);
  const byName = new Map(rows.map((r) => [r.name, r]));
  return KNOWN_SECRETS.map((name) => {
    const row = byName.get(name);
    if (row) {
      return {
        name,
        isSet: true,
        last4: row.last4,
        updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : null,
        source: 'db' as const,
      };
    }
    const envVal = process.env[name];
    return {
      name,
      isSet: !!(envVal && envVal.replace(/"/g, '').trim()),
      last4: envVal ? last4(envVal) : null,
      updatedAt: null,
      source: (envVal ? 'env' : 'none') as 'env' | 'none',
    };
  });
}

export async function listAiProviderStatus(): Promise<
  Array<{ provider: string; isSet: boolean; last4: string | null; baseUrl: string | null; enabled: boolean; status: string; statusMessage: string | null; updatedAt: number | null }>
> {
  const rows = await db.select().from(schema.aiProviderConfig);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return AI_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    if (!row) {
      return { provider, isSet: false, last4: null, baseUrl: null, enabled: false, status: 'none', statusMessage: null, updatedAt: null };
    }
    return {
      provider,
      isSet: true,
      last4: row.last4,
      baseUrl: row.baseUrl,
      enabled: !!row.enabled,
      status: row.status || 'unknown',
      statusMessage: row.statusMessage,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : null,
    };
  });
}
