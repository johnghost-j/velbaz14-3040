// Page de retour de paiement Stripe des sites générés : pop-up « Merci ! »
// avec n° de commande, montant et e-mail de confirmation.
//
// Le composant n'utilise QUE ce que les App.tsx générés importent déjà
// (useSearchParams, Link, useEffect, useState, api) → il peut remplacer
// l'ancienne page de succès des sites existants sans toucher aux imports.
// Styles inline : marche aussi en mode clone (sans garantie de Tailwind).

export const CHECKOUT_THANKS_MARKER = "velbaz:checkout-thanks v1";

export const CHECKOUT_THANKS_TSX = `// ${CHECKOUT_THANKS_MARKER} — retour de paiement Stripe (pop-up de remerciement).
// Appeler /checkout/:id ENREGISTRE la commande côté Velbaz (dashboard,
// fulfillment, e-mail de confirmation + reçu) : 3 tentatives.
function CheckoutThanks({ ok }: { ok: boolean }) {
  const [params] = useSearchParams();
  const sessionId = params.get("session_id");
  const [status, setStatus] = useState<"loading" | "ok" | "pending" | "error">(ok ? "loading" : "ok");
  const [info, setInfo] = useState<any>(null);
  const [open, setOpen] = useState(true);
  const htmlLang = (typeof document !== "undefined" && document.documentElement.lang) || "";
  const navLang = (typeof navigator !== "undefined" && navigator.language) || "fr";
  // Le <html lang> des sites générés vaut toujours "fr" → on suit la langue
  // du navigateur de l'acheteur, sauf site explicitement anglais.
  const en = /^en/i.test(htmlLang) || !/^fr/i.test(navLang);
  useEffect(() => {
    if (!ok) return;
    if (!sessionId) { setStatus("error"); return; }
    let alive = true;
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r: any = await api("/checkout/" + sessionId);
          if (!alive) return;
          setInfo(r || null);
          setStatus(r && r.status && r.status !== "paid" && r.status !== "no_payment_required" ? "pending" : "ok");
          return;
        } catch {
          await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
        }
      }
      if (alive) setStatus("error");
    })();
    return () => { alive = false; };
  }, [ok, sessionId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let amount = "";
  if (info && typeof info.amount === "number") {
    try {
      amount = new Intl.NumberFormat(en ? "en-US" : "fr-FR", { style: "currency", currency: String(info.currency || "eur").toUpperCase() }).format(info.amount / 100);
    } catch { amount = (info.amount / 100).toFixed(2) + " " + String(info.currency || "").toUpperCase(); }
  }
  const email = info && info.email ? String(info.email) : "";
  const ref = info && info.orderRef ? String(info.orderRef) : "";

  const t = !ok
    ? { title: en ? "Payment cancelled" : "Paiement annulé", body: en ? "No money was taken." : "Aucun montant n'a été débité." }
    : status === "ok"
      ? { title: en ? "Thank you! Payment confirmed" : "Merci ! Paiement confirmé",
          body: email
            ? (en ? "A confirmation and your receipt have been sent to " : "Une confirmation et ton reçu ont été envoyés à ") + email + "."
            : (en ? "A confirmation and your receipt are on their way by email." : "Une confirmation et ton reçu arrivent par e-mail.") }
      : status === "pending"
        ? { title: en ? "Payment processing" : "Paiement en cours de traitement", body: en ? "You'll get an email as soon as it is confirmed." : "Tu recevras un e-mail dès qu'il sera confirmé." }
        : status === "error"
          ? { title: en ? "We couldn't verify your payment" : "Vérification impossible", body: en ? "Your payment may still have gone through: check your inbox before trying again." : "Ton paiement a peut-être bien été pris en compte : vérifie ta boîte mail avant de réessayer." }
          : { title: en ? "Confirming your payment…" : "Confirmation du paiement…", body: "" };

  const good = ok && status === "ok";
  const color = !ok || status === "pending" ? "#d97706" : status === "error" ? "#dc2626" : "#16a34a";
  const icon = status === "loading" && ok
    ? <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" style={{ animation: "vzspin 0.9s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" /></svg>
    : <div style={{ width: 64, height: 64, borderRadius: 999, background: color + "1a", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          {good ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : status === "pending" ? <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2" /></> : <path d="M7 7l10 10M17 7L7 17" />}
        </svg>
      </div>;

  const card = (
    <div role={open ? "dialog" : undefined} aria-modal={open ? true : undefined} aria-labelledby="vz-thanks-title"
      style={{ position: "relative", width: "100%", maxWidth: 440, background: "#fff", color: "#111827", borderRadius: 20, padding: "36px 28px 28px", textAlign: "center", boxShadow: open ? "0 24px 70px rgba(0,0,0,0.28)" : "0 4px 24px rgba(0,0,0,0.08)", fontFamily: "inherit", animation: open ? "vzpop 0.28s cubic-bezier(.2,.9,.3,1.2)" : undefined }}>
      {open && status !== "loading" && (
        <button type="button" onClick={() => setOpen(false)} aria-label={en ? "Close" : "Fermer"}
          style={{ position: "absolute", top: 12, right: 12, width: 34, height: 34, borderRadius: 999, border: "none", background: "#f3f4f6", color: "#374151", fontSize: 18, lineHeight: "34px", cursor: "pointer" }}>×</button>
      )}
      <div style={{ display: "flex", justifyContent: "center" }}>{icon}</div>
      <h1 id="vz-thanks-title" style={{ marginTop: 18, fontSize: 24, lineHeight: 1.25, fontWeight: 800, color: "#111827" }}>{t.title}</h1>
      {(ref || amount) && good && (
        <div style={{ marginTop: 16, display: "inline-flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
          {ref && <span style={{ padding: "6px 12px", borderRadius: 999, background: "#f3f4f6", fontSize: 13, fontWeight: 700, letterSpacing: 0.4 }}>{(en ? "Order " : "Commande ") + ref}</span>}
          {amount && <span style={{ padding: "6px 12px", borderRadius: 999, background: "#f3f4f6", fontSize: 13, fontWeight: 700 }}>{amount}</span>}
        </div>
      )}
      {t.body && <p style={{ marginTop: 14, fontSize: 15, lineHeight: 1.55, color: "#4b5563" }}>{t.body}</p>}
      {good && <p style={{ marginTop: 6, fontSize: 13, color: "#9ca3af" }}>{en ? "Can't find it? Check your spam folder." : "Pas reçu ? Pense à vérifier tes spams."}</p>}
      {status !== "loading" && (
        <Link to="/" onClick={() => setOpen(false)}
          style={{ display: "inline-block", marginTop: 22, padding: "12px 22px", borderRadius: 12, background: "#111827", color: "#fff", fontWeight: 700, fontSize: 15, textDecoration: "none" }}>
          {en ? "Back to the shop" : "Retour à la boutique"}
        </Link>
      )}
    </div>
  );

  return (
    <div style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{"@keyframes vzspin{to{transform:rotate(360deg)}}@keyframes vzpop{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}@keyframes vzfade{from{opacity:0}to{opacity:1}}"}</style>
      {open && status !== "loading"
        ? <div onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
            style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(17,24,39,0.55)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, animation: "vzfade 0.2s ease-out" }}>
            {card}
          </div>
        : card}
    </div>
  );
}
`;

