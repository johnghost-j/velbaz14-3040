// Chargement DB de l'expéditeur d'un site (séparé de email-sender.ts, qui reste
// pur et importable par email-provider sans tirer la base de données).
import { eq } from 'drizzle-orm';
import { db } from './database/index';
import * as schema from './database/schema';
import { buildSiteSender, type SiteSender, type SiteSenderCompany } from './email-sender';

/** Charge la config email + l'email du propriétaire et calcule l'expéditeur du site. */
export async function loadSiteSender(companyOrId: string | (SiteSenderCompany & { id: string; userId?: string | null })): Promise<SiteSender | null> {
  const company = typeof companyOrId === 'string'
    ? await db.select().from(schema.companies).where(eq(schema.companies.id, companyOrId)).get().catch(() => undefined)
    : companyOrId;
  if (!company) return null;
  const cfg = await db.select().from(schema.emailConfig)
    .where(eq(schema.emailConfig.companyId, company.id)).get().catch(() => undefined);
  const owner = company.userId
    ? await db.select({ email: schema.users.email }).from(schema.users)
      .where(eq(schema.users.id, company.userId)).get().catch(() => undefined)
    : undefined;
  return buildSiteSender(company, cfg, owner?.email);
}
