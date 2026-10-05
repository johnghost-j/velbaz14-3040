// ─── Moteur de fulfillment dropshipping ──────────────────────────────────────
// Commande client [PAYÉE] → commande fournisseur :
//   - produits CJ  → createOrder API (payée par le SOLDE CJ) → [ENVOYÉE FOURNISSEUR]
//   - AliExpress / services → [À TRAITER] (semi-auto, dashboard)
// Garde-fous full-auto (JAMAIS d'échec silencieux) :
//   - dry-run : CJ_DRY_RUN=1 (secret) ou opts.dryRun → simulation, zéro dépense
//   - plafond de dépense/jour : CJ_DAILY_CAP_USD (défaut 50 $)
//   - vérification du solde CJ avant chaque commande
//   - échec → statut [ERREUR: raison] + activité + relance possible (bouton Réessayer)
// Suivi : syncTracking → numéro de suivi → e-mail client → [LIVRÉE].

import { db } from "../database/index";
import * as schema from "../database/schema";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import * as cj from "./cj";
import * as printify from "../printify";
import { printifyConfigFromSecrets } from "../printify-config";
import { sendEmail } from "../email-provider";
import { loadSiteSender } from "../email-sender-load";
import { isSelfFulfillment, startSelfFulfillment } from "./self-fulfillment";


// Expéditeur = la boutique (nom/adresse du site), jamais « Velbaz ».
async function siteFromFields(companyId: string): Promise<{ from?: string; replyTo?: string }> {
  const s = await loadSiteSender(companyId).catch(() => null);
  return s ? { from: s.from, replyTo: s.replyTo } : {};
}
// ── Helpers statut (texte, auditable, sans couleur) ──
async function setStatus(orderId: string, status: string, detail: string, extra?: Partial<typeof schema.orders.$inferInsert>) {
  const row = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  let log: any[] = [];
  try { log = JSON.parse(row?.statusLog || "[]"); } catch { /* journal illisible → on repart */ }
  log.push({ at: new Date().toISOString(), status, detail });
  await db.update(schema.orders).set({
    status, statusLog: JSON.stringify(log),
    errorDetail: status.startsWith("[ERREUR") ? detail : null,
    updatedAt: new Date(), ...extra,
  }).where(eq(schema.orders.id, orderId));
}

async function logActivity(companyId: string, message: string) {
  await db.insert(schema.agentActivity).values({ id: uuidv4(), companyId, agentRole: "operations", action: "completed", message });
}

async function secretMap(companyId: string): Promise<Record<string, string>> {
  const rows = await db.select({ key: schema.companySecrets.key, value: schema.companySecrets.value })
    .from(schema.companySecrets).where(eq(schema.companySecrets.companyId, companyId));
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = r.value;
  return m;
}

function cjConfigFrom(s: Record<string, string>): cj.CjConfig | null {
  return s["CJ_EMAIL"] && s["CJ_API_KEY"] ? { email: s["CJ_EMAIL"], apiKey: s["CJ_API_KEY"] } : null;
}

// Secrets entreprise → secret store global (Admin Panel) → env.
// Cf. printify-config.ts : le token global suffit à faire partir de VRAIES
// commandes en production pour toutes les entreprises de l'instance.
function printifyConfigFrom(s: Record<string, string>): printify.PrintifyConfig | null {
  return printifyConfigFromSecrets(s);
}

// Convertit une adresse Velbaz ({name,line1,...}) en adresse Printify.
function toPrintifyAddress(addr: any, order: any): printify.PrintifyAddress {
  const fullName = String(addr?.name || order?.customerName || "Client").trim();
  const parts = fullName.split(/\s+/);
  const firstName = parts.slice(0, -1).join(" ") || parts[0] || "Client";
  const lastName = parts.length > 1 ? parts[parts.length - 1] : "-";
  return {
    first_name: firstName,
    last_name: lastName,
    email: order?.customerEmail || addr?.email || undefined,
    phone: String(addr?.phone || "0000000000"),
    country: String(addr?.country || "US"),
    region: String(addr?.state || addr?.city || ""),
    address1: String(addr?.line1 || ""),
    address2: addr?.line2 ? String(addr.line2) : undefined,
    city: String(addr?.city || ""),
    zip: String(addr?.zip || ""),
  };
}

