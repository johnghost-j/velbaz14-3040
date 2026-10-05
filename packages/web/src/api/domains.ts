// ─── Domaines personnalisés Velbaz (connexion, vérification DNS, SSL, achat) ──
//
// C'est le SYSTÈME DE RACCORDEMENT D'UN VRAI DOMAINE sur un site généré.
// Trois étages, du plus autonome au plus dépendant d'une clé :
//
//   1. VÉRIFICATION DNS RÉELLE — AUCUNE CLÉ REQUISE.
//      Résolution via DNS-over-HTTPS (Cloudflare 1.1.1.1, repli Google 8.8.8.8).
//      On lit réellement les enregistrements publics du domaine et on compare à
//      la cible attendue. Le statut affiché n'est jamais deviné.
//
//   2. SERVICE DU SITE SUR LE DOMAINE — AUCUNE CLÉ REQUISE.
//      `subdomainForHost()` résout un en-tête Host (domaine personnalisé ou
//      sous-domaine velbaz.site) vers le sous-domaine interne du site. Utilisé
//      par src/server.ts pour servir le bon site dès que le DNS pointe ici.
//
//   3. CERTIFICAT TLS + CDN AUTOMATIQUES — 2 CLÉS (Cloudflare for SaaS).
//      CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID. Sans elles, tout le reste
//      fonctionne : le domaine est enregistré, vérifié, servi en HTTP par
//      l'hébergement Velbaz, et l'UI dit franchement que le HTTPS automatique
//      attend la clé (jamais de faux succès, jamais de blocage).
//
//   4. ACHAT DE DOMAINE — 4 CLÉS (registrar Namecheap), voir REGISTRAR_KEYS.
//      La recherche de disponibilité (RDAP) reste réelle et sans clé.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QU'IL RESTE À FAIRE POUR TOUT AUTOMATISER (rien à coder) :
//   → HTTPS/CDN auto : CLOUDFLARE_API_TOKEN (permission « SSL and Certificates:
//     Edit » sur la zone) + CLOUDFLARE_ZONE_ID, collés dans l'Admin Panel.
//   → Achat de domaine : NAMECHEAP_API_USER, NAMECHEAP_API_KEY,
//     NAMECHEAP_USERNAME, NAMECHEAP_CLIENT_IP.
//   → VELBAZ_DOMAIN_TARGET : la cible CNAME publiée. DOIT exister et mener à
//     Velbaz (fallback origin Cloudflare for SaaS + Worker, voir API-KEYS.md).
//     Défaut : cname.<VELBAZ_ROOT_DOMAIN> — qui n'existe pas tant que rien
//     n'est configuré : la vérification le détecte et le dit.
//   → VELBAZ_EDGE_SECRET : secret partagé avec le Worker (en-tête
//     x-velbaz-site-host). Le statut `live` exige une preuve HTTP réelle.
// ─────────────────────────────────────────────────────────────────────────────

import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from './database/index';
import * as schema from './database/schema';
import { getSecret } from './secret-store';
import { isAdminUser } from './security';
import { namecheapOwnsDomain, namecheapPointToVelbaz, NamecheapError } from './namecheap';

// ── Clés attendues ───────────────────────────────────────────────────────────

/** Cloudflare for SaaS : certificat TLS + routage du domaine client. */
export const DOMAIN_SSL_KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID'] as const;

/** Registrar (achat de domaine) — API Namecheap. */
export const REGISTRAR_KEYS = [
  'NAMECHEAP_API_USER',
  'NAMECHEAP_API_KEY',
  'NAMECHEAP_USERNAME',
  'NAMECHEAP_CLIENT_IP',
] as const;

export function missingSslKeys(): string[] {
  return DOMAIN_SSL_KEYS.filter((k) => !getSecret(k));
}
export function isSslAutomationConfigured(): boolean {
  return missingSslKeys().length === 0;
}
export function missingRegistrarKeys(): string[] {
  return REGISTRAR_KEYS.filter((k) => !getSecret(k));
}
export function isRegistrarConfigured(): boolean {
  return missingRegistrarKeys().length === 0;
}

/** Domaine racine de l'hébergement Velbaz (sous-domaines des sites publiés). */
export function rootDomain(): string {
  return (getSecret('VELBAZ_ROOT_DOMAIN') || 'velbaz.site').toLowerCase().trim();
}

/** Cible CNAME que le client doit créer chez son registrar. */
export function cnameTarget(): string {
  const custom = (getSecret('VELBAZ_DOMAIN_TARGET') || '').toLowerCase().trim();
  return custom || `cname.${rootDomain()}`;
}

