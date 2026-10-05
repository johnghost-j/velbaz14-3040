/**
 * CAPTURE DES LEADS RÉELS DEPUIS LES SITES PUBLIÉS
 *
 * [2026-09-17] Trou constaté dans la chaîne de revenu : la balise de mesure
 * détectait bien qu'un formulaire contenant un email avait été soumis (event
 * `lead`), mais elle n'envoyait QUE le marqueur `{form:'...'}` — jamais
 * l'adresse. Autrement dit, un visiteur intéressé laissait son email sur le
 * site d'une société générée, et cet email n'était stocké nulle part : aucun
 * suivi, aucune relance, aucune vente possible. Le compteur de leads montait,
 * la valeur partait à la poubelle.
 *
 * La plupart des sites générés n'ont d'ailleurs aucun backend derrière leurs
 * formulaires : ce module EST le mécanisme de collecte réel, pas un doublon.
 *
 * Sécurité : l'endpoint de collecte est public et non authentifié (les
 * visiteurs d'un site publié ne sont pas des utilisateurs Velbaz). Tout ce qui
 * arrive ici est donc hostile par défaut — d'où la validation stricte, la
 * normalisation, le refus des domaines jetables, le plafond de taille et la
 * déduplication.
 *
 * RGPD : l'adresse est fournie volontairement par le visiteur dans un
 * formulaire de contact de l'entreprise — base légale = intérêt légitime /
 * consentement pour la mise en relation demandée. On journalise l'origine du
 * consentement dans `sourceDetail`, et tout email sortant porte un lien de
 * désinscription (voir `unsubscribeToken`).
 */

import { createHash } from 'crypto';

/** Taille maximale acceptée pour un champ texte libre venant du navigateur. */
const MAX_FIELD = 200;

/**
 * Domaines jetables les plus courants. Un lead jetable pollue la base et fait
 * croire à de la traction inexistante ; il ne convertira jamais.
 * Liste volontairement courte : bloquer trop large reviendrait à refuser de
 * vrais clients.
 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'yopmail.com', 'guerrillamail.com', 'sharklasers.com',
  '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'trashmail.com',
  'throwawaymail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
  'fakeinbox.com', 'mailnesia.com', 'mintemail.com', 'spam4.me',
]);

/**
 * Adresses techniques : ce ne sont pas des prospects mais des boîtes
 * fonctionnelles, souvent récoltées par des robots qui remplissent les
 * formulaires. Les relancer commercialement génère des plaintes pour spam.
 */
const ROLE_LOCALPARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster',
  'abuse', 'mailer-daemon', 'bounce', 'bounces', 'spam',
]);

export type LeadRejection =
  | 'missing'
  | 'too_long'
  | 'bad_format'
  | 'disposable'
  | 'role_address'
  | 'honeypot';

export interface NormalizedLead {
  ok: true;
  email: string;
  domain: string;
  name: string | null;
}
export interface RejectedLead {
  ok: false;
  reason: LeadRejection;
}

/**
 * Valide et normalise une adresse soumise par un visiteur.
 *
 * La normalisation (minuscules + trim) est indispensable à la déduplication :
 * `Jean@Site.be` et `jean@site.be` sont la même personne, et sans ça la même
 * personne créerait un lead à chaque visite.
 *
 * On ne touche PAS aux points ni au `+tag` du local-part : chez la plupart des
 * fournisseurs ils sont significatifs, et « corriger » l'adresse d'un vrai
 * prospect la rendrait injoignable.
 */
export function normalizeLeadEmail(raw: unknown, nameRaw?: unknown): NormalizedLead | RejectedLead {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'missing' };
  if (raw.length > MAX_FIELD) return { ok: false, reason: 'too_long' };

  const email = raw.trim().toLowerCase();
  // Format : un seul @, pas d'espace, un point dans le domaine. Volontairement
  // proche de la validation d'inscription pour ne pas avoir deux définitions
  // divergentes de « email valide » dans le produit.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { ok: false, reason: 'bad_format' };
  }
  // Un `..` ou un point en bord de local-part est invalide (RFC 5322) et
  // typique des adresses fabriquées par des robots.
  const [local, domain] = email.split('@');
  if (local.startsWith('.') || local.endsWith('.') || email.includes('..')) {
    return { ok: false, reason: 'bad_format' };
  }
  if (DISPOSABLE_DOMAINS.has(domain)) return { ok: false, reason: 'disposable' };
  if (ROLE_LOCALPARTS.has(local)) return { ok: false, reason: 'role_address' };

  let name: string | null = null;
  if (typeof nameRaw === 'string' && nameRaw.trim() !== '') {
    // Le nom est du texte libre affiché ensuite dans le CRM : on retire les
    // balises ENTIÈRES (sinon `<b>Jean</b>` devient « bJean/b », illisible pour
    // le commercial), puis les chevrons résiduels et les caractères de contrôle.
    name = nameRaw.trim().slice(0, MAX_FIELD)
      .replace(/<[^>]*>/g, '')
      .replace(/[<>\u0000-\u001f\u007f]/g, '')
      .trim();
    if (name === '') name = null;
  }

  return { ok: true, email, domain, name };
}

