// ─── Résolution de la config Printify (source unique de vérité) ──────────────
//
// Printify est le fournisseur d'impression à la demande RÉEL : chaque produit
// créé part vraiment en production et est vraiment vendu. Il n'y a donc jamais
// de mode "démo" ici — sans clé qui fonctionne, on ne crée rien.
//
// Une clé peut venir de trois endroits, dans cet ordre de priorité :
//
//   1. Secrets de l'ENTREPRISE (`company_secrets`, saisis via le pop-up
//      "secret" du chat IA). Priorité maximale : une entreprise qui a son
//      propre compte Printify vend sur SON compte.
//   2. Secret GLOBAL de l'instance (`secret_store`, saisi dans l'Admin Panel,
//      chiffré AES-256-GCM). C'est le compte Printify de l'exploitant Velbaz :
//      il alimente toutes les entreprises qui n'ont pas leur propre clé.
//   3. Variable d'environnement (`PRINTIFY_API_TOKEN`…), pratique en dev/CI.
//      `getSecret()` gère déjà ce repli.
//
// Conséquence voulue : il suffit de renseigner UNE fois le token dans l'Admin
// Panel pour que la création de produits réels marche sur toute l'instance,
// sans devoir le re-saisir dans chaque chat.
//
import { db } from './database/index';
import * as schema from './database/schema';
import { eq } from 'drizzle-orm';
import { getSecret } from './secret-store';
import type { PrintifyConfig } from './printify';

/** Clés Printify reconnues (mêmes noms côté entreprise, admin et env). */
export const PRINTIFY_SECRET_KEYS = ['PRINTIFY_API_TOKEN', 'PRINTIFY_SHOP_ID', 'PRINTIFY_BASE_URL'] as const;

export type PrintifyConfigSource = 'company' | 'global' | 'none';

export interface ResolvedPrintifyConfig extends PrintifyConfig {
  /** D'où vient le token réellement utilisé (pour l'affichage / le debug). */
  source: Exclude<PrintifyConfigSource, 'none'>;
}

/** Secrets d'une entreprise sous forme de map clé -> valeur. */
export async function companySecretMap(companyId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: schema.companySecrets.key, value: schema.companySecrets.value })
    .from(schema.companySecrets)
    .where(eq(schema.companySecrets.companyId, companyId));
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

/**
 * Construit la config Printify d'une entreprise, ou `null` si aucun token
 * n'est disponible (ni côté entreprise, ni côté instance, ni env).
 *
 * `secrets` : map déjà chargée des secrets de l'entreprise (évite une requête
 * quand l'appelant l'a sous la main).
 */
export function printifyConfigFromSecrets(secrets: Record<string, string>): ResolvedPrintifyConfig | null {
  const companyToken = (secrets['PRINTIFY_API_TOKEN'] || '').trim();
  if (companyToken) {
    return {
      apiToken: companyToken,
      shopId: (secrets['PRINTIFY_SHOP_ID'] || '').trim() || undefined,
      baseUrl: (secrets['PRINTIFY_BASE_URL'] || '').trim() || undefined,
      source: 'company',
    };
  }
  // Repli instance : secret store chiffré (Admin Panel) puis process.env.
  const globalToken = (getSecret('PRINTIFY_API_TOKEN') || '').trim();
  if (!globalToken) return null;
  return {
    apiToken: globalToken,
    // Le shop peut venir de l'entreprise même si le token est global (ex. un
    // compte Printify avec plusieurs boutiques, une par entreprise).
    shopId:
      (secrets['PRINTIFY_SHOP_ID'] || '').trim() ||
      (getSecret('PRINTIFY_SHOP_ID') || '').trim() ||
      undefined,
    baseUrl:
      (secrets['PRINTIFY_BASE_URL'] || '').trim() ||
      (getSecret('PRINTIFY_BASE_URL') || '').trim() ||
      undefined,
    source: 'global',
  };
}

/** Idem, mais charge les secrets de l'entreprise depuis la base. */
export async function resolvePrintifyConfig(companyId: string): Promise<ResolvedPrintifyConfig | null> {
  return printifyConfigFromSecrets(await companySecretMap(companyId));
}

/** Vrai si un token Printify est disponible pour cette entreprise. */
export async function hasPrintifyToken(companyId: string): Promise<boolean> {
  return (await resolvePrintifyConfig(companyId)) != null;
}