// ── Normalisation / validation ───────────────────────────────────────────────

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** Nettoie une saisie utilisateur en nom de domaine nu (sans schéma ni chemin). */
export function normalizeDomain(input: string): string {
  return (input || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\.(?=.+\..+)/, (m) => m) // on garde www. : c'est un hôte valide
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/** Message d'erreur si le domaine est invalide, sinon null. */
export function domainFormatError(domain: string): string | null {
  if (!domain) return 'Nom de domaine manquant.';
  if (domain.length > 253) return 'Nom de domaine trop long.';
  if (!DOMAIN_RE.test(domain)) return 'Nom de domaine invalide (ex. : coffeeroasters.com).';
  if (domain.endsWith(`.${rootDomain()}`) || domain === rootDomain()) {
    return `Ce domaine appartient à l'hébergement Velbaz — utilise le champ Sub-domain.`;
  }
  return null;
}

// Suffixes à deux étiquettes fréquents : "example.co.uk" est un apex, pas un
// sous-domaine. Liste volontairement courte (les cas réellement rencontrés) ;
// une erreur ici ne casse rien, elle change seulement l'instruction affichée
// (A record au lieu de CNAME).
const MULTI_LABEL_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'gov.uk', 'ac.uk', 'co.nz', 'net.nz', 'org.nz',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'co.za', 'co.jp', 'co.in',
  'com.tr', 'com.ar', 'co.kr', 'com.sg', 'com.hk', 'com.cn', 'co.il',
]);

/** Vrai si le domaine est un apex (pas de sous-domaine devant). */
export function isApexDomain(domain: string): boolean {
  const parts = domain.split('.');
  if (parts.length < 2) return false;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_TLDS.has(lastTwo)) return parts.length === 3;
  return parts.length === 2;
}

// ── Résolution DNS réelle via DNS-over-HTTPS (aucune clé) ────────────────────

const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

type DohAnswer = { name: string; type: number; data: string };
const RR = { A: 1, CNAME: 5, TXT: 16, AAAA: 28 } as const;

/**
 * Interroge les résolveurs DoH publics. Renvoie les réponses brutes, ou null si
 * AUCUN résolveur n'a répondu (indéterminé — jamais interprété comme « absent »).
 */
async function dohQuery(name: string, type: keyof typeof RR): Promise<DohAnswer[] | null> {
  for (const base of DOH_ENDPOINTS) {
    try {
      const url = `${base}?name=${encodeURIComponent(name)}&type=${type}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { Status?: number; Answer?: DohAnswer[] };
      // NXDOMAIN (3) = le nom n'existe pas : réponse valide, liste vide.
      if (data.Status === 3) return [];
      if (typeof data.Status === 'number' && data.Status !== 0) continue;
      return data.Answer || [];
    } catch { /* résolveur suivant */ }
  }
  return null;
}

function cleanName(v: string): string {
  return (v || '').toLowerCase().replace(/\.$/, '');
}

/** Enregistrements CNAME d'un nom (chaîne complète telle que renvoyée). */
export async function resolveCname(name: string): Promise<string[] | null> {
  const ans = await dohQuery(name, 'CNAME');
  if (ans === null) return null;
  return ans.filter((a) => a.type === RR.CNAME).map((a) => cleanName(a.data));
}

/** Adresses IPv4 d'un nom (suit les CNAME côté résolveur). */
export async function resolveA(name: string): Promise<string[] | null> {
  const ans = await dohQuery(name, 'A');
  if (ans === null) return null;
  return ans.filter((a) => a.type === RR.A).map((a) => a.data.trim());
}

/** Enregistrements TXT d'un nom (validation de propriété). */
export async function resolveTxt(name: string): Promise<string[] | null> {
  const ans = await dohQuery(name, 'TXT');
  if (ans === null) return null;
  return ans.filter((a) => a.type === RR.TXT).map((a) => a.data.replace(/^"|"$/g, ''));
}

export type DnsRecordSpec = { type: 'CNAME' | 'A' | 'TXT'; name: string; value: string; note?: string };

export type DnsCheck = {
  /** true = le DNS pointe bien ici, false = non, null = indéterminé (résolveurs injoignables). */
  ok: boolean | null;
  apex: boolean;
  target: string;
  /** Ce que l'utilisateur doit créer chez son registrar. */
  expected: DnsRecordSpec[];
  /** Ce qui est réellement publié dans le DNS en ce moment. */
  found: { cname: string[]; a: string[] };
  /** Explication lisible du statut. */
  detail: string;
  /** La cible Velbaz elle-même existe-t-elle dans le DNS ? (null = indéterminé) */
  targetResolves?: boolean | null;
};

/**
 * Vérifie RÉELLEMENT que le domaine pointe vers l'hébergement Velbaz.
 *
 * Accepté :
 *   • CNAME → cible Velbaz (cas normal d'un sous-domaine type www) ;
 *   • A → les mêmes IPs que la cible Velbaz (apex, ou ALIAS/flattening côté
 *     registrar, qui se présente comme un A).
 *
 * Aucune clé API : uniquement du DNS public.
 */
export async function checkDomainDns(domain: string): Promise<DnsCheck> {
  const target = cnameTarget();
  const apex = isApexDomain(domain);
  const [cname, a, targetIps] = await Promise.all([
    resolveCname(domain),
    resolveA(domain),
    resolveA(target),
  ]);

  const expected: DnsRecordSpec[] = [];
  if (apex) {
    if (targetIps && targetIps.length) {
      for (const ip of targetIps) {
        expected.push({ type: 'A', name: '@', value: ip, note: 'Racine du domaine' });
      }
    }
    expected.push({
      type: 'CNAME', name: '@', value: target,
      note: targetIps && targetIps.length
        ? 'Alternative si ton registrar supporte ALIAS/ANAME/CNAME flattening'
        : 'Racine du domaine (ALIAS/ANAME si ton registrar l\'exige)',
    });
    expected.push({ type: 'CNAME', name: 'www', value: target, note: 'Pour que www fonctionne aussi' });
  } else {
    const label = domain.split('.')[0];
    expected.push({ type: 'CNAME', name: label, value: target });
  }

  // Indéterminé : les deux requêtes ont échoué → on ne conclut rien.
  if (cname === null && a === null) {
    return {
      ok: null, apex, target, expected,
      found: { cname: [], a: [] },
      detail: 'Résolveurs DNS injoignables — vérification impossible pour le moment.',
    };
  }

  const foundCname = cname || [];
  const foundA = a || [];
  const targetResolves = targetIps === null ? null : targetIps.length > 0;
  // La cible n'existe pas (NXDOMAIN) : même un CNAME « correct » ne mène nulle
  // part. On le dit au lieu d'annoncer un raccordement qui ne peut pas marcher.
  if (targetResolves === false) {
    return {
      ok: false, apex, target, expected, targetResolves,
      found: { cname: foundCname, a: foundA },
      detail: `La cible Velbaz « ${target} » n'existe pas encore dans le DNS : l'hébergement des domaines n'est pas configuré (admin : VELBAZ_DOMAIN_TARGET + Cloudflare, voir API-KEYS). Le domaine ne peut pas être raccordé tant que cette cible ne répond pas.`,
    };
  }
  const cnameMatch = foundCname.some((v) => v === target || v.endsWith(`.${target}`));
  const ipMatch = !!(targetIps && targetIps.length && foundA.some((ip) => targetIps.includes(ip)));

  let detail: string;
  if (cnameMatch) detail = `CNAME correct → ${target}.`;
  else if (ipMatch) detail = `Enregistrement A correct → ${foundA.join(', ')}.`;
  else if (!foundCname.length && !foundA.length) detail = 'Aucun enregistrement DNS trouvé pour ce nom — ajoute ceux ci-dessous (propagation : 5 min à 24 h).';
  else if (foundCname.length) detail = `Le domaine pointe vers ${foundCname.join(', ')} au lieu de ${target}.`;
  else detail = `Le domaine pointe vers ${foundA.join(', ')}, qui n'est pas l'hébergement Velbaz.`;

  return {
    ok: cnameMatch || ipMatch,
    apex, target, expected, targetResolves,
    found: { cname: foundCname, a: foundA },
    detail,
  };
}