// ── Fulfillment Printify (print-on-demand) ──
// Commande client [PAYÉE] → commande Printify (Printify fabrique + expédie).
// Le coût de production est débité du moyen de paiement du compte Printify
// dont le token est utilisé (compte Velbaz si token global) au moment où la
// commande passe en production.

/** Coût réel facturé par Printify (production + port + taxe), en USD. Pur. */
export function printifyBilledUsd(d: any): number | null {
  const tp = Number(d?.total_price); const ts = Number(d?.total_shipping); const tt = Number(d?.total_tax);
  if (!Number.isFinite(tp) || tp <= 0) return null;
  return Number(((tp + (Number.isFinite(ts) ? ts : 0) + (Number.isFinite(tt) ? tt : 0)) / 100).toFixed(2));
}

// Enregistre le coût RÉEL Printify (converti en EUR) sur la commande + marge.
async function applyPrintifyCost(order: any, d: any): Promise<void> {
  const usd = printifyBilledUsd(d);
  if (usd == null) return;
  const cur = String(order.currency || "EUR").toUpperCase();
  let cost = usd;
  if (cur === "EUR") {
    const rate = await import("../smart-pricing-service").then((m) => m.usdToEur()).then((r) => r.rate).catch(() => 1);
    cost = Number((usd * rate).toFixed(2));
  }
  if (order.supplierCost != null && Math.abs(Number(order.supplierCost) - cost) < 0.01) return;
  await db.update(schema.orders).set({
    supplierCost: cost,
    marginAmount: order.amountTotal != null ? Number((order.amountTotal - cost).toFixed(2)) : null,
    updatedAt: new Date(),
  }).where(eq(schema.orders.id, order.id)).catch(() => { /* audit best-effort */ });
}

// Une commande Printify reste « on-hold » tant que Printify ne l'a pas payée
// et lancée en production. Au-delà de ce délai → alerte (une seule fois).
const ON_HOLD_ALERT_MS = 26 * 3600 * 1000;
export function printifyOnHoldTooLong(d: any, now = Date.now()): boolean {
  if (String(d?.status || "").toLowerCase() !== "on-hold") return false;
  let raw = String(d?.created_at || "").trim().replace(" ", "T");
  if (raw && !/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) raw += "Z"; // Printify = UTC
  const created = Date.parse(raw);
  return Number.isFinite(created) && now - created > ON_HOLD_ALERT_MS;
}

