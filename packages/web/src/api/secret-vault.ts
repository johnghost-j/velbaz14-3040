// ─── Vault d'import de clés API (fichier .env → coffre chiffré) ──────────────
//
// Objectif : l'admin remplit UN fichier hors-ligne (API-KEYS-A-REMPLIR.env),
// le dépose dans l'Admin Panel, et TOUTES les clés partent directement dans le
// coffre chiffré. Le fichier est ensuite détruit côté navigateur.
//
// Garanties de sécurité implémentées ici :
//   1. Le contenu du fichier n'est JAMAIS écrit sur le disque du serveur.
//      Il arrive en mémoire (corps de requête), est parsé, chiffré, puis le
//      tampon est écrasé. Aucun fs.write, aucun log, aucune trace.
//   2. Aucune valeur en clair ne ressort d'une réponse HTTP : on ne renvoie que
//      { name, last4, target }. redactForLog() neutralise tout log accidentel.
//   3. Deux modes de chiffrement :
//      - 'server' : AES-256-GCM avec la clé serveur (SECRET_STORE_KEY / repli
//        BETTER_AUTH_SECRET). Survit au redémarrage sans intervention.
//      - 'sealed' : AES-256-GCM avec une clé dérivée (scrypt) d'une PHRASE DE
//        PASSE que seul l'admin connaît. Elle n'est stockée NULLE PART — ni en
//        base, ni dans .env, ni sur disque. Conséquence voulue : personne qui
//        lit la base ou le système de fichiers (y compris un agent avec un accès
//        shell) ne peut déchiffrer. Après un redémarrage, l'admin doit faire
//        « unlock » une fois pour réarmer les clés en mémoire.
//   4. Les clés lues via process.env par le code (OAuth social, modèles, bêta…)
//      sont injectées EN MÉMOIRE dans process.env. Le fichier .env sur disque
//      n'est jamais modifié.
//
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './database/index';
import * as schema from './database/schema';
import { eq, inArray, like } from 'drizzle-orm';
import {
  KNOWN_SECRETS,
  primeSecretCache,
  unprimeSecretCache,
} from './secret-store';
import { isPdf, extractPdfFields, pdfToEnvContent } from './pdf-form';

// ── Clés lues directement dans process.env par le code applicatif ────────────
// Elles ne passent pas par getSecret() : on les injecte en mémoire dans
// process.env au moment de l'import (et à chaque unlock).
export const ENV_ONLY_KEYS = [
  'ADMIN_EMAILS',
  'SELFHEAL_DISABLED',
  // Builder & extras IA
  'AI_MODEL',
  'IMAGE_MODEL',
  'UNCENSORED_MODEL',
  'TIER_MODEL_LITE',
  'TIER_MODEL_PRO',
  'TIER_MODEL_MAX',
  'BUILDER_REPAIR_MODEL',
  'SELFHEAL_MODEL',
  'COMMS_REASONING_MODEL',
  'AI_CREDITS_PER_USD',
  // Higgsfield — replis historiques
  'HIGGSFIELD_KEY_ID',
  'HIGGSFIELD_KEY_SECRET',
  'HF_KEY',
  'HF_SECRET',
  'HF_BASE_URL',
  // Réseaux sociaux (les paires OAuth sont dans KNOWN_SECRETS)
  'X_LIVE_ENABLED',
  // Accès bêta
  'BETA_PUBLIC_CODE',
  'BETA_ADMIN_CODE',
  'BETA_MAX_TESTERS',
  // Mur de lancement / liste d'attente (api/velbaz-control/)
  'VELBAZ_WAITLIST',
  'LAUNCH_INVITE_CODE',
  'LAUNCH_GATE_SECRET',
  // Divers / opérationnel
  'PUBLIC_BASE_URL',
  'APP_BASE_URL',
  'VELBAZ_URL',
  'VELBAZ_API_URL',
  'VELBAZ_APPS_ROOT',
  'CHIMERA_ASSETS_DIR',
  'MAX_AUTO_RELAUNCH_PER_BOOT',
  'DISABLE_SERVER_JSX',
] as const;