// ── Preuve HTTP : le domaine sert-il VRAIMENT le site ? ───────────────────────
//
// Le DNS qui pointe au bon endroit ne suffit pas : encore faut-il que la
// requête arrive jusqu'à Velbaz avec le bon hôte. On interroge donc le domaine
// lui-même (/api/domains/whoami) et on exige qu'il réponde « je suis Velbaz et
// je sers le site <sous-domaine> ». C'est la seule condition du statut `live`.

export const EDGE_HOST_HEADER = 'x-velbaz-site-host';
export const EDGE_KEY_HEADER = 'x-velbaz-edge-key';

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Hôte « visiteur » d'une requête entrante. Le Worker Cloudflare placé devant
 * Velbaz (domaines clients) transmet l'hôte d'origine dans `x-velbaz-site-host`,
 * accompagné du secret partagé VELBAZ_EDGE_SECRET : sans secret valide l'en-tête
 * est ignoré (pas d'empoisonnement de cache possible depuis l'extérieur).
 */
export function siteHostFromHeaders(get: (name: string) => string | null | undefined): string {
  const edgeHost = get(EDGE_HOST_HEADER);
  if (edgeHost) {
    const secret = getSecret('VELBAZ_EDGE_SECRET');
    if (secret && safeEqual(String(get(EDGE_KEY_HEADER) || ''), secret)) return hostFromHeader(edgeHost);
  }
  return hostFromHeader(get('x-forwarded-host') || get('host'));
}

export type DomainProbe = { ok: boolean; url: string | null; https: boolean; detail: string };

