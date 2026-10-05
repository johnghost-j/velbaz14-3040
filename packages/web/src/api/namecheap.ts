// ─── Namecheap : achat de domaine + DNS automatique vers Velbaz ───────────────
//
// Deux choses que l'ancien code ne faisait pas, et qui empêchaient un domaine
// acheté via Velbaz de « vraiment se connecter » :
//   1. `namecheap.domains.create` exige les coordonnées du titulaire
//      (Registrant/Tech/Admin/AuxBilling). On reprend l'adresse par défaut du
//      compte Namecheap (users.address.getList/getInfo) : aucune saisie.
//   2. Après l'achat, le DNS du domaine ne pointait nulle part. On écrit les
//      enregistrements vers la cible Velbaz (ALIAS @ + CNAME www) avec
//      `domains.dns.setHosts`, en CONSERVANT les autres enregistrements
//      (MX, TXT…) : setHosts remplace tout, donc on relit d'abord getHosts.
//
// Clés : NAMECHEAP_API_USER, NAMECHEAP_API_KEY, NAMECHEAP_USERNAME,
// NAMECHEAP_CLIENT_IP (IP du serveur, à autoriser dans Namecheap → API Access).

import { getSecret } from './secret-store';

const NC_API = 'https://api.namecheap.com/xml.response';

const MULTI_LABEL_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'gov.uk', 'ac.uk', 'co.nz', 'net.nz', 'org.nz',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'co.za', 'co.jp', 'co.in',
  'com.tr', 'com.ar', 'co.kr', 'com.sg', 'com.hk', 'com.cn', 'co.il',
]);

export class NamecheapError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

function xmlDecode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Découpe un nom en { sld, tld, host } au sens Namecheap. */
export function splitDomain(domain: string): { sld: string; tld: string; host: string; apex: string } {
  const parts = domain.toLowerCase().replace(/\.$/, '').split('.');
  const lastTwo = parts.slice(-2).join('.');
  const tldLabels = MULTI_LABEL_TLDS.has(lastTwo) ? 2 : 1;
  const tld = parts.slice(-tldLabels).join('.');
  const sld = parts[parts.length - tldLabels - 1] || '';
  const hostParts = parts.slice(0, parts.length - tldLabels - 1);
  return { sld, tld, host: hostParts.length ? hostParts.join('.') : '@', apex: `${sld}.${tld}` };
}

function globalParams(command: string): Record<string, string> {
  return {
    ApiUser: getSecret('NAMECHEAP_API_USER'),
    ApiKey: getSecret('NAMECHEAP_API_KEY'),
    UserName: getSecret('NAMECHEAP_USERNAME') || getSecret('NAMECHEAP_API_USER'),
    ClientIp: getSecret('NAMECHEAP_CLIENT_IP'),
    Command: command,
  };
}

/** Appel Namecheap brut ; lève NamecheapError sur Status="ERROR". */
export async function ncCall(command: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<string> {
  const all = new URLSearchParams({ ...globalParams(command), ...params });
  const res = method === 'POST'
    ? await fetch(NC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: all.toString(),
      signal: AbortSignal.timeout(30000),
    })
    : await fetch(`${NC_API}?${all.toString()}`, { signal: AbortSignal.timeout(30000) });
  const xml = await res.text();
  if (!res.ok || /Status="ERROR"/i.test(xml)) {
    const msg = xml.match(/<Error[^>]*>([^<]+)<\/Error>/i)?.[1];
    throw new NamecheapError(msg ? `Namecheap : ${xmlDecode(msg)}` : `Refus du registrar (HTTP ${res.status}).`);
  }
  return xml;
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m ? xmlDecode(m[1]).trim() : '';
}

const CONTACT_FIELDS = [
  'FirstName', 'LastName', 'Organization', 'JobTitle', 'Address1', 'Address2',
  'City', 'StateProvince', 'StateProvinceChoice', 'PostalCode', 'Country', 'Phone', 'EmailAddress',
] as const;

/**
 * Coordonnées du titulaire, reprises de l'adresse par défaut du compte
 * Namecheap. Lecture seule. Renvoie les 4 rôles exigés par domains.create.
 */
export async function namecheapContactParams(): Promise<Record<string, string>> {
  const list = await ncCall('namecheap.users.address.getList', {});
  const ids = [...list.matchAll(/<List\s+[^>]*AddressId="(\d+)"[^>]*\/?>/gi)].map((m) => m[1]);
  if (!ids.length) {
    throw new NamecheapError('Aucune adresse enregistrée dans le compte Namecheap : ajoute-en une (Profile → Addresses) — elle sert de titulaire des domaines achetés.', 400);
  }
  let info = '';
  for (const id of ids) {
    const xml = await ncCall('namecheap.users.address.getInfo', { AddressId: id });
    if (!info) info = xml;
    if (/<Default_YN>\s*true\s*<\/Default_YN>/i.test(xml)) { info = xml; break; }
  }
  const c: Record<string, string> = {
    FirstName: tag(info, 'FirstName'),
    LastName: tag(info, 'LastName'),
    Organization: tag(info, 'Organization'),
    JobTitle: tag(info, 'JobTitle'),
    Address1: tag(info, 'Address1'),
    Address2: tag(info, 'Address2'),
    City: tag(info, 'City'),
    StateProvince: tag(info, 'StateProvince') || tag(info, 'StateProvinceChoice'),
    StateProvinceChoice: tag(info, 'StateProvinceChoice'),
    PostalCode: tag(info, 'Zip'),
    Country: tag(info, 'Country'),
    Phone: tag(info, 'Phone'),
    EmailAddress: tag(info, 'EmailAddress'),
  };
  const missing = ['FirstName', 'LastName', 'Address1', 'City', 'StateProvince', 'PostalCode', 'Country', 'Phone', 'EmailAddress'].filter((k) => !c[k]);
  if (missing.length) {
    throw new NamecheapError(`Adresse Namecheap incomplète (${missing.join(', ')}) : complète-la dans Profile → Addresses.`, 400);
  }
  const out: Record<string, string> = {};
  for (const role of ['Registrant', 'Tech', 'Admin', 'AuxBilling']) {
    for (const f of CONTACT_FIELDS) if (c[f]) out[`${role}${f}`] = c[f];
  }
  return out;
}

