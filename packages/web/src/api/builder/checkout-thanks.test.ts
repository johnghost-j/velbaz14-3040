import { describe, expect, test } from "bun:test";
import { CHECKOUT_THANKS_MARKER, STANDARD_RETURN_PAGES_TSX, CLONE_RETURN_PAGES_TSX, upgradeCheckoutPages } from "./checkout-thanks";
import { SERVER_STRIPE } from "./scaffold";

const LEGACY_STANDARD = `import { Routes, Route, useSearchParams, useNavigate, Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "./lib/api";

function Success() {
  const [params] = useSearchParams();
  const sessionId = params.get("session_id");
  useEffect(() => { api("/checkout/" + sessionId); }, [sessionId]);
  return <div>Paiement réussi !</div>;
}

function Cancel() {
  return <div>Paiement annulé</div>;
}

export default function App() { return <Routes><Route path="/success" element={<Success />} /></Routes>; }
`;

const LEGACY_CLONE = `import { Routes, Route, useLocation, useSearchParams, Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "./lib/api";

function PaymentReturn({ ok }: { ok: boolean }) {
  const [params] = useSearchParams();
  const sessionId = params.get("session_id");
  useEffect(() => { if (ok) api("/checkout/" + sessionId); }, [ok, sessionId]);
  return <div>Paiement réussi</div>;
}

export default function App() { return <Routes><Route path="/success" element={<PaymentReturn ok />} /></Routes>; }
`;

const tsx = new Bun.Transpiler({ loader: "tsx" });

describe("page de remerciement après paiement", () => {
  test("le composant généré compile (TSX valide)", () => {
    const head = `import { useSearchParams, Link } from "react-router-dom";\nimport { useEffect, useState } from "react";\nimport { api } from "./lib/api";\n`;
    expect(() => tsx.transformSync(head + STANDARD_RETURN_PAGES_TSX)).not.toThrow();
    expect(() => tsx.transformSync(head + CLONE_RETURN_PAGES_TSX)).not.toThrow();
  });

  test("contenu : merci, n° de commande, montant, e-mail, retour boutique", () => {
    expect(STANDARD_RETURN_PAGES_TSX).toContain("Merci ! Paiement confirmé");
    expect(STANDARD_RETURN_PAGES_TSX).toContain("orderRef");
    expect(STANDARD_RETURN_PAGES_TSX).toContain("info.email");
    expect(STANDARD_RETURN_PAGES_TSX).toContain("Retour à la boutique");
    expect(STANDARD_RETURN_PAGES_TSX).toContain('role={open ? "dialog"');
    expect(STANDARD_RETURN_PAGES_TSX).toContain('api("/checkout/" + sessionId)');
  });

  test("met à niveau l'ancienne page standard, garde Cancel et le routeur", () => {
    const out = upgradeCheckoutPages(LEGACY_STANDARD);
    expect(out).toContain(CHECKOUT_THANKS_MARKER);
    expect(out).toContain("return <CheckoutThanks ok />;");
    expect(out).not.toContain("<div>Paiement réussi !</div>");
    expect(out).toContain("function Cancel()");
    expect(out).toContain('<Route path="/success" element={<Success />} />');
    expect(() => tsx.transformSync(out)).not.toThrow();
    expect(upgradeCheckoutPages(out)).toBe(out); // idempotent
  });

  test("met à niveau l'ancienne page du mode clone", () => {
    const out = upgradeCheckoutPages(LEGACY_CLONE);
    expect(out).toContain("return <CheckoutThanks ok={ok} />;");
    expect(out).not.toContain("<div>Paiement réussi</div>");
    expect(() => tsx.transformSync(out)).not.toThrow();
  });

  test("App.tsx retouché à la main (sans l'appel /checkout) : intact", () => {
    const custom = LEGACY_STANDARD.replace('api("/checkout/" + sessionId);', "track();");
    expect(upgradeCheckoutPages(custom)).toBe(custom);
    expect(upgradeCheckoutPages("export default 1;")).toBe("export default 1;");
  });
});

describe("server/stripe.ts du site : URL de retour", () => {
  test("success/cancel incluent la base réelle du site (pas l'origine nue)", () => {
    expect(SERVER_STRIPE).toContain('siteBase(origin) + "/success?session_id={CHECKOUT_SESSION_ID}"');
    expect(SERVER_STRIPE).toContain('siteBase(origin) + "/cancel"');
    expect(SERVER_STRIPE).not.toContain('origin + "/success');
    expect(SERVER_STRIPE).toContain("returnUrl: siteBase(origin)");
  });
  test("le fichier généré compile et siteBase préfixe VITE_APP_BASE", () => {
    const ts = new Bun.Transpiler({ loader: "ts" });
    expect(() => ts.transformSync(SERVER_STRIPE)).not.toThrow();
    const fn = SERVER_STRIPE.slice(SERVER_STRIPE.indexOf("function siteBase"), SERVER_STRIPE.indexOf("type PlatformResult"));
    const js = ts.transformSync(fn + "\nexport { siteBase };");
    const siteBase = new Function("process", js.replace("export { siteBase };", "return siteBase;"));
    const withBase = siteBase({ env: { VITE_APP_BASE: "/api/companies/x/preview/" } });
    expect(withBase("https://velbaz.com")).toBe("https://velbaz.com/api/companies/x/preview");
    expect(withBase("https://velbaz.com/api/companies/x/preview/")).toBe("https://velbaz.com/api/companies/x/preview");
    const standalone = siteBase({ env: {} });
    expect(standalone("https://shop.fr")).toBe("https://shop.fr");
  });
});