/** Interroge réellement le domaine (HTTPS puis HTTP) et vérifie le site servi. */
export async function probeDomain(domain: string, expectedSub: string | null): Promise<DomainProbe> {
  let lastDetail = 'Le domaine ne répond pas.';
  for (const proto of ['https', 'http'] as const) {
    const url = `${proto}://${domain}/api/domains/whoami`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow', headers: { Accept: 'application/json' } });
      const text = await res.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch { /* pas du JSON : pas Velbaz */ }
      if (!j || j.app !== 'velbaz') {
        lastDetail = `${proto.toUpperCase()} : le domaine répond (HTTP ${res.status}) mais ce n'est pas Velbaz qui répond — le routage vers l'hébergement Velbaz n'est pas en place.`;
        continue;
      }
      if (!j.subdomain) {
        lastDetail = `${proto.toUpperCase()} : Velbaz répond mais ne reconnaît pas l'hôte « ${j.host || domain} » (site non publié, ou l'hôte d'origine n'est pas transmis — VELBAZ_EDGE_SECRET du Worker).`;
        continue;
      }
      if (expectedSub && j.subdomain !== expectedSub) {
        lastDetail = `${proto.toUpperCase()} : le domaine sert un autre site (${j.subdomain}).`;
        continue;
      }
      return { ok: true, url: `${proto}://${domain}`, https: proto === 'https', detail: `Le domaine sert bien le site (${proto.toUpperCase()}).` };
    } catch (e: any) {
      const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'délai dépassé' : (e?.message || 'erreur réseau');
      lastDetail = `${proto.toUpperCase()} injoignable (${reason}).`;
    }
  }
  return { ok: false, url: null, https: false, detail: lastDetail };
}

// ── Cloudflare for SaaS : certificat TLS automatique (2 clés) ────────────────

const CF_API = 'https://api.cloudflare.com/client/v4';

export type CfHostname = {
  id: string;
  hostname: string;
  status: string;                 // pending / active / ...
  sslStatus: string | null;       // pending_validation / active / ...
  ownership: DnsRecordSpec | null;
  validation: DnsRecordSpec[];
};

type CfResult = { ok: true; data: CfHostname } | { ok: false; error: string; status: number };

function cfHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getSecret('CLOUDFLARE_API_TOKEN')}`,
    'Content-Type': 'application/json',
  };
}

function mapCfHostname(h: any): CfHostname {
  const ov = h?.ownership_verification;
  const validation: DnsRecordSpec[] = [];
  for (const v of h?.ssl?.validation_records || []) {
    if (v?.txt_name && v?.txt_value) {
      validation.push({ type: 'TXT', name: v.txt_name, value: v.txt_value, note: 'Validation du certificat TLS' });
    }
  }
  return {
    id: String(h?.id || ''),
    hostname: cleanName(h?.hostname || ''),
    status: String(h?.status || 'unknown'),
    sslStatus: h?.ssl?.status ? String(h.ssl.status) : null,
    ownership: ov?.name && ov?.value
      ? { type: (String(ov.type || 'TXT').toUpperCase() === 'CNAME' ? 'CNAME' : 'TXT'), name: cleanName(ov.name), value: String(ov.value), note: 'Preuve de propriété du domaine' }
      : null,
    validation,
  };
}

async function cfRequest(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: { ...cfHeaders(), ...(init.headers as any || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body?.success !== false, status: res.status, body };
}

function cfError(body: any, status: number): string {
  const first = body?.errors?.[0];
  return first?.message ? `Cloudflare : ${first.message}` : `Cloudflare a refusé la requête (HTTP ${status}).`;
}

/** Crée (ou retrouve) le custom hostname Cloudflare du domaine. */
export async function cfProvisionHostname(domain: string): Promise<CfResult> {
  if (!isSslAutomationConfigured()) {
    return { ok: false, error: 'HTTPS automatique non configuré.', status: 501 };
  }
  const zone = getSecret('CLOUDFLARE_ZONE_ID');
  try {
    const existing = await cfRequest(`/zones/${zone}/custom_hostnames?hostname=${encodeURIComponent(domain)}`, { method: 'GET' });
    if (existing.ok && Array.isArray(existing.body?.result) && existing.body.result.length) {
      return { ok: true, data: mapCfHostname(existing.body.result[0]) };
    }
    const created = await cfRequest(`/zones/${zone}/custom_hostnames`, {
      method: 'POST',
      body: JSON.stringify({
        hostname: domain,
        ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' }, wildcard: false },
      }),
    });
    if (!created.ok) return { ok: false, error: cfError(created.body, created.status), status: 502 };
    return { ok: true, data: mapCfHostname(created.body?.result) };
  } catch (e: any) {
    return { ok: false, error: `Cloudflare injoignable : ${e?.message || 'erreur réseau'}`, status: 502 };
  }
}

/** Relit l'état d'un custom hostname (validation TLS en cours / actif). */
export async function cfHostnameStatus(id: string): Promise<CfResult> {
  if (!isSslAutomationConfigured()) return { ok: false, error: 'HTTPS automatique non configuré.', status: 501 };
  const zone = getSecret('CLOUDFLARE_ZONE_ID');
  try {
    const res = await cfRequest(`/zones/${zone}/custom_hostnames/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!res.ok) return { ok: false, error: cfError(res.body, res.status), status: 502 };
    return { ok: true, data: mapCfHostname(res.body?.result) };
  } catch (e: any) {
    return { ok: false, error: `Cloudflare injoignable : ${e?.message || 'erreur réseau'}`, status: 502 };
  }
}