/** Achat réel du domaine (facturé sur le compte Namecheap). */
export async function namecheapRegister(domain: string, years: number): Promise<void> {
  const contacts = await namecheapContactParams();
  await ncCall('namecheap.domains.create', {
    DomainName: domain,
    Years: String(Math.min(Math.max(Math.round(years) || 1, 1), 10)),
    AddFreeWhoisguard: 'yes',
    WGEnabled: 'yes',
    ...contacts,
  }, 'POST');
}

export type NcHost = { name: string; type: string; address: string; mxPref?: string; ttl?: string };

export async function namecheapGetHosts(domain: string): Promise<{ hosts: NcHost[]; usingOurDns: boolean }> {
  const { sld, tld } = splitDomain(domain);
  const xml = await ncCall('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
  const usingOurDns = /IsUsingOurDNS="true"/i.test(xml);
  const hosts: NcHost[] = [];
  for (const m of xml.matchAll(/<host\s+([^>]*?)\/?>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1].toLowerCase()] = xmlDecode(a[2]);
    if (!attrs.name || !attrs.type) continue;
    hosts.push({ name: attrs.name, type: attrs.type.toUpperCase(), address: attrs.address || '', mxPref: attrs.mxpref, ttl: attrs.ttl });
  }
  return { hosts, usingOurDns };
}

/**
 * Plan des enregistrements à écrire : on remplace seulement ce qui occupe les
 * noms servis par Velbaz (A/AAAA/CNAME/ALIAS/URL sur @ et www, ou sur le
 * sous-domaine), et on garde tout le reste (MX, TXT, autres sous-domaines…).
 * Fonction pure, testée.
 */
export function planVelbazHosts(domain: string, target: string, existing: NcHost[]): NcHost[] {
  const { host } = splitDomain(domain);
  const names = host === '@' ? ['@', 'www'] : [host];
  const routing = new Set(['A', 'AAAA', 'CNAME', 'ALIAS', 'URL', 'URL301', 'FRAME']);
  const kept = existing.filter((h) => !(names.includes(h.name.toLowerCase()) && routing.has(h.type.toUpperCase())));
  const dot = target.endsWith('.') ? target : `${target}.`;
  const ours: NcHost[] = host === '@'
    ? [
      { name: '@', type: 'ALIAS', address: dot, ttl: '300' },
      { name: 'www', type: 'CNAME', address: dot, ttl: '300' },
    ]
    : [{ name: host, type: 'CNAME', address: dot, ttl: '300' }];
  return [...kept, ...ours];
}

/**
 * Fait pointer le domaine (géré chez Namecheap, DNS Namecheap) vers Velbaz.
 * Écrit réellement chez Namecheap — n'appeler que sur action de l'utilisateur.
 */
export async function namecheapPointToVelbaz(domain: string, target: string): Promise<{ records: NcHost[] }> {
  const { sld, tld } = splitDomain(domain);
  const { hosts, usingOurDns } = await namecheapGetHosts(domain);
  if (!usingOurDns) {
    throw new NamecheapError('Ce domaine n\'utilise pas le DNS Namecheap (serveurs de noms personnalisés) : ajoute les enregistrements chez ton hébergeur DNS.', 400);
  }
  const plan = planVelbazHosts(domain, target, hosts);
  const params: Record<string, string> = { SLD: sld, TLD: tld };
  plan.forEach((h, i) => {
    const n = i + 1;
    params[`HostName${n}`] = h.name;
    params[`RecordType${n}`] = h.type;
    params[`Address${n}`] = h.address;
    if (h.ttl) params[`TTL${n}`] = h.ttl;
    if (h.type === 'MX' && h.mxPref) params[`MXPref${n}`] = h.mxPref;
  });
  if (plan.some((h) => h.type === 'MX')) params.EmailType = 'MX';
  const xml = await ncCall('namecheap.domains.dns.setHosts', params, 'POST');
  if (!/IsSuccess="true"/i.test(xml)) throw new NamecheapError('Namecheap n\'a pas confirmé l\'écriture du DNS.');
  return { records: plan.slice(-(splitDomain(domain).host === '@' ? 2 : 1)) };
}

/** Le domaine fait-il partie du compte Namecheap configuré ? (lecture seule) */
export async function namecheapOwnsDomain(domain: string): Promise<boolean> {
  const { apex } = splitDomain(domain);
  const xml = await ncCall('namecheap.domains.getList', { SearchTerm: apex, PageSize: '20' });
  return new RegExp(`Name="${apex.replace(/\./g, '\\.')}"`, 'i').test(xml);
}
