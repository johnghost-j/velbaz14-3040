// ─── Suppression complète d'un projet (company) ──────────────────────────────
// [2026-10-04] Partagé par DELETE /companies/:id et DELETE /admin/companies/:id.
// Avant, chaque route avait sa propre liste de tables, incomplète et mal
// ordonnée. Les FK vers companies n'ont pas de cascade, donc :
//   - tout projet ayant lancé un build (lignes build_journal) ne pouvait plus
//     être supprimé (500 FOREIGN KEY constraint failed) ;
//   - la route admin oubliait toutes les tables ajoutées après coup ;
//   - products était vidé avant order_items / product_drafts, autopilot_plans
//     avant autopilot_tasks, customers avant deals, marketplace_listings avant
//     marketplace_orders : échec FK dès qu'un projet avait ces données.
// Ordre ci-dessous : ENFANTS avant PARENTS, vérifié contre
// `pragma foreign_key_list` de la base le 2026-10-04.

import { eq, inArray } from 'drizzle-orm';
import { db } from './database/index';
import * as schema from './database/schema';

const COMPANY_TABLES_IN_DELETE_ORDER = [
  // commerce : order_items → orders/products ; drafts/images → products ; products → suppliers
  schema.orderItems, schema.productDrafts, schema.productImages,
  schema.orders, schema.printifyOrders,
  schema.marketplaceListings, // ses commandes sont traitées avant la boucle (pas de companyId)
  schema.products, schema.suppliers, schema.shippingConfig,
  // CRM : deals → customers ; outreach → leads
  schema.deals, schema.customers,
  schema.outreach, schema.leads,
  // budget : company_budget_events → money_requests
  schema.companyBudgetEvents, schema.moneyRequests,
  // autopilot : insights/logs → tasks → plans
  schema.autopilotInsights, schema.autopilotLogs, schema.autopilotTasks, schema.autopilotPlans, schema.autopilotConfig,
  // social : content_calendar / interactions → social_posts
  schema.contentCalendar, schema.socialInteractions, schema.socialPosts, schema.socialConnections, schema.communityChannels,
  // reste (aucune FK entre elles, hormis agent_id → agents, vidée en dernier)
  schema.websitePages, schema.agentActivity, schema.agentMemory, schema.agentSkills,
  schema.tasks, schema.documents, schema.dailyReports,
  schema.emails, schema.emailsInbox, schema.emailConfig,
  schema.ads, schema.revenueEvents, schema.browserTasks, schema.seoContent, schema.designAssets,
  schema.executionState, schema.agentActions, schema.agentMessages, schema.aiPipelineLogs,
  schema.projectFileVersions, schema.projectFiles,
  schema.companySecrets, schema.sourcingResults,
  schema.buildJournal, schema.projectCheckpoints, schema.higgsfieldJobs, schema.growthConfig,
  schema.aiCalendarEvents, schema.tradingOrders, schema.tradingPortfolios,
  // agents en dernier : ads, agent_activity, agent_memory, agent_skills,
  // browser_tasks, documents, emails, seo_content, tasks y font référence.
  schema.agents,
] as const;

export async function deleteCompanyData(companyId: string): Promise<void> {
  // marketplace_orders n'a pas de company_id :
  //  - commandes REÇUES sur les annonces de ce projet → supprimées (sinon
  //    marketplace_listings ne peut pas être vidée) ;
  //  - commandes PASSÉES par ce projet chez un autre vendeur → l'acheteur est
  //    détaché (NULL) : la vente reste dans l'historique du vendeur.
  const listingIds = (await db.select({ id: schema.marketplaceListings.id }).from(schema.marketplaceListings)
    .where(eq(schema.marketplaceListings.companyId, companyId)).all()).map((r) => r.id);
  if (listingIds.length) {
    await db.delete(schema.marketplaceOrders).where(inArray(schema.marketplaceOrders.listingId, listingIds));
  }
  await db.update(schema.marketplaceOrders).set({ buyerCompanyId: null })
    .where(eq(schema.marketplaceOrders.buyerCompanyId, companyId));
  for (const t of COMPANY_TABLES_IN_DELETE_ORDER) {
    // Pas de try/catch : une table qui bloque doit faire échouer la suppression
    // avec SA vraie erreur, pas un FK générique sur companies plus loin.
    await db.delete(t as any).where(eq((t as any).companyId, companyId));
  }
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
}