async function fulfillPrintify(
  companyId: string,
  order: any,
  items: any[],
  cfg: printify.PrintifyConfig,
): Promise<FulfillResult> {
  const shopId = await printify.resolveShopId(cfg);
  if (!shopId) {
    await setStatus(order.id, "[ERREUR]", "Atelier de fabrication indisponible");
    await logActivity(companyId, `✗ [ERREUR] Commande ${order.id.slice(0, 8)} : atelier de fabrication indisponible`);
    return { ok: false, status: "[ERREUR]", detail: "Atelier de fabrication indisponible" };
  }
  cfg = { ...cfg, shopId };

  // Adresse de livraison obligatoire.
  let addr: any = null;
  try { addr = JSON.parse(order.shippingAddress || "null"); } catch { /* illisible */ }
  if (!addr?.line1 || !addr?.city || !addr?.country) {
    await setStatus(order.id, "[ERREUR]", "Adresse de livraison incomplète (line1/ville/pays manquant)");
    await logActivity(companyId, `✗ [ERREUR] Commande ${order.id.slice(0, 8)} : adresse de livraison incomplète`);
    return { ok: false, status: "[ERREUR]", detail: "Adresse incomplète" };
  }

  // Construction des line_items Printify depuis les produits liés.
  const lineItems: printify.PrintifyLineItem[] = [];
  for (const it of items) {
    if (!it.productId) continue;
    const product = await db.select().from(schema.products).where(eq(schema.products.id, it.productId)).get();
    if (!product?.printifyProductId) continue;
    // Variante : UNIQUEMENT celle réellement choisie par le client au checkout
    // (commerce-guard.ts la valide et la fige dans supplierVariantId — jamais
    // devinée ici). Un produit à variante unique est déjà auto-résolu par le
    // garde-fou de checkout, donc supplierVariantId est toujours renseigné pour
    // tout produit Printify vendable. Si elle manque ou n'appartient pas au
    // produit, on refuse la commande plutôt que d'envoyer au hasard une autre
    // taille/couleur que celle payée par le client.
    const variantId = Number(it.supplierVariantId);
    let knownVids: Set<string> = new Set();
    try {
      const vs = JSON.parse(product.variants || "[]");
      if (Array.isArray(vs)) for (const v of vs) if (v?.vid != null) knownVids.add(String(v.vid));
    } catch { /* variantes illisibles */ }
    if (!Number.isFinite(variantId) || variantId <= 0 || (knownVids.size > 0 && !knownVids.has(String(variantId)))) {
      await setStatus(
        order.id, "[ERREUR]",
        `Variante de fabrication manquante ou invalide pour "${product.name}" (supplierVariantId=${it.supplierVariantId ?? "null"}) — commande NON envoyée pour éviter d'expédier la mauvaise taille/couleur.`,
      );
      await logActivity(companyId, `✗ [ERREUR] Commande ${order.id.slice(0, 8)} : variante de fabrication invalide pour "${product.name}", envoi bloqué (jamais de personnalisation devinée)`);
      return { ok: false, status: "[ERREUR]", detail: "Variante de fabrication invalide" };
    }
    lineItems.push({
      product_id: String(product.printifyProductId),
      variant_id: variantId,
      quantity: it.quantity || 1,
    });
  }

  if (!lineItems.length) {
    await setStatus(order.id, "[ERREUR]", "Aucun produit fabricable valide dans la commande (produit non créé ou variante manquante)");
    await logActivity(companyId, `✗ [ERREUR] Commande ${order.id.slice(0, 8)} : aucun produit fabricable valide — relance le build pour recréer les produits`);
    return { ok: false, status: "[ERREUR]", detail: "Aucun produit fabricable valide" };
  }

  const orderReq: printify.PrintifyOrderRequest = {
    external_id: order.id,
    label: `Velbaz ${order.id.slice(0, 8)}`,
    line_items: lineItems,
    shipping_method: 1,
    send_shipping_notification: true,
    address_to: toPrintifyAddress(addr, order),
  };
  const res = await printify.submitOrder(cfg, orderReq);
  if (!res.ok) {
    const d = `L'atelier de fabrication a refusé la commande`;
    await setStatus(order.id, "[ERREUR]", d);
    await logActivity(companyId, `✗ [ERREUR] Commande ${order.id.slice(0, 8)} : ${d} — clique Réessayer après correction`);
    return { ok: false, status: "[ERREUR]", detail: d };
  }
  const printifyOrderId = String((res.data as any)?.id || "");

  // Enregistre le suivi Printify dans printifyOrders.
  await db.insert(schema.printifyOrders).values({
    id: uuidv4(), companyId, referenceId: order.id,
    printifyOrderId: printifyOrderId || null,
    status: "submitted",
    customerEmail: order.customerEmail || null,
    payload: JSON.stringify(orderReq),
    lastEvent: JSON.stringify({ response: res.data }),
  }).catch(() => { /* table optionnelle */ });

  // Envoi en production : c'est LÀ que Printify débite son moyen de paiement
  // et lance la fabrication. Un refus n'est plus avalé : il est journalisé.
  let productionNote = "";
  if (printifyOrderId) {
    const prod = await printify.sendOrderToProduction(cfg, printifyOrderId)
      .catch((e: any) => ({ ok: false, status: 0, data: null, message: String(e?.message || e) }) as printify.PrintifyResult);
    if (!prod.ok) {
      productionNote = ` ⚠ Mise en fabrication pas encore lancée — la commande reste en attente côté atelier.`;
      console.error(`[printify] send_to_production ${printifyOrderId}:`, prod.status, prod.message);
      await logActivity(companyId, `⚠ Commande ${order.id.slice(0, 8)} : transmise à l'atelier mais PAS encore lancée en fabrication.`);
    }
    // Coût réel facturé par Printify → commande (marge exacte).
    const det = await printify.getOrder(cfg, printifyOrderId).catch(() => null);
    if (det?.ok && det.data) await applyPrintifyCost(order, det.data);
  }

  await setStatus(order.id, "[ENVOYÉE FOURNISSEUR]", `Commande de fabrication ${printifyOrderId || "(id?)"} créée — fabrication et expédition automatiques.${productionNote}`, {
    supplierOrderId: printifyOrderId || `PRINTIFY-${order.id.slice(0, 8)}`,
    // Marque explicite : indispensable pour que syncTracking interroge Printify
    // (et non CJ) au moment de récupérer le numéro de suivi.
    supplierPlatform: "printify",
    fulfillmentMode: order.fulfillmentMode || "printify",
  });
  await logActivity(companyId, `✓ [ENVOYÉE FOURNISSEUR] Commande ${order.id.slice(0, 8)} → atelier (fabrication + expédition automatiques)`);
  return { ok: true, status: "[ENVOYÉE FOURNISSEUR]", detail: `Fabrication ${printifyOrderId}`, supplierOrderId: printifyOrderId };
}

