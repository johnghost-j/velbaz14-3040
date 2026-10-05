// E-mail « Merci pour votre commande » + reçu, envoyé à l'ACHETEUR d'un site
// généré dès que son paiement est confirmé. Fonction pure (testée) : aucun
// accès base ni réseau ici — l'envoi idempotent vit dans order-confirmation-send.ts.

export type OrderEmailLang = "fr" | "en";

export interface OrderEmailItem {
  name: string;
  quantity: number;
  unitPrice?: number | null; // en unités (ex. 25.5), pas en centimes
  variantLabel?: string | null;
}

export interface OrderEmailInput {
  shopName: string;
  orderRef: string;
  date: Date;
  customerName?: string | null;
  customerEmail: string;
  items: OrderEmailItem[];
  total: number | null;       // en unités
  currency: string;           // "EUR", "usd"…
  shipping?: {
    name?: string | null; line1?: string | null; line2?: string | null;
    zip?: string | null; city?: string | null; state?: string | null; country?: string | null;
  } | null;
  receiptUrl?: string | null; // reçu officiel Stripe
  siteUrl?: string | null;
  brandColor?: string | null;
  lang?: OrderEmailLang;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function formatMoney(amount: number | null | undefined, currency: string, lang: OrderEmailLang = "fr"): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const cur = (currency || "EUR").toUpperCase();
  try {
    return new Intl.NumberFormat(lang === "en" ? "en-US" : "fr-FR", { style: "currency", currency: cur }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${cur}`;
  }
}

function safeUrl(u?: string | null): string | null {
  try {
    const x = new URL(String(u || ""));
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null;
  } catch { return null; }
}

function safeColor(c?: string | null): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(c || "")) ? String(c) : "#111827";
}

const T = {
  fr: {
    subject: (ref: string, shop: string) => `Merci pour votre commande ${ref} — ${shop}`,
    preheader: (total: string) => `Paiement de ${total} confirmé. Votre reçu est à l'intérieur.`,
    hello: (n?: string | null) => (n ? `Merci ${n} !` : "Merci pour votre commande !"),
    intro: (total: string, shop: string) => `Votre paiement de <strong>${total}</strong> a bien été reçu par ${shop}. Voici le récapitulatif et votre reçu.`,
    introText: (total: string, shop: string) => `Votre paiement de ${total} a bien été reçu par ${shop}.`,
    receipt: "Reçu de paiement",
    order: "N° de commande",
    date: "Date",
    paid: "Payé par carte (Stripe)",
    method: "Moyen de paiement",
    item: "Article", qty: "Qté", price: "Prix",
    total: "Total payé",
    shipTo: "Livraison à",
    stripe: "Télécharger le reçu officiel",
    shop: "Retour à la boutique",
    next: "Vous recevrez un nouvel e-mail dès que votre commande sera expédiée.",
    help: "Une question ? Répondez simplement à cet e-mail.",
    seller: "Vendeur",
  },
  en: {
    subject: (ref: string, shop: string) => `Thanks for your order ${ref} — ${shop}`,
    preheader: (total: string) => `Payment of ${total} confirmed. Your receipt is inside.`,
    hello: (n?: string | null) => (n ? `Thank you, ${n}!` : "Thank you for your order!"),
    intro: (total: string, shop: string) => `Your payment of <strong>${total}</strong> to ${shop} was received. Here is your summary and receipt.`,
    introText: (total: string, shop: string) => `Your payment of ${total} to ${shop} was received.`,
    receipt: "Payment receipt",
    order: "Order number",
    date: "Date",
    paid: "Paid by card (Stripe)",
    method: "Payment method",
    item: "Item", qty: "Qty", price: "Price",
    total: "Total paid",
    shipTo: "Shipping to",
    stripe: "Download the official receipt",
    shop: "Back to the shop",
    next: "You'll get another email as soon as your order ships.",
    help: "Questions? Just reply to this email.",
    seller: "Seller",
  },
} as const;

export function renderOrderConfirmationEmail(input: OrderEmailInput): { subject: string; html: string; text: string } {
  const lang: OrderEmailLang = input.lang === "en" ? "en" : "fr";
  const t = T[lang];
  const shop = (input.shopName || "").trim() || (lang === "en" ? "the shop" : "la boutique");
  const total = formatMoney(input.total, input.currency, lang);
  const firstName = (input.customerName || "").trim().split(/\s+/)[0] || null;
  const date = new Intl.DateTimeFormat(lang === "en" ? "en-US" : "fr-FR", { dateStyle: "long" }).format(input.date);
  const color = safeColor(input.brandColor);
  const receiptUrl = safeUrl(input.receiptUrl);
  const siteUrl = safeUrl(input.siteUrl);
  const items = (input.items || []).filter((i) => i && i.name);

  const rows = items.map((it) => {
    const q = Math.max(1, Math.round(Number(it.quantity) || 1));
    const line = it.unitPrice != null ? formatMoney(it.unitPrice * q, input.currency, lang) : "";
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#111">${esc(it.name)}${it.variantLabel ? `<div style="font-size:12px;color:#777">${esc(it.variantLabel)}</div>` : ""}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#555;text-align:center">${q}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#111;text-align:right;white-space:nowrap">${esc(line)}</td>
    </tr>`;
  }).join("");

  const s = input.shipping || null;
  const shipLines = s ? [s.name, s.line1, s.line2, [s.zip, s.city].filter(Boolean).join(" "), s.state, s.country].filter((x) => x && String(x).trim()) : [];

  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.subject(input.orderRef, shop))}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(t.preheader(total))}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="background:${color};padding:22px 28px;color:#fff;font-size:18px;font-weight:700">${esc(shop)}</td></tr>
  <tr><td style="padding:28px">
    <div style="font-size:22px;font-weight:700;color:#111">${esc(t.hello(firstName))}</div>
    <p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#444">${t.intro(esc(total), esc(shop))}</p>

    <div style="margin:24px 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;font-weight:700">${esc(t.receipt)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#333;background:#fafafa;border-radius:10px;padding:12px 14px">
      <tr><td style="padding:3px 0;color:#777">${esc(t.order)}</td><td style="padding:3px 0;text-align:right;font-weight:600">${esc(input.orderRef)}</td></tr>
      <tr><td style="padding:3px 0;color:#777">${esc(t.date)}</td><td style="padding:3px 0;text-align:right">${esc(date)}</td></tr>
      <tr><td style="padding:3px 0;color:#777">${esc(t.method)}</td><td style="padding:3px 0;text-align:right">${esc(t.paid)}</td></tr>
      <tr><td style="padding:3px 0;color:#777">${esc(t.seller)}</td><td style="padding:3px 0;text-align:right">${esc(shop)}</td></tr>
    </table>

    ${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px">
      <tr><th align="left" style="font-size:12px;color:#888;font-weight:600;padding-bottom:6px">${esc(t.item)}</th><th style="font-size:12px;color:#888;font-weight:600;padding-bottom:6px">${esc(t.qty)}</th><th align="right" style="font-size:12px;color:#888;font-weight:600;padding-bottom:6px">${esc(t.price)}</th></tr>
      ${rows}
    </table>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px">
      <tr><td style="font-size:16px;font-weight:700;color:#111">${esc(t.total)}</td><td style="font-size:16px;font-weight:700;color:#111;text-align:right">${esc(total)}</td></tr>
    </table>

    ${shipLines.length ? `<div style="margin-top:22px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;font-weight:700">${esc(t.shipTo)}</div>
    <div style="margin-top:6px;font-size:14px;line-height:1.5;color:#333">${shipLines.map(esc).join("<br>")}</div>
    <p style="margin:14px 0 0;font-size:13px;color:#666">${esc(t.next)}</p>` : ""}

    <div style="margin-top:26px">
      ${receiptUrl ? `<a href="${esc(receiptUrl)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:9px;margin:0 8px 8px 0">${esc(t.stripe)}</a>` : ""}
      ${siteUrl ? `<a href="${esc(siteUrl)}" style="display:inline-block;background:#f1f1f3;color:#111;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:9px;margin:0 0 8px 0">${esc(t.shop)}</a>` : ""}
    </div>
    <p style="margin:18px 0 0;font-size:13px;color:#888">${esc(t.help)}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    t.hello(firstName),
    "",
    t.introText(total, shop),
    "",
    `${t.receipt}`,
    `${t.order} : ${input.orderRef}`,
    `${t.date} : ${date}`,
    `${t.method} : ${t.paid}`,
    "",
    ...items.map((it) => {
      const q = Math.max(1, Math.round(Number(it.quantity) || 1));
      const line = it.unitPrice != null ? ` — ${formatMoney(it.unitPrice * q, input.currency, lang)}` : "";
      return `• ${it.name}${it.variantLabel ? ` (${it.variantLabel})` : ""} × ${q}${line}`;
    }),
    `${t.total} : ${total}`,
    ...(shipLines.length ? ["", `${t.shipTo} :`, ...shipLines.map(String)] : []),
    ...(receiptUrl ? ["", `${t.stripe} : ${receiptUrl}`] : []),
    ...(siteUrl ? [`${t.shop} : ${siteUrl}`] : []),
    "",
    t.help,
  ].join("\n");

  return { subject: t.subject(input.orderRef, shop), html, text };
}
