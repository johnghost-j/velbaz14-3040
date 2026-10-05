// ─── Expéditeur d'un site généré ─────────────────────────────────────────────
// Les emails partis d'un site généré (réponse à un lead, confirmation de
// commande, suivi de colis, notif de formulaire…) doivent porter le nom DU SITE,
// jamais « Velbaz ». Les emails de la plateforme (reset mot de passe, invitation,
// projet prêt) gardent l'expéditeur par défaut et n'utilisent PAS ce module.
//
// Ordre de résolution de l'adresse :
//   1. email_config.from_email de l'entreprise (configurée par le propriétaire,
//      domaine à vérifier chez le provider) ;
//   2. secret SITE_EMAIL_DOMAIN (domaine d'envoi vérifié commun à tous les
//      sites) → <sous-domaine-du-site>@SITE_EMAIL_DOMAIN ;
//   3. sinon on ne renvoie que le NOM : email-provider le combine avec l'adresse
//      par défaut (RESEND_FROM) — Resend accepte un nom d'affichage libre.

import { getSecret } from './secret-store';

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function isEmailAddress(s: unknown): s is string {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
}

/** Nom d'affichage sûr pour un en-tête From (pas de guillemets, chevrons, retours ligne). */
export function cleanDisplayName(name: unknown): string {
  return String(name ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["<>\\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Partie locale d'adresse à partir du sous-domaine ou du nom du site. */
export function senderLocalPart(company: { subdomain?: string | null; name?: string | null }): string {
  const raw = String(company.subdomain || company.name || 'contact');
  const slug = raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'contact';
}

export interface SiteSenderCompany {
  name?: string | null;
  subdomain?: string | null;
  websiteLinks?: string | null;
}

export interface SiteSenderConfig {
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
}

export interface SiteSender {
  /** Valeur pour SendEmailInput.from : `"Nom" <adresse>` ou juste `Nom`. */
  from: string;
  displayName: string;
  /** Adresse explicite (config ou SITE_EMAIL_DOMAIN), sinon null. */
  address: string | null;
  replyTo?: string;
}

function linksEmail(raw?: string | null): string | undefined {
  try {
    const links = raw ? JSON.parse(raw) : null;
    return isEmailAddress(links?.email) ? links.email.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Calcul pur (testable) de l'expéditeur d'un site. */
export function buildSiteSender(
  company: SiteSenderCompany,
  cfg?: SiteSenderConfig | null,
  ownerEmail?: string | null,
  siteDomain: string = getSecret('SITE_EMAIL_DOMAIN') || '',
): SiteSender {
  const displayName = cleanDisplayName(cfg?.fromName) || cleanDisplayName(company.name) || 'Contact';
  let address: string | null = null;
  if (isEmailAddress(cfg?.fromEmail)) address = cfg!.fromEmail!.trim();
  else {
    const domain = siteDomain.trim().replace(/^@/, '').toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) address = `${senderLocalPart(company)}@${domain}`;
  }
  const replyTo = (isEmailAddress(cfg?.replyTo) ? cfg!.replyTo!.trim() : undefined)
    || linksEmail(company.websiteLinks)
    || (isEmailAddress(ownerEmail) ? ownerEmail.trim() : undefined);
  return {
    from: address ? `"${displayName}" <${address}>` : displayName,
    displayName,
    address,
    replyTo,
  };
}