// Dépense fournisseur du jour (commandes auto réelles, hors dry-run).
async function spentTodayUsd(companyId: string): Promise<number> {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const rows = await db.select().from(schema.orders).where(and(
    eq(schema.orders.companyId, companyId),
    isNotNull(schema.orders.supplierOrderId),
    eq(schema.orders.dryRun, 0),
    gte(schema.orders.createdAt, midnight),
  ));
  return rows.reduce((sum, o) => sum + (o.supplierCost || 0), 0);
}

export interface FulfillResult { ok: boolean; status: string; detail: string; supplierOrderId?: string; dryRun?: boolean; }

// ── Fulfillment d'une commande [PAYÉE] ──
export async function fulfillOrder(companyId: string, orderId: string, opts?: { dryRun?: boolean }): Promise<FulfillResult> {
  const order = await db.select().from(schema.orders)
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.companyId, companyId))).get();
  if (!order) return { ok: false, status: "[ERREUR]", detail: "Commande introuvable" };
  if (order.supplierOrderId) return { ok: true, status: order.status, detail: "Déjà envoyée au fournisseur (idempotent)" , supplierOrderId: order.supplierOrderId };
  if (!order.status.startsWith("[PAYÉE]") && !order.status.startsWith("[ERREUR")) {
    return { ok: false, status: order.status, detail: `Statut actuel ${order.status} — seule une commande [PAYÉE] ou [ERREUR] (relance) peut partir au fournisseur` };
  }
  const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId));
  const cjItems = items.filter((i) => i.supplierProductId && i.supplierVariantId);

  // ── Print-on-demand Printify ──
  // Prioritaire : si la commande contient des produits liés à Printify, on
  // envoie la commande à Printify (fabrication + expédition automatiques).
  {
    const secretsPod = await secretMap(companyId);
    const podCfg = printifyConfigFrom(secretsPod);
    let hasPrintifyItem = order.fulfillmentMode === "printify" || order.supplierPlatform === "printify";
    if (!hasPrintifyItem) {
      for (const it of items) {
        if (!it.productId) continue;
        const prod = await db.select().from(schema.products).where(eq(schema.products.id, it.productId)).get();
        if (prod?.printifyProductId) { hasPrintifyItem = true; break; }
      }
    }
    if (hasPrintifyItem) {
      if (!podCfg) {
        await setStatus(orderId, "[ERREUR]", "Fabrication indisponible pour l'instant — clique Réessayer un peu plus tard");
        await logActivity(companyId, `✗ [ERREUR] Commande ${orderId.slice(0, 8)} : fabrication indisponible — impossible de fabriquer/expédier`);
        return { ok: false, status: "[ERREUR]", detail: "Fabrication indisponible" };
      }
      return await fulfillPrintify(companyId, order, items, podCfg);
    }
  }

  // ── Expédition propre (self-fulfillment) ──
  // L'entreprise expédie elle-même (stock détenu, dropship posté par nous,
  // made-to-order). Décrément du stock + [À EXPÉDIER] + e-mail de confirmation.
  if (await isSelfFulfillment(order, items)) {
    const r = await startSelfFulfillment(companyId, order, items);
    return { ok: r.ok, status: r.status, detail: r.detail };
  }

  // ── Semi-auto (AliExpress / service / vid manquant) ──
  if (order.fulfillmentMode !== "auto" || !cjItems.length) {
    const why = order.supplierPlatform === "service" ? "prestation de service à commander chez le prestataire"
      : order.supplierPlatform === "aliexpress" ? "produit à commander manuellement chez le fournisseur (lien dans la fiche)"
      : "références fournisseur incomplètes (variante non choisie ?)";
    await setStatus(orderId, "[À TRAITER]", `Semi-auto : ${why}`);
    await logActivity(companyId, `▶ [À TRAITER] Commande ${orderId.slice(0, 8)} en attente d'action manuelle — ${why}`);
    return { ok: true, status: "[À TRAITER]", detail: why };
  }

  // ── Full-auto CJ ──
  const secrets = await secretMap(companyId);
  const cfg = cjConfigFrom(secrets);
  if (!cfg) {
    await setStatus(orderId, "[ERREUR]", "Commande automatique fournisseur non configurée pour ce projet");
    await logActivity(companyId, `✗ [ERREUR] Commande ${orderId.slice(0, 8)} : commande automatique fournisseur non configurée pour ce projet — clique Réessayer une fois configurée`);
    return { ok: false, status: "[ERREUR]", detail: "Fournisseur non configuré" };
  }
  const dryRun = opts?.dryRun === true || secrets["CJ_DRY_RUN"] === "1" || order.dryRun === 1;

  // Adresse de livraison obligatoire.
  let addr: any = null;
  try { addr = JSON.parse(order.shippingAddress || "null"); } catch { /* adresse illisible */ }
  if (!addr?.line1 || !addr?.city || !addr?.country) {
    await setStatus(orderId, "[ERREUR]", "Adresse de livraison incomplète (line1/ville/pays manquant)");
    await logActivity(companyId, `✗ [ERREUR] Commande ${orderId.slice(0, 8)} : adresse de livraison incomplète`);
    return { ok: false, status: "[ERREUR]", detail: "Adresse incomplète" };
  }

  // Garde-fous dépense (uniquement en réel).
  const estimatedCost = items.reduce((s, i) => s + (i.unitCost || 0) * (i.quantity || 1), 0);
  if (!dryRun) {
    const cap = Number(secrets["CJ_DAILY_CAP_USD"] || "50");
    const spent = await spentTodayUsd(companyId);
    if (spent + estimatedCost > cap) {
      const d = `Plafond de dépense/jour atteint (${spent.toFixed(2)} + ${estimatedCost.toFixed(2)} > ${cap} USD). Augmente le plafond journalier ou relance demain.`;
      await setStatus(orderId, "[ERREUR]", d);
      await logActivity(companyId, `✗ [ERREUR] Commande ${orderId.slice(0, 8)} : ${d}`);
      return { ok: false, status: "[ERREUR]", detail: d };
    }
    const bal = await cj.getBalance(cfg);
    const balance = bal.ok ? Number((bal.data as any)?.amount ?? (bal.data as any)?.balance ?? 0) : null;
    if (balance != null && balance < estimatedCost) {
      const d = `Solde fournisseur insuffisant (${balance.toFixed(2)} USD < coût estimé ${estimatedCost.toFixed(2)} USD). Recharge le solde fournisseur puis clique Réessayer.`;
      await setStatus(orderId, "[ERREUR]", d);
      await logActivity(companyId, `✗ [ERREUR] Commande ${orderId.slice(0, 8)} : ${d}`);
      return { ok: false, status: "[ERREUR]", detail: d };
    }
  }

  // Choix logistique : la moins chère qui livre le pays du client.
  let logisticName = "CJPacket Ordinary";
  const freight = await cj.freightCalculate(cfg, {
    startCountryCode: "CN",
    endCountryCode: String(addr.country),
    products: cjItems.map((i) => ({ vid: i.supplierVariantId!, quantity: i.quantity || 1 })),
  });
  if (freight.ok && Array.isArray(freight.data) && (freight.data as any[]).length) {
    const options = (freight.data as any[]).slice().sort((a, b) => Number(a?.logisticPrice ?? 1e9) - Number(b?.logisticPrice ?? 1e9));
    if (options[0]?.logisticName) logisticName = String(options[0].logisticName);
  }

  // ── Dry-run : simulation complète, zéro dépense ──
  if (dryRun) {
    const fakeId = `DRYRUN-${orderId.slice(0, 8)}`;
    await setStatus(orderId, "[ENVOYÉE FOURNISSEUR]", `SIMULATION — aucune dépense. Coût estimé : ${estimatedCost.toFixed(2)} USD.`, { supplierOrderId: fakeId, dryRun: 1 });
    await logActivity(companyId, `✓ [ENVOYÉE FOURNISSEUR] (SIMULATION) Commande ${orderId.slice(0, 8)} — simulation, aucun solde débité`);
    return { ok: true, status: "[ENVOYÉE FOURNISSEUR]", detail: "Simulation dry-run réussie", supplierOrderId: fakeId, dryRun: true };
  }

  // ── Commande réelle (payType 2 = solde CJ) ──
  const res = await cj.createOrder(cfg, {
    orderNumber: orderId,
    shippingCountryCode: String(addr.country),
    shippingProvince: String(addr.state || addr.city),
    shippingCity: String(addr.city),
    shippingAddress: [addr.line1, addr.line2].filter(Boolean).join(", "),
    shippingCustomerName: String(addr.name || order.customerName || "Client"),
    shippingZip: String(addr.zip || ""),
    shippingPhone: String(addr.phone || "0000000000"),
    logisticName,
    fromCountryCode: "CN",
    email: order.customerEmail || undefined,
    remark: "Velbaz auto-fulfillment",
    products: cjItems.map((i) => ({ vid: i.supplierVariantId!, quantity: i.quantity || 1 })),
    payType: 2,
  });
  if (!res.ok) {
    const d = `Commande refusée par le fournisseur : ${res.message || "raison inconnue"}`;
    await setStatus(orderId, "[ERREUR]", d);
    await logActivity(companyId, `✗ [ERREUR] Commande ${orderId.slice(0, 8)} : ${d} — clique Réessayer après correction`);
    return { ok: false, status: "[ERREUR]", detail: d };
  }
  const data: any = res.data || {};
  const supplierOrderId = String(data.orderId || data.orderNum || data.id || "");
  const realCost = data.orderAmount != null ? Number(data.orderAmount) : estimatedCost;
  await setStatus(orderId, "[ENVOYÉE FOURNISSEUR]", `Commande fournisseur ${supplierOrderId} créée et payée par le solde (${realCost.toFixed(2)} USD)`, {
    supplierOrderId, supplierCost: realCost,
    marginAmount: order.amountTotal != null ? Number((order.amountTotal - realCost).toFixed(2)) : null,
  });
  // Marge enregistrée à titre d'AUDIT uniquement. Le chiffre d'affaires brut a
  // déjà été enregistré au moment du paiement (`order_payment`) par
  // revenue/ledger.ts ; le type `dropship_margin` fait partie de
  // NON_REVENUE_TYPES et est donc EXCLU des agrégats mrr/arr/totalRevenue —
  // sinon la même vente serait comptée deux fois.
  if (order.amountTotal != null) {
    await db.insert(schema.revenueEvents).values({
      id: uuidv4(), companyId, type: "dropship_margin",
      amount: Number((order.amountTotal - realCost).toFixed(2)), currency: order.currency || "USD",
      source: "dropshipping", customerEmail: order.customerEmail,
      description: `Marge commande ${orderId.slice(0, 8)} (vente ${order.amountTotal} − coût fournisseur ${realCost.toFixed(2)})`,
    });
  }
  await logActivity(companyId, `✓ [ENVOYÉE FOURNISSEUR] Commande ${orderId.slice(0, 8)} → fournisseur ${supplierOrderId} (coût ${realCost.toFixed(2)} USD, marge ${(order.amountTotal != null ? order.amountTotal - realCost : 0).toFixed(2)})`);
  return { ok: true, status: "[ENVOYÉE FOURNISSEUR]", detail: `Fournisseur ${supplierOrderId}`, supplierOrderId };
}