/** Supprime le custom hostname (appelé à la déconnexion du domaine). */
export async function cfDeleteHostname(id: string): Promise<boolean> {
  if (!isSslAutomationConfigured() || !id) return false;
  const zone = getSecret('CLOUDFLARE_ZONE_ID');
  try {
    const res = await cfRequest(`/zones/${zone}/custom_hostnames/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.ok;
  } catch { return false; }
}

// ── Statut persisté du domaine d'un projet ───────────────────────────────────

export type DomainStatus =
  | 'none'         // aucun domaine connecté
  | 'pending_dns'  // domaine enregistré, DNS pas encore pointé
  | 'verifying'    // DNS OK, certificat TLS en cours d'émission
  | 'live'         // domaine servi (HTTPS actif, ou HTTP si automation absente)
  | 'error';       // dernière tentative en échec (message dans customDomainError)

const STATUS_LABELS: Record<DomainStatus, string> = {
  none: 'Aucun domaine connecté',
  pending_dns: 'En attente du DNS',
  verifying: 'Certificat TLS en cours d\'émission',
  live: 'En ligne',
  error: 'Erreur',
};

export function domainStatusLabel(s: string): string {
  return STATUS_LABELS[(s || 'none') as DomainStatus] || s;
}

function ts(v: any): number | null {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : null;
}

export type DomainState = {
  domain: string | null;
  status: DomainStatus;
  statusLabel: string;
  verifiedAt: number | null;
  checkedAt: number | null;
  ssl: string | null;
  error: string | null;
  target: string;
  apex: boolean;
  /** Enregistrements DNS que l'utilisateur doit créer. */
  records: DnsRecordSpec[];
  /** État réel du DNS lors de la dernière vérification (null si jamais vérifié). */
  dns: DnsCheck | null;
  /** HTTPS automatique (Cloudflare for SaaS) configuré côté admin. */
  sslAutomation: boolean;
  missingSslKeys: string[];
  /** Achat de domaine (registrar) configuré côté admin. */
  registrarConfigured: boolean;
  missingRegistrarKeys: string[];
  /** URL publique du site sur le domaine personnalisé (si en ligne). */
  domainUrl: string | null;
};

/** Construit l'état renvoyé au front à partir des colonnes persistées. */
export function domainState(company: any, dns: DnsCheck | null = null): DomainState {
  const domain = company?.customDomain ? normalizeDomain(company.customDomain) : null;
  const status = (company?.customDomainStatus || (domain ? 'pending_dns' : 'none')) as DomainStatus;
  const apex = domain ? isApexDomain(domain) : false;
  const records = dns?.expected || (domain
    ? (apex
      ? [
        { type: 'CNAME' as const, name: '@', value: cnameTarget(), note: 'Racine du domaine (ALIAS/ANAME si ton registrar l\'exige)' },
        { type: 'CNAME' as const, name: 'www', value: cnameTarget(), note: 'Pour que www fonctionne aussi' },
      ]
      : [{ type: 'CNAME' as const, name: domain.split('.')[0], value: cnameTarget() }])
    : []);
  return {
    domain,
    status,
    statusLabel: domainStatusLabel(status),
    verifiedAt: ts(company?.customDomainVerifiedAt),
    checkedAt: ts(company?.customDomainCheckedAt),
    ssl: company?.customDomainSsl || null,
    error: company?.customDomainError || null,
    target: cnameTarget(),
    apex,
    records,
    dns,
    sslAutomation: isSslAutomationConfigured(),
    missingSslKeys: missingSslKeys(),
    registrarConfigured: isRegistrarConfigured(),
    missingRegistrarKeys: missingRegistrarKeys(),
    // Le schéma suit l'ÉTAT RÉEL du certificat, pas la simple présence des clés :
    // un domaine servi sans certificat émis est annoncé en http, jamais en https.
    domainUrl: domain && status === 'live'
      ? `${company?.customDomainSsl === 'active' ? 'https' : 'http'}://${domain}`
      : null,
  };
}

async function persistDomain(companyId: string, patch: Record<string, any>): Promise<any> {
  await db.update(schema.companies)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.companies.id, companyId));
  return db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
}

/**
 * Vérifie le domaine d'un projet POUR DE VRAI et persiste le résultat :
 *   1. lecture du DNS public (sans clé) ;
 *   2. si le DNS pointe ici et que Cloudflare for SaaS est configuré :
 *      création/relecture du custom hostname → statut TLS réel ;
 *   3. sinon : statut `live` dès que le DNS pointe ici (servi en HTTP par
 *      l'hébergement interne), avec `ssl = 'unmanaged'` pour rester honnête.
 */
