/**
 * Balise de mesure injectée dans les sites générés.
 *
 * Contraintes : minuscule, sans dépendance, sans cookie tiers, et incapable de
 * casser la page hôte (tout est dans un try/catch et un IIFE). L'identifiant de
 * session vit en `sessionStorage` — il disparaît à la fermeture de l'onglet,
 * donc pas de suivi persistant entre visites (RGPD : mesure d'audience
 * strictement nécessaire, pas de profilage publicitaire).
 *
 * Elle envoie :
 *   - un `pageview` au chargement et à chaque navigation (SPA incluse) ;
 *   - un `lead` quand un formulaire contenant un champ email est soumis ;
 *   - un `checkout_start` au clic sur un lien/bouton de paiement.
 * Le `purchase` n'est JAMAIS envoyé par le navigateur : il est écrit côté
 * serveur au moment du paiement Stripe, sinon n'importe qui pourrait fabriquer
 * du faux chiffre d'affaires en appelant l'endpoint.
 */

/** Chemin public de l'endpoint de collecte. */
export const BEACON_PATH = '/api/t';

/**
 * Renvoie le `<script>` de mesure pour une société.
 * `origin` permet de viser l'API Velbaz depuis un domaine personnalisé.
 */
export function beaconScript(companyId: string, origin = ''): string {
  const endpoint = `${origin}${BEACON_PATH}/${companyId}`;
  return `<script id="velbaz-beacon" data-company="${companyId}">
(function(){
  try {
    var EP = ${JSON.stringify(endpoint)};
    var KEY = 'vbz_sid';
    var sid = '';
    try { sid = sessionStorage.getItem(KEY) || ''; } catch(e) {}
    if (!sid) {
      sid = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem(KEY, sid); } catch(e) {}
    }
    var lastPath = '';
    function send(event, extra, stripeSessionId) {
      try {
        var body = JSON.stringify({
          sid: sid,
          event: event,
          url: location.href,
          ref: document.referrer || '',
          meta: extra || undefined,
          stripeSessionId: stripeSessionId || undefined
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(EP, new Blob([body], { type: 'application/json' }));
        } else {
          fetch(EP, { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(function(){});
        }
      } catch(e) {}
    }
    function pageview() {
      var p = location.pathname + location.search;
      if (p === lastPath) return;
      lastPath = p;
      send('pageview');
    }
    pageview();

    // Retour de paiement : la page de succès porte ?session_id=cs_xxx. On relie
    // la session navigateur à la session Stripe — c'est ce lien qui permet au
    // serveur de créditer le chiffre d'affaires au bon canal d'acquisition.
    // Aucun montant n'est transmis : le montant vient de Stripe, côté serveur.
    try {
      var qs = new URLSearchParams(location.search);
      var stripeSid = qs.get('session_id') || qs.get('checkout_session_id') || '';
      if (stripeSid && /^cs_/.test(stripeSid)) send('checkout_return', null, stripeSid);
    } catch(e) {}

    // Navigation SPA : history API + retour arrière.
    try {
      var push = history.pushState;
      history.pushState = function(){ push.apply(this, arguments); setTimeout(pageview, 0); };
      var repl = history.replaceState;
      history.replaceState = function(){ repl.apply(this, arguments); setTimeout(pageview, 0); };
    } catch(e) {}
    window.addEventListener('popstate', function(){ setTimeout(pageview, 0); });
    window.addEventListener('hashchange', function(){ setTimeout(pageview, 0); });

    // Lead : soumission d'un formulaire contenant un email.
    // On transmet l'adresse elle-même : la plupart des sites générés n'ont
    // aucun backend derrière leur formulaire, donc sans ça le visiteur laisse
    // ses coordonnées et personne ne peut jamais le rappeler. Le serveur
    // valide, normalise et déduplique — rien n'est fait confiance ici.
    document.addEventListener('submit', function(e) {
      try {
        var f = e.target;
        if (!f || !f.querySelector) return;
        var em = f.querySelector('input[type=email], input[name*=mail i], input[id*=mail i]');
        var val = em ? String(em.value || '').trim() : '';
        if (!val || val.indexOf('@') === -1) return;
        var meta = { form: f.getAttribute('id') || f.getAttribute('name') || '' };
        if (val.length <= 200) meta.email = val;
        var nm = f.querySelector('input[name*=nom i], input[name*=name i], input[id*=nom i], input[id*=name i]');
        if (nm && nm !== em) {
          var nv = String(nm.value || '').trim();
          if (nv) meta.name = nv.slice(0, 200);
        }
        // Le message est la demande réelle du prospect : sans lui, l'agent
        // rappelle sans savoir de quoi il s'agit.
        var msg = f.querySelector('textarea');
        if (msg) {
          var mv = String(msg.value || '').trim();
          if (mv) meta.message = mv.slice(0, 1000);
        }
        // Piège à robots éventuel : s'il est rempli, le serveur écarte le lead.
        var hp = f.querySelector('input[name*=honey i], input[name=_gotcha], input[name*=captcha i]');
        if (hp && String(hp.value || '').trim() !== '') meta.hp = 1;
        send('lead', meta);
      } catch(err) {}
    }, true);

    // Checkout : clic sur un élément de paiement (lien Stripe, bouton d'achat).
    document.addEventListener('click', function(e) {
      try {
        var t = e.target && e.target.closest ? e.target.closest('a,button,[role=button]') : null;
        if (!t) return;
        var href = (t.getAttribute && t.getAttribute('href')) || '';
        var txt = (t.textContent || '').toLowerCase().slice(0, 80);
        var isPay = /checkout|stripe|buy\\.stripe|paiement|payment|\\/pay/i.test(href)
          || /(acheter|payer|commander|checkout|buy now|add to cart|ajouter au panier|s'abonner|subscribe|souscrire)/.test(txt);
        if (isPay) send('checkout_start', { label: txt });
      } catch(err) {}
    }, true);
  } catch(e) {}
})();
</script>`;
}