/** Taille maximale du message libre laissé dans le formulaire. */
const MAX_MESSAGE = 1000;

/**
 * Nettoie le message laissé dans le formulaire.
 *
 * C'est la demande réelle du prospect : sans elle, l'agent le rappelle sans
 * savoir de quoi il s'agit. Elle est stockée dans les notes du lead et relue
 * dans des prompts, donc on retire les caractères de contrôle et on plafonne
 * la taille (un robot peut poster des mégaoctets).
 */
export function sanitizeLeadMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (s === '') return null;
  return s.slice(0, MAX_MESSAGE);
}

/**
 * Score initial d'un lead entrant.
 *
 * Un lead venant d'un formulaire du site est bien plus chaud qu'un contact
 * importé : il a agi de lui-même. Le score sert au tri des relances, donc il
 * doit refléter cette intention plutôt que rester à la valeur par défaut.
 */
export function scoreInboundLead(opts: {
  channel?: string | null;
  pageviews?: number;
  checkoutStarted?: boolean;
}): number {
  let score = 70; // inbound volontaire : nettement au-dessus du défaut (50)
  // Un visiteur qui a ouvert le paiement avant de laisser son email est à un
  // pas de l'achat : c'est le signal le plus fort disponible.
  if (opts.checkoutStarted) score += 20;
  // Plusieurs pages vues = intérêt réel, pas un rebond.
  const pv = opts.pageviews || 0;
  if (pv >= 5) score += 10;
  else if (pv >= 2) score += 5;
  // Le trafic payant convertit statistiquement moins bien que l'organique ou
  // le direct, qui traduisent une démarche active.
  if (opts.channel === 'paid') score -= 10;
  if (opts.channel === 'organic' || opts.channel === 'direct') score += 5;
  return Math.max(1, Math.min(100, score));
}

/**
 * Jeton de désinscription : dérivé de l'email + société + secret serveur.
 *
 * Déterministe pour qu'un lien de désinscription reste valable indéfiniment
 * (un lien mort dans un vieil email est une infraction, pas un détail), et non
 * devinable pour qu'on ne puisse pas désinscrire quelqu'un d'autre ni énumérer
 * la base.
 */
export function unsubscribeToken(companyId: string, email: string, secret: string): string {
  return createHash('sha256')
    .update(`unsub:${companyId}:${email.trim().toLowerCase()}:${secret || 'velbaz-fallback'}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Email de première réponse envoyé automatiquement au lead.
 *
 * Répondre dans la minute est le seul levier de conversion qui ne coûte rien :
 * un prospect laissé 24 h sans réponse est déjà chez un concurrent. Le contenu
 * reste sobre et honnête — il annonce un rappel humain, ne promet pas une
 * commande, et porte le lien de désinscription exigé par le RGPD.
 */
export function welcomeEmail(opts: {
  companyName: string;
  leadName?: string | null;
  siteUrl?: string | null;
  unsubscribeUrl: string;
}): { subject: string; html: string; text: string } {
  const who = opts.leadName ? ` ${opts.leadName}` : '';
  const subject = `Merci pour votre message — ${opts.companyName}`;
  const siteLine = opts.siteUrl ? `\n\nEn attendant : ${opts.siteUrl}` : '';
  const text = `Bonjour${who},

Merci de nous avoir contactés. Votre demande est bien arrivée chez ${opts.companyName} et nous revenons vers vous très rapidement.

Si votre demande est urgente, répondez simplement à cet email : il arrive directement chez nous.${siteLine}

— L'équipe ${opts.companyName}

Pour ne plus recevoir nos emails : ${opts.unsubscribeUrl}`;

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2330">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 26px;box-shadow:0 1px 3px rgba(20,20,40,.08)">
<p style="margin:0 0 14px;font-size:16px">Bonjour${esc(who)},</p>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55">Merci de nous avoir contactés. Votre demande est bien arrivée chez <strong>${esc(opts.companyName)}</strong> et nous revenons vers vous très rapidement.</p>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55">Si votre demande est urgente, répondez simplement à cet email : il arrive directement chez nous.</p>
${opts.siteUrl ? `<p style="margin:0 0 20px"><a href="${esc(opts.siteUrl)}" style="display:inline-block;background:#6d5efc;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-size:15px">Revenir sur le site</a></p>` : ''}
<p style="margin:0;font-size:15px">— L'équipe ${esc(opts.companyName)}</p>
</div>
<p style="max-width:520px;margin:14px auto 0;font-size:12px;color:#8a8fa3;text-align:center">
Vous recevez cet email car vous avez laissé vos coordonnées sur le site de ${esc(opts.companyName)}.
<a href="${esc(opts.unsubscribeUrl)}" style="color:#8a8fa3">Se désinscrire</a>.
</p></body></html>`;

  return { subject, html, text };
}
