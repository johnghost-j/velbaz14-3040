// Envoi de l'email « Ton projet est prêt » au créateur — UNE seule fois par projet.
// Appelé à la fin d'un build réussi (build-website ET build-app). Idempotent :
// une ligne `emails` (type 'creator_welcome') sert de verrou ; seul un envoi
// précédent RATÉ (clé Resend absente, domaine non vérifié…) peut être retenté.

import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../database/index";
import * as schema from "../database/schema";
import { sendEmailAuto } from "../email-provider";
import { detectFeatures, humanizePageName, pickEmailLang, renderProjectReadyEmail, summarizeReactPages } from "./project-ready";

const inFlight: Set<string> = ((globalThis as any).__velbaz_ready_mail ??= new Set<string>());

const HIDDEN_PAGE = /^(not ?found|404|app|layout|index ?layout)$/i;

export async function sendProjectReadyEmailOnce(companyId: string): Promise<void> {
  if (inFlight.has(companyId)) return;
  inFlight.add(companyId);
  try {
    const prior = await db.select({ id: schema.emails.id, status: schema.emails.status }).from(schema.emails)
      .where(and(eq(schema.emails.companyId, companyId), eq(schema.emails.type, "creator_welcome")))
      .all();
    if (prior.some(p => p.status === "sent" || p.status === "sending")) return;

    const company = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
    if (!company) return;
    // Projets créés automatiquement par Money Maker : pas un projet « fini » par l'utilisateur.
    if ((company as any).origin === "money_maker") return;
    const owner = await db.select().from(schema.users).where(eq(schema.users.id, company.userId)).get();
    if (!owner?.email) return;

    const lang = pickEmailLang(company.languages, `${company.idea || ""} ${company.description || ""}`);
    const base = (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || "https://velbaz.com").replace(/\/$/, "");

    // Pages réellement construites. Projet React : les fichiers src/pages/* sont
    // la vérité (website_pages peut contenir de vieilles lignes d'un ancien
    // générateur). Sinon : website_pages.
    const fileRows = await db.select({ filePath: schema.projectFiles.filePath })
      .from(schema.projectFiles).where(eq(schema.projectFiles.companyId, companyId)).all().catch(() => []);
    const paths = fileRows.map(f => f.filePath);
    const reactPages = paths.filter(p => /^src\/pages\/[^/]+\.(tsx|jsx)$/.test(p));
    let pages: string[];
    if (reactPages.length) {
      pages = summarizeReactPages(reactPages, lang);
    } else {
      const pageRows = await db.select({ title: schema.websitePages.title, slug: schema.websitePages.slug, sortOrder: schema.websitePages.sortOrder })
        .from(schema.websitePages).where(eq(schema.websitePages.companyId, companyId)).all().catch(() => []);
      pages = [...pageRows]
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
        .map(p => (p.title || humanizePageName(p.slug)).trim())
        .filter(p => p && !HIDDEN_PAGE.test(p));
    }

    const liveUrl = company.published
      ? (company.customDomain && company.customDomainStatus === "live"
          ? `https://${company.customDomain}`
          : company.subdomain ? `${base}/api/s/${company.subdomain}` : null)
      : null;

    const mail = renderProjectReadyEmail({
      projectName: company.name,
      ownerName: owner.name,
      description: company.description,
      projectUrl: `${base}/chat/${companyId}`,
      liveUrl,
      pages,
      // « Pages légales » déjà listé dans les pages → pas de chip en double.
      features: detectFeatures(paths, lang).filter(f => !(/^(Pages légales|Legal pages)$/.test(f) && pages.some(p => /^(Pages légales|Legal pages)/.test(p)))),
      projectType: company.projectType,
      lang,
      baseUrl: base,
    });

    // Verrou AVANT l'envoi : un 2e appel concurrent (autre process) voit 'sending'.
    const rowId = prior[0]?.id || uuidv4();
    if (prior[0]) {
      await db.update(schema.emails).set({ status: "sending", subject: mail.subject, body: mail.html })
        .where(eq(schema.emails.id, rowId)).catch(() => {});
    } else {
      await db.insert(schema.emails).values({
        id: rowId, companyId, type: "creator_welcome", subject: mail.subject, body: mail.html,
        recipientEmail: owner.email, recipientName: owner.name || null,
        status: "sending", generatedBy: "build_completed",
      }).catch(() => {});
    }

    const res = await sendEmailAuto({ to: owner.email, subject: mail.subject, html: mail.html, text: mail.text })
      .catch((e: any) => ({ ok: false, error: e?.message || String(e) }));
    await db.update(schema.emails).set({ status: res.ok ? "sent" : "not_sent" })
      .where(eq(schema.emails.id, rowId)).catch(() => {});
    if (!res.ok) console.warn(`[project-ready-email] non envoyé pour ${companyId}: ${(res as any).error || "inconnu"}`);
  } catch (e: any) {
    console.error("[project-ready-email] échec:", e?.message || e);
  } finally {
    inFlight.delete(companyId);
  }
}
