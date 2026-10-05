// Envoi de la confirmation de commande + reçu à l'ACHETEUR — UNE seule fois
// par commande. Appelé dès qu'une commande est créée depuis une session Stripe
// payée (webhook, page de succès, réconciliation : quel que soit le premier).
// Idempotent : une ligne `emails` d'id fixe `ordconf-<orderId>` sert de verrou ;
// seul un envoi précédent RATÉ (status 'not_sent') peut être retenté.

import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../database/index";
import * as schema from "../database/schema";
import { sendCustomerEmail, explainEmailFailure, type SendEmailInput, type SendEmailResult } from "../email-provider";
import { pickEmailLang } from "./project-ready";
import { renderOrderConfirmationEmail } from "./order-confirmation";
import { buildSiteSender } from "../email-sender";

const inFlight: Set<string> = ((globalThis as any).__velbaz_order_mail ??= new Set<string>());

export function orderConfirmationRowId(orderId: string): string {
  return `ordconf-${orderId}`;
}

function orderRef(orderId: string): string {
  return "CMD-" + String(orderId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
}

/** URL publique du site (domaine perso > sous-domaine publié > aperçu). */
export function publicSiteUrl(company: any, base: string): string {
  const b = base.replace(/\/+$/, "");
  if (company?.published && company?.customDomain && company?.customDomainStatus === "live") return `https://${company.customDomain}`;
  if (company?.published && company?.subdomain) return `${b}/s/${company.subdomain}`;
  return `${b}/api/companies/${encodeURIComponent(company?.id || "")}/preview/`;
}

export type OrderMailResult = { sent: boolean; skipped?: "in_flight" | "already_sent" | "no_order" | "no_email"; error?: string };

export async function sendOrderConfirmationOnce(
  companyId: string,
  orderId: string,
  opts: { receiptUrl?: string | null; send?: (input: SendEmailInput) => Promise<SendEmailResult> } = {},
): Promise<OrderMailResult> {
  const key = `${companyId}:${orderId}`;
  if (inFlight.has(key)) return { sent: false, skipped: "in_flight" };
  inFlight.add(key);
  const rowId = orderConfirmationRowId(orderId);
  try {
    const order = await db.select().from(schema.orders)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.companyId, companyId))).get();
    if (!order) return { sent: false, skipped: "no_order" };
    const to = String(order.customerEmail || "").trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { sent: false, skipped: "no_email" };

    const prior = await db.select({ id: schema.emails.id, status: schema.emails.status }).from(schema.emails)
      .where(eq(schema.emails.id, rowId)).get();
    if (prior && (prior.status === "sent" || prior.status === "sending")) return { sent: false, skipped: "already_sent" };

    const company = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
    const owner = company ? await db.select().from(schema.users).where(eq(schema.users.id, company.userId)).get() : null;
    const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)).all().catch(() => []);
    let shipping: any = null;
    try { shipping = order.shippingAddress ? JSON.parse(order.shippingAddress) : null; } catch { shipping = null; }

    const base = (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || "https://velbaz.com");
    const lang = pickEmailLang(company?.languages, `${company?.description || ""} ${company?.idea || ""}`);
    const mail = renderOrderConfirmationEmail({
      shopName: company?.name || "",
      orderRef: orderRef(orderId),
      date: order.createdAt instanceof Date ? order.createdAt : new Date(),
      customerName: order.customerName,
      customerEmail: to,
      items: items.map((it: any) => ({ name: it.name, quantity: it.quantity, unitPrice: it.unitPrice, variantLabel: it.variantLabel })),
      total: order.amountTotal ?? null,
      currency: order.currency || "EUR",
      shipping,
      receiptUrl: opts.receiptUrl || null,
      siteUrl: company ? publicSiteUrl(company, base) : null,
      brandColor: (company as any)?.brandColor || null,
      lang,
    });

    // Verrou AVANT l'envoi : un 2e appel concurrent (autre process) voit 'sending'.
    if (prior) {
      await db.update(schema.emails).set({ status: "sending", subject: mail.subject, body: mail.html })
        .where(eq(schema.emails.id, rowId));
    } else {
      const ins = await db.insert(schema.emails).values({
        id: rowId, companyId, type: "order_confirmation", subject: mail.subject, body: mail.html,
        recipientEmail: to, recipientName: order.customerName || null,
        status: "sending", generatedBy: "order_paid",
      }).onConflictDoNothing();
      const inserted = Number((ins as any)?.rowsAffected ?? (ins as any)?.changes ?? 1) > 0;
      if (!inserted) return { sent: false, skipped: "already_sent" };
    }

    const send = opts.send || sendCustomerEmail;
    // Expéditeur = la BOUTIQUE (nom + adresse configurée), jamais « Velbaz ».
    const emailCfg = company
      ? await db.select().from(schema.emailConfig).where(eq(schema.emailConfig.companyId, company.id)).get().catch(() => undefined)
      : undefined;
    const sender = company ? buildSiteSender(company, emailCfg, owner?.email) : null;
    const res = await send({
      to, subject: mail.subject, html: mail.html, text: mail.text,
      from: sender?.from,
      // L'acheteur répond au VENDEUR, jamais à une adresse no-reply.
      replyTo: sender?.replyTo || owner?.email || undefined,
    }).catch((e: any) => ({ ok: false, error: e?.message || String(e) } as SendEmailResult));

    await db.update(schema.emails).set({ status: res.ok ? "sent" : "not_sent" }).where(eq(schema.emails.id, rowId)).catch(() => {});
    await db.insert(schema.agentActivity).values({
      id: uuidv4(), companyId, agentRole: "operations", action: res.ok ? "completed" : "blocked",
      message: res.ok
        ? `📧 Confirmation de commande + reçu envoyés à ${to} (${orderRef(orderId)})`
        : `⚠️ Confirmation de commande NON envoyée à ${to} (${orderRef(orderId)}) : ${explainEmailFailure(res.error)}`,
    }).catch(() => {});
    if (!res.ok) console.warn(`[order-email] ${companyId}/${orderId} non envoyé : ${res.error || "inconnu"}`);
    return res.ok ? { sent: true } : { sent: false, error: res.error || "send_failed" };
  } catch (e: any) {
    console.error("[order-email] échec:", e?.message || e);
    await db.update(schema.emails).set({ status: "not_sent" }).where(and(eq(schema.emails.id, rowId), eq(schema.emails.status, "sending"))).catch(() => {});
    return { sent: false, error: String(e?.message || e) };
  } finally {
    inFlight.delete(key);
  }
}

// Les synchros rejouent 30 jours de sessions : on n'envoie la confirmation
// qu'aux paiements récents (< 24 h), jamais aux anciens clients.
const ORDER_EMAIL_MAX_AGE_S = 24 * 3600;
export function isRecentCheckout(session: any, created: boolean, nowS = Math.floor(Date.now() / 1000)): boolean {
  const t = Number(session?.created);
  if (Number.isFinite(t) && t > 0) return nowS - t <= ORDER_EMAIL_MAX_AGE_S && t <= nowS + 600;
  return created === true;
}