// ── Suivi Printify : applique un numéro de suivi / une livraison à la commande ──
// Une commande Printify n'était jamais mise à jour côté `orders` : le webhook
// n'écrivait que dans `printify_orders` et `syncTracking` ne parlait qu'à CJ.
// Résultat : la commande restait [ENVOYÉE FOURNISSEUR] à vie et le client ne
// recevait jamais son numéro de suivi. Ce helper est la source unique de vérité,
// appelée par le webhook Printify (temps réel) ET par syncTracking (polling de
// secours quand le webhook n'est pas configuré chez Printify).
// Idempotent : un suivi déjà enregistré n'est pas réécrit, l'e-mail client n'est
// donc jamais renvoyé deux fois.
export async function applyPrintifyTracking(companyId: string, opts: {
  orderId?: string | null;
  printifyOrderId?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  delivered?: boolean;
}): Promise<{ updated: boolean }> {
  let order: any = null;
  if (opts.orderId) {
    order = await db.select().from(schema.orders)
      .where(and(eq(schema.orders.id, String(opts.orderId)), eq(schema.orders.companyId, companyId))).get();
  }
  if (!order && opts.printifyOrderId) {
    order = await db.select().from(schema.orders)
      .where(and(eq(schema.orders.companyId, companyId), eq(schema.orders.supplierOrderId, String(opts.printifyOrderId)))).get();
  }
  if (!order) return { updated: false };

  let updated = false;
  const tracking = opts.trackingNumber ? String(opts.trackingNumber) : null;
  if (tracking && !order.trackingNumber) {
    // Printify fournit l'URL du transporteur ; sinon suivi universel 17track.
    const trackingUrl = opts.trackingUrl ? String(opts.trackingUrl)
      : `https://t.17track.net/en#nums=${encodeURIComponent(tracking)}`;
    await db.update(schema.orders).set({ trackingNumber: tracking, trackingUrl, updatedAt: new Date() })
      .where(eq(schema.orders.id, order.id));
    updated = true;
    if (order.customerEmail) {
      await sendEmail({
        ...(await siteFromFields(companyId)),
        to: order.customerEmail,
        subject: "Votre commande est en route 📦",
        text: `Bonne nouvelle ! Votre commande a été expédiée.\n\nNuméro de suivi : ${tracking}\nSuivre le colis : ${trackingUrl}\n\nMerci pour votre achat !`,
      }).catch(() => { /* e-mail non configuré → le suivi reste visible au dashboard */ });
    }
    await logActivity(companyId, `▶ [EN ROUTE] Commande ${order.id.slice(0, 8)} expédiée — suivi ${tracking} (e-mail client ${order.customerEmail ? "envoyé" : "non configuré"})`);
  }
  if (opts.delivered && !String(order.status || "").startsWith("[LIVRÉE]")) {
    await setStatus(order.id, "[LIVRÉE]", "Colis livré au client");
    await logActivity(companyId, `✓ [LIVRÉE] Commande ${order.id.slice(0, 8)} livrée au client`);
    updated = true;
  }
  return { updated };
}