/** Version standard (router complet) : /success + /cancel. */
export const STANDARD_RETURN_PAGES_TSX = `${CHECKOUT_THANKS_TSX}
function Success() {
  return <CheckoutThanks ok />;
}
`;

/** Version clone (router minimal) : un seul composant paramétré. */
export const CLONE_RETURN_PAGES_TSX = `${CHECKOUT_THANKS_TSX}
function PaymentReturn({ ok }: { ok: boolean }) {
  return <CheckoutThanks ok={ok} />;
}
`;

/**
 * Met à niveau la page de retour de paiement d'un App.tsx DÉJÀ généré
 * (ancienne page « Paiement réussi » sans récap). Ne touche qu'au bloc exact
 * produit par le générateur ; tout App.tsx retouché à la main reste intact.
 */
export function upgradeCheckoutPages(content: string): string {
  if (typeof content !== "string" || content.includes(CHECKOUT_THANKS_MARKER)) return content;
  let out = content;
  const blocks: Array<[string, string, string]> = [
    ["function Success() {\n  const [params] = useSearchParams();", "\nfunction Cancel() {", STANDARD_RETURN_PAGES_TSX],
    ["function PaymentReturn({ ok }: { ok: boolean }) {\n  const [params] = useSearchParams();", "\nexport default function App()", CLONE_RETURN_PAGES_TSX],
  ];
  for (const [start, end, replacement] of blocks) {
    const a = out.indexOf(start);
    if (a < 0) continue;
    const b = out.indexOf(end, a);
    if (b < 0) continue;
    const old = out.slice(a, b);
    if (!old.includes('api("/checkout/" + sessionId)')) continue;
    // Imports requis par le nouveau composant (déjà présents dans les versions générées).
    if (!/\buseSearchParams\b/.test(out.slice(0, a)) || !/\bLink\b/.test(out.slice(0, a)) || !/\bapi\b/.test(out.slice(0, a))) continue;
    out = out.slice(0, a) + replacement + out.slice(b);
  }
  return out;
}
