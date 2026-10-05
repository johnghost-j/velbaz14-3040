/**
 * Autorisation des routes /companies/:id/* — utilitaires partagés.
 *
 * Les gardes elles-mêmes (requireCompanyOwner / requireCompanyAccess) vivent
 * dans index.ts, à côté de getUser. Ici : ce qui ne dépend pas de la requête.
 */

/**
 * Champs qu'un client ne doit JAMAIS pouvoir fixer en créant/modifiant une
 * ligne rattachée à un projet : l'identifiant de la ligne et son rattachement.
 * Sans ce filtre, `{ ...body }` permettait d'écrire dans le projet d'un autre
 * (`companyId` du corps prioritaire sur celui de l'URL) ou d'écraser une ligne
 * existante (`id`).
 */
const TENANT_FIELDS = new Set(['id', 'companyId', 'company_id', 'userId', 'user_id']);

export function stripTenantFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!TENANT_FIELDS.has(k)) out[k] = v;
  }
  return out;
}