// Une commande part-elle chez Printify ? (mode/plateforme explicites, id
// fournisseur Printify, ou ligne de suivi créée par fulfillPrintify)
async function isPrintifyOrder(companyId: string, order: any): Promise<boolean> {
  if (order.fulfillmentMode === "printify" || order.supplierPlatform === "printify") return true;
  if (String(order.supplierOrderId || "").startsWith("PRINTIFY-")) return true;
  try {
    const row = await db.select().from(schema.printifyOrders).where(and(
      eq(schema.printifyOrders.companyId, companyId),
      eq(schema.printifyOrders.referenceId, order.id),
    )).get();
    return !!row;
  } catch { return false; }
}

// ── Synchronisation du suivi (polling Printify + CJ) ──
// [ENVOYÉE FOURNISSEUR] → tracking → e-mail client → [LIVRÉE].
export async function syncTracking(companyId: string): Promise<{ checked: number; updated: number }> {
  const secrets = await secretMap(companyId);
  const cfg = cjConfigFrom(secrets);
  const podCfg = printifyConfigFrom(secrets);
  let podShop: string | null | undefined;
  const rows = await db.select().from(schema.orders).where(and(
    eq(schema.orders.companyId, companyId),
    eq(schema.orders.status, "[ENVOYÉE FOURNISSEUR]"),
    isNotNull(schema.orders.supplierOrderId),
  ));
  let updated = 0;
  for (const o of rows) {
    if (o.dryRun === 1 || o.supplierOrderId!.startsWith("DRYRUN-")) continue;

    // ── Print-on-demand Printify ──
    if (await isPrintifyOrder(companyId, o)) {
      if (!podCfg) continue;
      if (podShop === undefined) podShop = await printify.resolveShopId(podCfg);
      if (!podShop) continue;
      const det = await printify.getOrder({ ...podCfg, shopId: podShop }, o.supplierOrderId!);
      if (!det.ok) continue;
      const d: any = det.data || {};
      const ship = Array.isArray(d.shipments) ? d.shipments[0] : null;
      const tracking = ship?.number || ship?.tracking_number || d.tracking_number || null;
      const pStatus = String(d.status || "").toLowerCase();
      const delivered = pStatus.includes("delivered") || !!ship?.delivered_at;
      await applyPrintifyCost(o, d);
      // Toujours « on-hold » après 26 h : Printify n'a ni débité ni fabriqué.
      let prev: any = null;
      try {
        prev = await db.select().from(schema.printifyOrders).where(and(
          eq(schema.printifyOrders.companyId, companyId), eq(schema.printifyOrders.referenceId, o.id),
        )).get();
      } catch { /* table optionnelle */ }
      const alerted = String(prev?.status || "") === "on-hold-alerted";
      if (printifyOnHoldTooLong(d) && !alerted) {
        const msg = `Toujours en attente à l'atelier (${o.supplierOrderId}) plus de 24 h après la commande : pas encore fabriquée.`;
        await setStatus(o.id, "[ENVOYÉE FOURNISSEUR]", msg);
        await logActivity(companyId, `⚠ Commande ${o.id.slice(0, 8)} : ${msg}`);
      }
      const r = await applyPrintifyTracking(companyId, {
        orderId: o.id, trackingNumber: tracking, trackingUrl: ship?.url || null, delivered,
      });
      if (r.updated) updated++;
      // Journal d'audit côté printify_orders (best-effort).
      const set: Record<string, unknown> = { lastEvent: JSON.stringify({ polled: d }), updatedAt: new Date() };
      if (pStatus) set.status = pStatus === "on-hold" && (alerted || printifyOnHoldTooLong(d)) ? "on-hold-alerted" : pStatus;
      if (delivered) set.shipmentStatus = "delivered"; else if (tracking) set.shipmentStatus = "shipped";
      if (ship?.url) set.trackingUrl = String(ship.url);
      try {
        await db.update(schema.printifyOrders).set(set as any).where(and(
          eq(schema.printifyOrders.companyId, companyId),
          eq(schema.printifyOrders.referenceId, o.id),
        ));
      } catch { /* table optionnelle */ }
      continue;
    }

    // ── CJ Dropshipping ──
    if (!cfg) continue;
    const det = await cj.getOrderDetail(cfg, o.supplierOrderId!);
    if (!det.ok) continue;
    const d: any = det.data || {};
    const tracking = d.trackNumber || d.trackingNumber || null;
    const cjStatus = String(d.orderStatus || d.status || "").toUpperCase();
    if (tracking && !o.trackingNumber) {
      const trackingUrl = `https://www.cjpacket.com/?track=${encodeURIComponent(String(tracking))}`;
      await db.update(schema.orders).set({ trackingNumber: String(tracking), trackingUrl, updatedAt: new Date() }).where(eq(schema.orders.id, o.id));
      updated++;
      if (o.customerEmail) {
        await sendEmail({
          ...(await siteFromFields(companyId)),
          to: o.customerEmail,
          subject: "Votre commande est en route 📦",
          text: `Bonne nouvelle ! Votre commande a été expédiée.\n\nNuméro de suivi : ${tracking}\nSuivre le colis : ${trackingUrl}\n\nMerci pour votre achat !`,
        }).catch(() => { /* e-mail non configuré → le suivi reste visible au dashboard */ });
      }
      await logActivity(companyId, `▶ [EN ROUTE] Commande ${o.id.slice(0, 8)} expédiée — suivi ${tracking} (e-mail client ${o.customerEmail ? "envoyé" : "non configuré"})`);
    }
    if (cjStatus.includes("DELIVERED")) {
      await setStatus(o.id, "[LIVRÉE]", "Colis livré au client");
      await logActivity(companyId, `✓ [LIVRÉE] Commande ${o.id.slice(0, 8)} livrée au client`);
      updated++;
    }
  }
  return { checked: rows.length, updated };
}

// ── Scheduler global : toutes les 30 min, pour toutes les entreprises actives ──
let trackingTimer: ReturnType<typeof setInterval> | null = null;
export function startTrackingScheduler() {
  if (trackingTimer) return;
  trackingTimer = setInterval(async () => {
    try {
      const pending = await db.selectDistinct({ companyId: schema.orders.companyId }).from(schema.orders)
        .where(eq(schema.orders.status, "[ENVOYÉE FOURNISSEUR]"));
      for (const p of pending) {
        try { await syncTracking(p.companyId); } catch (e) { console.error(`[tracking] ${p.companyId}`, e); }
      }
    } catch (e) { console.error("[tracking-scheduler]", e); }
  }, 30 * 60 * 1000);
}