// ── Clés d'infrastructure gérées par Runable : import REFUSÉ ─────────────────
// Les changer à chaud casserait la base, le stockage ou les sessions.
export const MANAGED_KEYS = [
  'NODE_ENV',
  'WEBSITE_URL',
  'APPLICATION_ID',
  'BETTER_AUTH_SECRET',
  'SECRET_STORE_KEY',
  'DATABASE_URL',
  'DATABASE_AUTH_TOKEN',
  'AI_GATEWAY_BASE_URL',
  'AI_GATEWAY_API_KEY',
  'AUTUMN_SECRET_KEY',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'VITE_RUNABLE_AUTH_ISSUER',
  'VITE_APPLICATION_ID',
  'RUNABLE_URL',
] as const;

// ── Tout ce qui passe déjà par le gateway Runable : hors du fichier d'import ──
// Aucune clé IA à fournir : le gateway est déjà branché et facturé côté Runable.
// Ces noms sont retirés du gabarit, de l'inventaire, et refusés à l'import.
export const GATEWAY_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_AI_API_KEY',
  'GEMINI_API_KEY',
  'AI_MODEL',
  'IMAGE_MODEL',
  'UNCENSORED_MODEL',
  'TIER_MODEL_LITE',
  'TIER_MODEL_PRO',
  'TIER_MODEL_MAX',
  'BUILDER_REPAIR_MODEL',
  'SELFHEAL_MODEL',
  'COMMS_REASONING_MODEL',
  'AI_CREDITS_PER_USD',
] as const;

// ── Hébergement : PAS à fournir ──────────────────────────────────────────────
// [2026-10-01] Les clés de DOMAINES (Cloudflare, Namecheap, cible CNAME, secret
// du Worker) sont revenues dans le gabarit : sans elles un domaine client ne
// peut pas réellement se raccorder. Seul le jeton de déploiement externe reste
// hors gabarit (rien ne le réclame ; import toujours accepté).
export const HOSTING_KEYS = [
  'VELBAZ_DEPLOY_TOKEN',
] as const;

/** Clé hors gabarit : gateway IA ou hébergement géré ailleurs. */
function isOutOfScope(name: string): boolean {
  return (
    (GATEWAY_KEYS as readonly string[]).includes(name) ||
    (HOSTING_KEYS as readonly string[]).includes(name)
  );
}

// Lignes réservées au fonctionnement interne du coffre (jamais affichées).
const VAULT_SALT_ROW = '__vault_salt';
const VAULT_VERIFIER_ROW = '__vault_verifier';
const VERIFIER_PLAINTEXT = 'velbaz-vault-verifier::v2';
export const RESERVED_ROWS = [VAULT_SALT_ROW, VAULT_VERIFIER_ROW];

export type EncMode = 'server' | 'sealed';
export type ImportTarget = 'secret' | 'provider' | 'env';

// ── Clé scellée : mémoire du process uniquement, jamais persistée ────────────
interface SealedState {
  key: Buffer | null;
  unlockedAt: number | null;
}
const sealed: SealedState = ((globalThis as any).__velbaz_vault_sealed ??= {
  key: null,
  unlockedAt: null,
});

function serverKey(): Buffer {
  const secret =
    process.env.SECRET_STORE_KEY ||
    process.env.BETTER_AUTH_SECRET ||
    'velbaz-insecure-dev-fallback-change-me';
  return scryptSync(secret, 'velbaz-secret-store::v1', 32);
}