export async function refreshDomain(company: any): Promise<{ company: any; state: DomainState }> {
  const domain = company?.customDomain ? normalizeDomain(company.customDomain) : null;
  if (!domain) {
    const updated = await persistDomain(company.id, {
      customDomainStatus: 'none', customDomainSsl: null,
      customDomainError: null, customDomainVerifiedAt: null,
      customDomainCheckedAt: new Date(),
    });
    return { company: updated, state: domainState(updated, null) };
  }

  const dns = await checkDomainDns(domain);
  const patch: Record<string, any> = { customDomainCheckedAt: new Date() };

  if (dns.ok === null) {
    // Indéterminé : on ne dégrade PAS un domaine déjà en ligne.
    patch.customDomainError = dns.detail;
    const updated = await persistDomain(company.id, patch);
    return { company: updated, state: domainState(updated, dns) };
  }

  if (!dns.ok) {
    patch.customDomainStatus = 'pending_dns';
    patch.customDomainVerifiedAt = null;
    patch.customDomainError = dns.detail;
    const updated = await persistDomain(company.id, patch);
    return { company: updated, state: domainState(updated, dns) };
  }

  // DNS correct.
  patch.customDomainVerifiedAt = new Date();
  patch.customDomainError = null;

  // Preuve HTTP réelle : `live` uniquement si le domaine sert VRAIMENT le site.
  clearHostCache(); // le mapping hôte → site vient peut-être de changer
  const probe = await probeDomain(domain, company.subdomain || null);
  const notServed = (): string => (company.published
    ? `DNS correct, mais le domaine ne sert pas encore ton site : ${probe.detail}`
    : 'DNS correct, mais le site n\'est pas publié : publie-le pour qu\'il soit servi sur ce domaine.');

  if (!isSslAutomationConfigured()) {
    // Sans clé Cloudflare : en ligne seulement si le domaine sert réellement le
    // site (HTTP ou HTTPS fourni par l'hébergeur). Sinon : on le dit.
    if (probe.ok) {
      patch.customDomainStatus = 'live';
      patch.customDomainSsl = probe.https ? 'active' : 'unmanaged';
    } else {
      patch.customDomainStatus = 'verifying';
      patch.customDomainSsl = 'unmanaged';
      patch.customDomainError = notServed();
    }
    const updated = await persistDomain(company.id, patch);
    return { company: updated, state: domainState(updated, dns) };
  }

  const cf = company.customDomainProviderId
    ? await cfHostnameStatus(company.customDomainProviderId)
    : await cfProvisionHostname(domain);
  if (!cf.ok) {
    // La clé est là mais Cloudflare refuse : on le dit, sans casser le service
    // HTTP déjà fonctionnel. `ssl = 'failed'` (et non 'unmanaged') pour
    // distinguer « clé absente » de « clé présente mais refusée ».
    patch.customDomainStatus = probe.ok ? 'live' : 'verifying';
    patch.customDomainSsl = probe.ok && probe.https ? 'active' : 'failed';
    patch.customDomainError = probe.ok ? cf.error : `${cf.error} — ${notServed()}`;
    const updated = await persistDomain(company.id, patch);
    return { company: updated, state: domainState(updated, dns) };
  }

  patch.customDomainProviderId = cf.data.id;
  patch.customDomainSsl = cf.data.sslStatus || cf.data.status;
  const sslActive = cf.data.sslStatus === 'active' || cf.data.status === 'active';
  patch.customDomainStatus = sslActive && probe.ok ? 'live' : 'verifying';
  if (sslActive && !probe.ok) patch.customDomainError = notServed();
  const updated = await persistDomain(company.id, patch);
  const state = domainState(updated, dns);
  // Enregistrements de validation supplémentaires demandés par Cloudflare.
  const extra: DnsRecordSpec[] = [];
  if (cf.data.ownership) extra.push(cf.data.ownership);
  extra.push(...cf.data.validation);
  if (extra.length && !sslActive) state.records = [...state.records, ...extra];
  return { company: updated, state };
}

/**
 * Connecte un domaine à un projet (ou le déconnecte si `raw` est vide).
 * Vérifie le format, l'unicité globale, provisionne le TLS si les clés sont là,
 * et lance une première vérification DNS réelle.
 */
export async function connectDomain(company: any, raw: string): Promise<
  { ok: true; company: any; state: DomainState } | { ok: false; error: string; status: number }
