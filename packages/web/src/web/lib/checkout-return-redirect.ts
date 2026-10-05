// Anciens liens de paiement : Stripe renvoyait l'acheteur sur
// <hôte Velbaz>/success au lieu du site généré → 404 Velbaz. Le serveur
// connaît l'entreprise de la session et redirige vers sa page de succès.
if (typeof window !== "undefined" && window.location.pathname === "/success") {
  const sid = new URLSearchParams(window.location.search).get("session_id") || "";
  if (/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sid)) {
    window.location.replace("/api/checkout/return?session_id=" + encodeURIComponent(sid));
  }
}
export {};