function deriveSealedKey(passphrase: string, saltB64: string): Buffer {
  // scrypt N=2^15 : ~100 ms par essai, rend le brute-force hors-ligne coûteux
  // même si la base entière est volée.
  return scryptSync(passphrase.normalize('NFKC'), Buffer.from(saltB64, 'base64'), 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
}

function encryptWith(key: Buffer, plain: string, version: 'v1' | 'v2'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptWith(key: Buffer, payload: string): string | null {
  try {
    const [, ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function last4(s: string): string {
  return s.length <= 4 ? '••••' : s.slice(-4);
}

/** Efface une chaîne sensible de la mémoire autant que JS le permet. */
function wipe(buf: Buffer | null) {
  if (buf) buf.fill(0);
}

// ─── Anti-fuite : masque toute valeur sensible avant un éventuel log ─────────
const SENSITIVE_PATTERNS = [
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{6,}/g,
  /\bsk-[A-Za-z0-9-_]{12,}/g,
  /\bre_[A-Za-z0-9]{8,}/g,
  /\bghp_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{10,}/g,
  /\bsntrys_[A-Za-z0-9-_]{10,}/g,
  /\beyJ[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{6,}\.?[A-Za-z0-9-_]*/g,
  /\bAIza[A-Za-z0-9-_]{20,}/g,
];

/** Neutralise toute clé reconnaissable dans un texte destiné à un log. */
export function redactForLog(text: string): string {
  let out = text;
  for (const re of SENSITIVE_PATTERNS) out = out.replace(re, (m) => `[redacted:${m.slice(0, 3)}…${m.slice(-2)}]`);
  out = out.replace(/^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+)$/gm, (_m, k: string) => `${k}=[redacted]`);
  return out;
}

// ─── Parsing d'un fichier .env en mémoire ────────────────────────────────────
export interface ParsedEntry {
  name: string;
  value: string;
}

/** Parse un contenu .env. Ignore commentaires, lignes vides, valeurs vides. */
export function parseEnvBundle(content: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let name = line.slice(0, eq).trim();
    // tolère "export KEY=", "[ADMIN] KEY=" collés par copier-coller
    name = name.replace(/^export\s+/i, '').replace(/^\[[A-Z]+\]\s*/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    // retire les guillemets encadrants
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // ignore les placeholders laissés en place
    if (!value) continue;
    if (/^(xxx+|<.*>|\.\.\.|•+|to-?do|remplir|your[-_ ]?key)$/i.test(value)) continue;
    const upper = name.toUpperCase();
    if (seen.has(upper)) continue; // première occurrence gagne
    seen.add(upper);
    out.push({ name: upper, value });
  }
  return out;
}

// ─── Décodage du fichier déposé : .env / .txt OU PDF formulaire rempli ──────
//
// L'admin peut remplir le PDF « VELBAZ-CLES-API.pdf » dans son lecteur et le
// déposer tel quel : un PDF n'est pas du texte, il faut en extraire les champs.
// Sinon l'import ne trouvait « aucune clé ».
export interface DecodedBundle {
  content: string;
  source: 'text' | 'pdf';
  /** Nombre de champs remplis trouvés dans le PDF (0 pour un fichier texte). */
  pdfFields: number;
}

/**
 * Normalise le contenu déposé.
 * @param payload  soit du texte, soit les octets bruts d'un fichier (PDF inclus).
 */
export function decodeBundlePayload(payload: string | Uint8Array): DecodedBundle {
  if (typeof payload !== 'string') {
    if (isPdf(payload)) {
      const fields = extractPdfFields(payload);
      return { content: pdfToEnvContent(payload), source: 'pdf', pdfFields: fields.length };
    }
    return { content: Buffer.from(payload).toString('utf8'), source: 'text', pdfFields: 0 };
  }
  // Un PDF lu par erreur comme du texte : on récupère les octets en latin1.
  const bytes = new Uint8Array(Buffer.from(payload, 'latin1'));
  if (isPdf(bytes)) {
    const fields = extractPdfFields(bytes);
    return { content: pdfToEnvContent(bytes), source: 'pdf', pdfFields: fields.length };
  }
  return { content: payload, source: 'text', pdfFields: 0 };
}

/**
 * Analyse un fichier SANS rien stocker : dit quelles clés ont été détectées,
 * lesquelles sont inconnues, et pourquoi un fichier peut sembler vide.
 * Aucune valeur n'est renvoyée : uniquement le nom et les 4 derniers caractères.
 */
export interface InspectReport {
  source: 'text' | 'pdf';
  pdfFields: number;
  detected: Array<{ name: string; last4: string; known: boolean; scope: 'ok' | 'gateway' | 'hosting' | 'managed' | 'unknown' }>;
  hint: string | null;
}

export function inspectBundle(payload: string | Uint8Array): InspectReport {
  const decoded = decodeBundlePayload(payload);
  const entries = parseEnvBundle(decoded.content);

  const detected = entries.map((e) => {
    let scope: 'ok' | 'gateway' | 'hosting' | 'managed' | 'unknown' = 'unknown';
    if ((GATEWAY_KEYS as readonly string[]).includes(e.name)) scope = 'gateway';
    else if ((HOSTING_KEYS as readonly string[]).includes(e.name)) scope = 'hosting';
    else if ((MANAGED_KEYS as readonly string[]).includes(e.name)) scope = 'managed';
    else if (
      (KNOWN_SECRETS as readonly string[]).includes(e.name) ||
      (ENV_ONLY_KEYS as readonly string[]).includes(e.name)
    ) scope = 'ok';
    return { name: e.name, last4: last4(e.value), known: scope === 'ok', scope };
  });

  // Diagnostic lisible quand rien n'est trouvé : la cause la plus fréquente.
  let hint: string | null = null;
  if (!detected.length) {
    if (decoded.source === 'pdf' && decoded.pdfFields === 0) {
      hint =
        "PDF reconnu, mais aucun champ rempli n'a été enregistré. Dans ton lecteur, clique dans les cases, tape tes valeurs, puis fais « Enregistrer » (Ctrl+S / Cmd+S) AVANT de déposer le fichier — Chrome demande parfois « Télécharger » pour garder le formulaire rempli.";
    } else if (decoded.source === 'pdf') {
      hint = `PDF lu (${decoded.pdfFields} champ(s) rempli(s)) mais aucun nom de clé valide : les noms des cases ont peut-être été modifiés.`;
    } else if (!decoded.content.trim()) {
      hint = 'Le fichier est vide.';
    } else if (!/=/.test(decoded.content)) {
      hint = "Aucun signe « = » dans le fichier : chaque ligne doit s'écrire NOM_DE_LA_CLE=valeur.";
    } else {
      hint =
        "Des lignes existent mais toutes les valeurs sont vides (NOM= sans rien après le =) ou sont restées des exemples. Écris la valeur juste après le « = », sans espace ni guillemets.";
    }
  }
  return { source: decoded.source, pdfFields: decoded.pdfFields, detected, hint };
}

// ─── État du coffre (jamais de valeur en clair) ──────────────────────────────
export interface VaultStatus {
  sealedRows: number;
  serverRows: number;
  isUnlocked: boolean;
  unlockedAt: number | null;
  hasSealedBundle: boolean;
  envInjected: number;
  totalKnown: number;
}

export async function vaultStatus(): Promise<VaultStatus> {
  let sealedRows = 0;
  let serverRows = 0;
  let hasSealedBundle = false;
  try {
    const rows = await db.select().from(schema.secretStore);
    for (const r of rows) {
      if (RESERVED_ROWS.includes(r.name)) {
        if (r.name === VAULT_VERIFIER_ROW) hasSealedBundle = true;
        continue;
      }
      if (r.valueEnc.startsWith('v2:')) sealedRows++;
      else serverRows++;
    }
  } catch {
    /* tables absentes : statut vide */
  }
  const envInjected = ENV_ONLY_KEYS.filter((k) => !!process.env[k]).length;
  return {
    sealedRows,
    serverRows,
    isUnlocked: !!sealed.key,
    unlockedAt: sealed.unlockedAt,
    hasSealedBundle,
    envInjected,
    totalKnown: KNOWN_SECRETS.length + ENV_ONLY_KEYS.length,
  };
}

// ─── Mise en place / vérification de la phrase de passe ──────────────────────
async function readRow(name: string): Promise<string | null> {
  const rows = await db.select().from(schema.secretStore).where(eq(schema.secretStore.name, name));
  return rows[0]?.valueEnc ?? null;
}

async function writeRow(name: string, valueEnc: string, by?: string) {
  const now = new Date();
  await db
    .insert(schema.secretStore)
    .values({ name, valueEnc, last4: null, updatedBy: by || null, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.secretStore.name,
      set: { valueEnc, updatedBy: by || null, updatedAt: now },
    });
}

/**
 * Dérive et vérifie la clé scellée.
 * - Premier usage : crée le sel + le vérificateur.
 * - Ensuite : refuse une phrase de passe qui ne correspond pas.
 */
async function resolveSealedKey(passphrase: string, by?: string): Promise<Buffer> {
  let saltB64 = await readRow(VAULT_SALT_ROW);
  const verifier = await readRow(VAULT_VERIFIER_ROW);

  if (!saltB64 || !verifier) {
    saltB64 = randomBytes(16).toString('base64');
    const key = deriveSealedKey(passphrase, saltB64);
    await writeRow(VAULT_SALT_ROW, saltB64, by);
    await writeRow(VAULT_VERIFIER_ROW, encryptWith(key, VERIFIER_PLAINTEXT, 'v2'), by);
    return key;
  }

  const key = deriveSealedKey(passphrase, saltB64);
  const check = decryptWith(key, verifier);
  const expected = Buffer.from(VERIFIER_PLAINTEXT);
  const got = Buffer.from(check ?? '');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    wipe(key);
    throw new Error('WRONG_PASSPHRASE');
  }
  return key;
}

// ─── Import du bundle ────────────────────────────────────────────────────────
export interface ImportResultEntry {
  name: string;
  last4: string;
  target: ImportTarget;
  mode: EncMode;
}
export interface ImportResult {
  imported: ImportResultEntry[];
  rejected: Array<{ name: string; reason: string }>;
  mode: EncMode;
  needsRestartNote: boolean;
  /** Type de fichier reconnu et diagnostic si rien n'a été trouvé. */
  source: 'text' | 'pdf';
  hint: string | null;
}

/**
 * Importe un fichier dans le coffre : .env / .txt, ou PDF formulaire rempli.
 * Le contenu reste en mémoire : aucune écriture disque, aucun log de valeur.
 */
export async function importBundle(
  payload: string | Uint8Array,
  opts: { passphrase?: string; updatedBy?: string } = {},
): Promise<ImportResult> {
  const decoded = decodeBundlePayload(payload);
  const entries = parseEnvBundle(decoded.content);
  const mode: EncMode = opts.passphrase ? 'sealed' : 'server';

  // Rien d'exploitable : on renvoie la raison précise plutôt qu'un import vide.
  if (!entries.length) {
    const { hint } = inspectBundle(payload);
    return {
      imported: [],
      rejected: [],
      mode,
      needsRestartNote: false,
      source: decoded.source,
      hint: hint ?? 'Aucune clé exploitable dans ce fichier.',
    };
  }

  let key: Buffer;
  if (mode === 'sealed') {
    if (!opts.passphrase || opts.passphrase.length < 12) {
      throw new Error('PASSPHRASE_TOO_SHORT');
    }
    key = await resolveSealedKey(opts.passphrase, opts.updatedBy);
    sealed.key = key;
    sealed.unlockedAt = Date.now();
  } else {
    key = serverKey();
  }

  const imported: ImportResultEntry[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const version = mode === 'sealed' ? 'v2' : 'v1';

  for (const entry of entries) {
    const { name, value } = entry;
    try {
      if ((MANAGED_KEYS as readonly string[]).includes(name)) {
        rejected.push({ name, reason: 'gérée par Runable — ignorée' });
        continue;
      }
      if ((GATEWAY_KEYS as readonly string[]).includes(name)) {
        rejected.push({ name, reason: 'gateway Runable — aucune clé IA nécessaire' });
        continue;
      }
      if (RESERVED_ROWS.includes(name)) {
        rejected.push({ name, reason: 'nom réservé au coffre' });
        continue;
      }
      if (value.length > 8000) {
        rejected.push({ name, reason: 'valeur trop longue' });
        continue;
      }

      // 1. Secret connu → table secret_store, chiffré.
      if ((KNOWN_SECRETS as readonly string[]).includes(name)) {
        const now = new Date();
        const enc = encryptWith(key, value, version);
        await db
          .insert(schema.secretStore)
          .values({ name, valueEnc: enc, last4: last4(value), updatedBy: opts.updatedBy || null, updatedAt: now })
          .onConflictDoUpdate({
            target: schema.secretStore.name,
            set: { valueEnc: enc, last4: last4(value), updatedBy: opts.updatedBy || null, updatedAt: now },
          });
        primeSecretCache(name, value);
        imported.push({ name, last4: last4(value), target: 'secret', mode });
        continue;
      }

      // 2. Clé lue via process.env → stockée chiffrée + injectée en mémoire.
      if ((ENV_ONLY_KEYS as readonly string[]).includes(name)) {
        const now = new Date();
        const enc = encryptWith(key, value, version);
        const rowName = `env::${name}`;
        await db
          .insert(schema.secretStore)
          .values({ name: rowName, valueEnc: enc, last4: last4(value), updatedBy: opts.updatedBy || null, updatedAt: now })
          .onConflictDoUpdate({
            target: schema.secretStore.name,
            set: { valueEnc: enc, last4: last4(value), updatedBy: opts.updatedBy || null, updatedAt: now },
          });
        process.env[name] = value;
        imported.push({ name, last4: last4(value), target: 'env', mode });
        continue;
      }

      rejected.push({ name, reason: 'clé inconnue du projet' });
    } catch (e) {
      // On ne met JAMAIS la valeur dans le message d'erreur.
      rejected.push({ name, reason: `échec d'écriture (${(e as Error).name})` });
    }
  }

  if (mode === 'server') wipe(key);

  return {
    imported,
    rejected,
    mode,
    needsRestartNote: mode === 'sealed',
    source: decoded.source,
    hint: imported.length ? null : 'Des clés ont été lues mais aucune n\'a pu être rangée : vois la liste des ignorées.',
  };
}

// ─── Unlock / lock du coffre scellé ──────────────────────────────────────────
export interface UnlockResult {
  restored: number;
  envRestored: number;
  failed: number;
}

/**
 * Réarme les clés scellées en mémoire après un redémarrage.
 * La phrase de passe n'est jamais stockée : elle sert uniquement à dériver la clé.
 */
export async function unlockVault(passphrase: string): Promise<UnlockResult> {
  const key = await resolveSealedKey(passphrase);
  const rows = await db
    .select()
    .from(schema.secretStore)
    .where(like(schema.secretStore.valueEnc, 'v2:%'));

  let restored = 0;
  let envRestored = 0;
  let failed = 0;
  for (const r of rows) {
    if (RESERVED_ROWS.includes(r.name)) continue;
    const plain = decryptWith(key, r.valueEnc);
    if (plain == null) {
      failed++;
      continue;
    }
    if (r.name.startsWith('env::')) {
      process.env[r.name.slice(5)] = plain;
      envRestored++;
    } else {
      primeSecretCache(r.name, plain);
      restored++;
    }
  }
  sealed.key = key;
  sealed.unlockedAt = Date.now();
  return { restored, envRestored, failed };
}

/** Verrouille : purge la clé et les valeurs scellées de la mémoire du process. */
export async function lockVault(): Promise<{ cleared: number }> {
  let cleared = 0;
  try {
    const rows = await db
      .select()
      .from(schema.secretStore)
      .where(like(schema.secretStore.valueEnc, 'v2:%'));
    for (const r of rows) {
      if (RESERVED_ROWS.includes(r.name)) continue;
      if (r.name.startsWith('env::')) delete process.env[r.name.slice(5)];
      else unprimeSecretCache(r.name);
      cleared++;
    }
  } catch {
    /* rien à purger */
  }
  wipe(sealed.key);
  sealed.key = null;
  sealed.unlockedAt = null;
  return { cleared };
}

/** Détruit définitivement tout le contenu importé (bouton panique). */
export async function wipeVault(): Promise<{ removed: number }> {
  const rows = await db.select().from(schema.secretStore);
  const names = rows.map((r) => r.name);
  for (const n of names) {
    if (n.startsWith('env::')) delete process.env[n.slice(5)];
    else unprimeSecretCache(n);
  }
  if (names.length) {
    await db.delete(schema.secretStore).where(inArray(schema.secretStore.name, names));
  }
  wipe(sealed.key);
  sealed.key = null;
  sealed.unlockedAt = null;
  return { removed: names.length };
}

/**
 * Au boot : réinjecte dans process.env les clés env:: chiffrées en mode serveur.
 * Les lignes scellées (v2) restent illisibles jusqu'au unlock.
 */
export async function restoreServerEnvKeys(): Promise<number> {
  try {
    const rows = await db.select().from(schema.secretStore);
    const key = serverKey();
    let n = 0;
    for (const r of rows) {
      if (!r.name.startsWith('env::') || !r.valueEnc.startsWith('v1:')) continue;
      const plain = decryptWith(key, r.valueEnc);
      if (plain != null) {
        process.env[r.name.slice(5)] = plain;
        n++;
      }
    }
    wipe(key);
    return n;
  } catch {
    return 0;
  }
}

// ─── Gabarit du fichier unique à remplir hors-ligne ─────────────────────────
// Généré côté serveur pour rester TOUJOURS synchronisé avec les listes ci-dessus.
// Il ne contient AUCUNE valeur : seulement les noms de clés et des commentaires.
const TEMPLATE_SECTIONS: Array<{ title: string; keys: string[] }> = [
  // Uniquement de VRAIES clés, chacune liée à une fonctionnalité. Les réglages
  // (URLs, flags, modèles, codes bêta, alias historiques) restent importables
  // mais ne figurent plus dans le gabarit : rien ne les réclame.
  // IA : volontairement absente (GATEWAY_KEYS).
  { title: 'Admin — e-mails admin en plus du défaut (optionnel, effet au redémarrage)', keys: ['ADMIN_EMAILS'] },
  { title: 'Stripe — paiements', keys: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  { title: 'Resend — e-mails', keys: ['RESEND_API_KEY', 'RESEND_FROM'] },
  { title: 'Printify — print-on-demand', keys: ['PRINTIFY_API_TOKEN', 'PRINTIFY_SHOP_ID'] },
  { title: 'Higgsfield — images & vidéos', keys: ['HF_API_KEY', 'HF_API_SECRET'] },
  { title: 'Replicate — upscale IA print-ready', keys: ['REPLICATE_API_TOKEN'] },
  { title: '21st.dev — composants du builder', keys: ['TWENTY_FIRST_API_KEY'] },
  { title: 'Firecrawl — scraping / clonage de sites', keys: ['FIRECRAWL_API_KEY'] },
  { title: 'OpenRouter — modèles non filtrés', keys: ['OPENROUTER_API_KEY'] },
  { title: 'GitHub — export de projets. GITHUB_TOKEN = jeton CLASSIQUE ghp_… avec la case « repo » (les jetons github_pat_ ne peuvent pas créer de dépôt)', keys: ['GITHUB_TOKEN', 'GITHUB_OWNER'] },
  { title: 'Sentry — surveillance & auto-réparation', keys: ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'] },
  { title: 'Google — connexion « Continuer avec Google »', keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
  { title: 'Bland.ai — appels IA + SMS (Growth Engine). BLAND_FROM obligatoire pour les SMS', keys: ['BLAND_API_KEY', 'BLAND_FROM'] },
  { title: 'Discord', keys: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'] },
  { title: 'Instagram', keys: ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET'] },
  { title: 'Reddit', keys: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'] },
  { title: 'Twitter / X', keys: ['TWITTER_CLIENT_ID', 'TWITTER_CLIENT_SECRET'] },
  { title: 'Google Ads — les clients connectent leur compte, l\'IA y crée des campagnes en pause. Client ID/Secret : vides = ceux de GOOGLE_CLIENT_ID/SECRET', keys: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'] },
  { title: 'Meta Ads (Facebook / Instagram) — les clients connectent leur compte, l\'IA y crée des campagnes en pause', keys: ['META_APP_ID', 'META_APP_SECRET'] },
  { title: 'Domaines — raccordement réel des domaines clients (Cloudflare for SaaS + Worker, voir API-KEYS)', keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID', 'VELBAZ_DOMAIN_TARGET', 'VELBAZ_EDGE_SECRET'] },
  { title: 'Namecheap — achat de domaine + DNS automatique', keys: ['NAMECHEAP_API_USER', 'NAMECHEAP_API_KEY', 'NAMECHEAP_USERNAME', 'NAMECHEAP_CLIENT_IP'] },
];

/** Construit le fichier unique à remplir : uniquement les noms, aucun texte. */
export function buildBundleTemplate(): string {
  const lines: string[] = [];
  for (const section of TEMPLATE_SECTIONS) {
    const keys = section.keys.filter((k) => !isOutOfScope(k));
    if (!keys.length) continue; // section entièrement hors périmètre : pas d'en-tête vide
    if (lines.length) lines.push('');
    lines.push(`# ${section.title}`);
    for (const k of keys) lines.push(`${k}=`);
  }
  return `${lines.join('\n')}\n`;
}

/** Inventaire write-only de toutes les clés importables (aucune valeur). */
export async function listImportableStatus(): Promise<
  Array<{ name: string; group: ImportTarget; isSet: boolean; last4: string | null; mode: EncMode | null }>
> {
  let rows: Array<{ name: string; valueEnc: string; last4: string | null }> = [];
  try {
    rows = await db.select().from(schema.secretStore);
  } catch {
    rows = [];
  }
  const byName = new Map(rows.map((r) => [r.name, r]));
  const out: Array<{ name: string; group: ImportTarget; isSet: boolean; last4: string | null; mode: EncMode | null }> = [];

  for (const name of KNOWN_SECRETS) {
    if (isOutOfScope(name)) continue;
    const row = byName.get(name);
    const envVal = process.env[name];
    out.push({
      name,
      group: 'secret',
      isSet: !!row || !!envVal,
      last4: row?.last4 ?? (envVal ? last4(envVal) : null),
      mode: row ? (row.valueEnc.startsWith('v2:') ? 'sealed' : 'server') : null,
    });
  }
  for (const name of ENV_ONLY_KEYS) {
    if (isOutOfScope(name)) continue;
    const row = byName.get(`env::${name}`);
    const envVal = process.env[name];
    out.push({
      name,
      group: 'env',
      isSet: !!row || !!envVal,
      last4: row?.last4 ?? (envVal ? last4(envVal) : null),
      mode: row ? (row.valueEnc.startsWith('v2:') ? 'sealed' : 'server') : null,
    });
  }
  // Les clés IA ne figurent pas dans le coffre d'import : tout passe par le
  // gateway Runable, il n'y a aucune clé de modèle à fournir.
  return out;
}