> {
  const domain = normalizeDomain(raw);

  // Déconnexion.
  if (!domain) {
    if (company.customDomainProviderId) await cfDeleteHostname(company.customDomainProviderId);
    const updated = await persistDomain(company.id, {
      customDomain: null, customDomainStatus: 'none', customDomainSsl: null,
      customDomainProviderId: null, customDomainError: null,
      customDomainVerifiedAt: null, customDomainCheckedAt: null,
    });
    return { ok: true, company: updated, state: domainState(updated, null) };
  }

  const fmt = domainFormatError(domain);
  if (fmt) return { ok: false, error: fmt, status: 400 };

  // Un domaine ne peut servir qu'un seul site.
  const clash = await db.select({ id: schema.companies.id })
    .from(schema.companies).where(eq(schema.companies.customDomain, domain)).get();
  if (clash && clash.id !== company.id) {
    return { ok: false, error: 'Ce domaine est déjà connecté à un autre projet.', status: 409 };
  }

  // Domaine changé : on libère l'ancien hostname Cloudflare.
  if (company.customDomain && normalizeDomain(company.customDomain) !== domain && company.customDomainProviderId) {
    await cfDeleteHostname(company.customDomainProviderId);
  }

  let updated = await persistDomain(company.id, {
    customDomain: domain,
    customDomainStatus: 'pending_dns',
    customDomainSsl: null,
    customDomainProviderId: company.customDomain && normalizeDomain(company.customDomain) === domain
      ? company.customDomainProviderId : null,
    customDomainError: null,
    customDomainVerifiedAt: null,
  });

  // Provisionne le TLS tout de suite si les clés sont présentes : Cloudflare
  // renvoie alors les enregistrements de validation à afficher immédiatement.
  let extra: DnsRecordSpec[] = [];
  if (isSslAutomationConfigured()) {
    const cf = await cfProvisionHostname(domain);
    if (cf.ok) {
      updated = await persistDomain(company.id, {
        customDomainProviderId: cf.data.id,
        customDomainSsl: cf.data.sslStatus || cf.data.status,
      });
      if (cf.data.ownership) extra.push(cf.data.ownership);
      extra.push(...cf.data.validation);
    } else {
      updated = await persistDomain(company.id, { customDomainError: cf.error });
    }
  }

  const refreshed = await refreshDomain(updated);
  const state = refreshed.state;
  if (extra.length && state.status !== 'live') {
    const seen = new Set(state.records.map((r) => `${r.type}:${r.name}:${r.value}`));
    state.records = [...state.records, ...extra.filter((r) => !seen.has(`${r.type}:${r.name}:${r.value}`))];
  }
  return { ok: true, company: refreshed.company, state };
}

// ── Résolution d'un en-tête Host vers le site à servir ───────────────────────

// Hôtes qui appartiennent à l'application Velbaz elle-même (jamais un site
// client) : on ne doit surtout pas les détourner vers un site publié.
const APP_HOST_PREFIXES = ['www', 'app', 'api', 'admin', 'dashboard', 'preview'];

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/.test(host);
}

/** Normalise un en-tête Host / x-forwarded-host en nom d'hôte nu. */
export function hostFromHeader(raw: string | null | undefined): string {
  return (raw || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

// Cache court : la résolution est faite à CHAQUE requête entrante d'un site
// public, une requête DB par visite serait du gaspillage pur.
const hostCache: Map<string, { at: number; sub: string | null }> =
  ((globalThis as any).__velbaz_host_cache ??= new Map());
const HOST_TTL_MS = 30_000;

/** Vide le cache de résolution d'hôte (après connexion/déconnexion d'un domaine). */
export function clearHostCache(): void {
  hostCache.clear();
}

/**
 * Résout un hôte entrant vers le sous-domaine interne du site à servir.
 * Renvoie null si l'hôte appartient à l'application (ou n'est rattaché à aucun
 * site publié) : l'appelant sert alors l'app Velbaz normalement.
 */
export async function subdomainForHost(rawHost: string): Promise<string | null> {
  const host = hostFromHeader(rawHost);
  if (!host || isLocalHost(host)) return null;
  const root = rootDomain();
  // L'app elle-même (velbaz.site, www.velbaz.site, app.velbaz.site…) et les
  // hôtes de prévisualisation de la plateforme ne sont jamais des sites clients.
  if (host === root) return null;
  if (/\.runable\.(site|app|dev)$/.test(host)) return null;

  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.at < HOST_TTL_MS) return cached.sub;

  let sub: string | null = null;
  if (host.endsWith(`.${root}`)) {
    const label = host.slice(0, -(root.length + 1));
    if (!label.includes('.') && !APP_HOST_PREFIXES.includes(label)) {
      const company = await db.select({ subdomain: schema.companies.subdomain, published: schema.companies.published })
        .from(schema.companies).where(eq(schema.companies.subdomain, label)).get().catch(() => undefined);
      if (company?.published) sub = label;
    }
  } else {
    // Domaine personnalisé : correspondance exacte, puis repli sur l'apex pour
    // que www.example.com serve le site connecté sur example.com.
    const candidates = [host];
    if (host.startsWith('www.')) candidates.push(host.slice(4));
    for (const cand of candidates) {
      const company = await db.select({ subdomain: schema.companies.subdomain, published: schema.companies.published, status: schema.companies.customDomainStatus })
        .from(schema.companies).where(eq(schema.companies.customDomain, cand)).get().catch(() => undefined);
      if (company?.published && company.subdomain) { sub = company.subdomain; break; }
    }
  }

  hostCache.set(host, { at: Date.now(), sub });
  return sub;
}

// ── Routes HTTP ──────────────────────────────────────────────────────────────

export function registerDomainRoutes(
  app: Hono<any>,
  deps: {
    getUser: (c: any) => Promise<any>;
    accessibleCompany: (companyId: string, user: any) => Promise<any>;
  },
) {
  const { getUser, accessibleCompany } = deps;

  /** État global du système de domaines (clés configurées ou non). */
  app.get('/domains/config', async (c) => c.json({
    target: cnameTarget(),
    targetResolves: await resolveA(cnameTarget()).then((ips) => (ips === null ? null : ips.length > 0)).catch(() => null),
    edgeSecretConfigured: !!getSecret('VELBAZ_EDGE_SECRET'),
    rootDomain: rootDomain(),
    sslAutomation: isSslAutomationConfigured(),
    missingSslKeys: missingSslKeys(),
    registrarConfigured: isRegistrarConfigured(),
    missingRegistrarKeys: missingRegistrarKeys(),
  }));

  /**
   * Diagnostic public : quel site est servi pour un hôte donné.
   * Ne révèle rien de sensible (le mapping domaine → site est public par nature)
   * et permet de vérifier un raccordement sans attendre la propagation DNS.
   */
  app.get('/domains/resolve-host', async (c) => {
    const host = hostFromHeader(c.req.query('host') || '');
    if (!host) return c.json({ error: 'Paramètre host manquant.' }, 400);
    const subdomain = await subdomainForHost(host);
    return c.json({ host, subdomain, served: !!subdomain });
  });

  /**
   * « Qui me parle ? » — sondé PAR Velbaz sur le domaine du client pour prouver
   * que la requête arrive bien ici avec le bon hôte (voir probeDomain).
   */
  app.get('/domains/whoami', async (c) => {
    const host = siteHostFromHeaders((n) => c.req.header(n));
    const subdomain = host ? await subdomainForHost(host) : null;
    c.header('Cache-Control', 'no-store');
    return c.json({ app: 'velbaz', host, subdomain, served: !!subdomain });
  });

  /** État du domaine personnalisé du projet (sans requête réseau). */
  app.get('/companies/:id/domain', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const company = await accessibleCompany(c.req.param('id'), user);
    if (!company) return c.json({ error: 'Not found' }, 404);
    return c.json(domainState(company, null));
  });

  /** Vérification DNS + TLS RÉELLE, à la demande (bouton « Vérifier »). */
  app.post('/companies/:id/domain/verify', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const company = await accessibleCompany(c.req.param('id'), user);
    if (!company) return c.json({ error: 'Not found' }, 404);
    if (!company.customDomain) return c.json({ error: 'Aucun domaine connecté à ce projet.' }, 400);
    const { state } = await refreshDomain(company);
    clearHostCache();
    return c.json({ ok: true, ...state });
  });

  /**
   * DNS automatique : si le domaine est dans le compte Namecheap de l'admin
   * (acheté via Velbaz, par ex.), Velbaz écrit lui-même les enregistrements
   * vers la cible, en gardant les autres (MX, TXT…). Action explicite du
   * propriétaire uniquement — c'est une vraie écriture chez Namecheap.
   */
  app.post('/companies/:id/domain/auto-dns', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const company = await accessibleCompany(c.req.param('id'), user);
    if (!company) return c.json({ error: 'Not found' }, 404);
    if (company.userId !== user.id && !isAdminUser(user)) {
      return c.json({ error: 'Seul le propriétaire du projet peut modifier le DNS.' }, 403);
    }
    const domain = company.customDomain ? normalizeDomain(company.customDomain) : '';
    if (!domain) return c.json({ error: 'Aucun domaine connecté à ce projet.' }, 400);
    const missing = missingRegistrarKeys();
    if (missing.length) {
      return c.json({ error: `DNS automatique indisponible : clés Namecheap manquantes (${missing.join(', ')}).`, missingKeys: missing }, 501);
    }
    const target = cnameTarget();
    const ips = await resolveA(target);
    if (!ips || !ips.length) {
      return c.json({ error: `La cible Velbaz « ${target} » n'existe pas encore dans le DNS : configure VELBAZ_DOMAIN_TARGET avant d'écrire le DNS.` }, 409);
    }
    try {
      if (!(await namecheapOwnsDomain(domain))) {
        return c.json({ error: 'Ce domaine n\'est pas dans le compte Namecheap de Velbaz : ajoute les enregistrements à la main chez ton registrar.' }, 400);
      }
      const { records } = await namecheapPointToVelbaz(domain, target);
      const { state } = await refreshDomain(company);
      clearHostCache();
      return c.json({ ok: true, written: records, ...state });
    } catch (e: any) {
      const status = e instanceof NamecheapError ? e.status : 502;
      return c.json({ error: e instanceof NamecheapError ? e.message : `Namecheap injoignable : ${e?.message || 'erreur réseau'}` }, status as any);
    }
  });

  /** Vérification DNS d'un domaine AVANT de le connecter (aperçu). */
  app.get('/companies/:id/domain/preflight', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const company = await accessibleCompany(c.req.param('id'), user);
    if (!company) return c.json({ error: 'Not found' }, 404);
    const domain = normalizeDomain(c.req.query('domain') || '');
    const fmt = domainFormatError(domain);
    if (fmt) return c.json({ error: fmt }, 400);
    const dns = await checkDomainDns(domain);
    return c.json({ domain, ...dns });
  });
}
