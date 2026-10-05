// ─── Garde réseau sortant : anti-SSRF et anti-exfiltration de clés ──────────
//
// L'IA choisit elle-même des URL : `web_open` (Chrome), `http_request` (appel
// d'API avec les clés du projet), le scraper de sites. Une URL peut venir de
// l'utilisateur, mais aussi d'une PAGE WEB lue juste avant (injection de prompt
// indirecte). Deux dangers concrets :
//
//   1. SSRF — l'URL pointe vers le RÉSEAU INTERNE de l'hébergement :
//      http://localhost:4200/api/…, http://169.254.169.254/ (métadonnées du
//      cloud, donc jetons d'infrastructure), http://…​.internal, 10.x, 192.168.x.
//      Le serveur, lui, a le droit d'y aller : c'est sa position qui est volée.
//   2. EXFILTRATION — l'URL est un collecteur (webhook.site, requestbin, ngrok…)
//      et la requête embarque un marqueur {{CLE}} que le serveur remplace par la
//      vraie clé d'API du projet. Un seul appel suffit à voler la clé.
//
// Règle appliquée ici : liste de REFUS explicite (privé/local/métadonnées), plus
// une vérification de l'IP RÉSOLUE (un nom de domaine public peut pointer vers
// 127.0.0.1 — « DNS rebinding » de base), et un durcissement supplémentaire dès
// qu'un secret est embarqué (https obligatoire, collecteurs connus refusés).

import { lookup } from 'node:dns/promises';

export interface UrlVerdict {
  ok: boolean;
  /** Raison lisible, renvoyée telle quelle au modèle et journalisée. */
  reason?: string;
  /** Hôte extrait (pour la journalisation). */
  host?: string;
}

/** Collecteurs de requêtes : leur seul usage est de recevoir des données volées. */
const EXFIL_HOSTS = [
  'webhook.site', 'requestbin.com', 'requestbin.net', 'pipedream.net', 'beeceptor.com',
  'hookbin.com', 'postb.in', 'mocky.io', 'burpcollaborator.net', 'oastify.com',
  'interact.sh', 'oast.pro', 'oast.fun', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
  'localtunnel.me', 'loca.lt', 'serveo.net', 'pastebin.com', 'transfer.sh', 'file.io',
  'termbin.com', 'ix.io', '0x0.st', 'dpaste.com', 'glot.io',
];

const METADATA_IPS = ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'];

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // boucle locale
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 169 && b === 254) return true;         // link-local + métadonnées cloud
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 192 && b === 0) return true;           // 192.0.0.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true;                       // multicast / réservé
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fe80')) return true;           // link-local
  if (/^f[cd]/.test(v)) return true;               // fc00::/7 (unique local)
  if (v.startsWith('::ffff:')) return isPrivateIpv4(v.slice(7)); // IPv4 mappée
  return false;
}

/** Nom d'hôte qui ne peut désigner qu'une machine du réseau de l'hébergement. */
function isInternalName(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.localdomain')) return true;
  if (h.endsWith('.cluster.local') || h.endsWith('.svc')) return true;
  if (!h.includes('.')) return true;               // nom court = résolution interne
  if (METADATA_IPS.includes(h)) return true;
  return false;
}

export interface GuardOptions {
  /** La requête embarque une clé d'API du projet → durcissement maximal. */
  carriesSecret?: boolean;
  /** Vérifier l'IP réellement résolue (défaut : oui). Coûte une résolution DNS. */
  resolveDns?: boolean;
}

/**
 * L'IA a-t-elle le droit d'appeler cette URL ?
 *
 * Refus : schéma autre que http/https, hôte local/privé/métadonnées, IP résolue
 * privée. En plus, si la requête porte un secret : https obligatoire et
 * collecteurs de requêtes refusés.
 */
export async function checkOutboundUrl(rawUrl: string, opts: GuardOptions = {}): Promise<UrlVerdict> {
  let u: URL;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    return { ok: false, reason: `URL invalide : « ${String(rawUrl).slice(0, 120)} »` };
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');

  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, host, reason: `Schéma « ${u.protocol.replace(':', '')} » refusé (seuls http et https sont autorisés).` };
  }

  if (isInternalName(host)) {
    return { ok: false, host, reason: `Hôte interne refusé (« ${host} ») : le réseau privé du serveur et les points de métadonnées de l'hébergeur ne sont pas accessibles.` };
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIpv4(host)) {
    return { ok: false, host, reason: `Adresse IP privée/locale refusée (« ${host} »).` };
  }
  if (host.includes(':') && isPrivateIpv6(host)) {
    return { ok: false, host, reason: `Adresse IPv6 privée/locale refusée (« ${host} »).` };
  }

  if (opts.carriesSecret) {
    if (u.protocol !== 'https:') {
      return { ok: false, host, reason: `Une clé d'API ne part jamais en clair : utilise https (« ${host} »).` };
    }
    const lower = host.toLowerCase();
    if (EXFIL_HOSTS.some((h) => lower === h || lower.endsWith(`.${h}`))) {
      return { ok: false, host, reason: `Destination refusée pour une requête qui contient une clé d'API : « ${host} » est un collecteur de requêtes, pas l'API d'un service. Appelle l'API officielle du service concerné.` };
    }
  }

  // Vérification de l'IP RÉSOLUE : un domaine public peut pointer vers 127.0.0.1.
  if (opts.resolveDns !== false && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':')) {
    try {
      const addrs = await lookup(host, { all: true, verbatim: true });
      for (const a of addrs) {
        const bad = a.family === 6 ? isPrivateIpv6(a.address) : isPrivateIpv4(a.address);
        if (bad) {
          return { ok: false, host, reason: `« ${host} » pointe vers une adresse privée (${a.address}) : refusé (tentative d'accès au réseau interne).` };
        }
      }
    } catch {
      // Résolution impossible : on laisse passer, l'appel échouera de lui-même.
      // Bloquer ici casserait un domaine légitime pendant une panne DNS.
    }
  }

  return { ok: true, host };
}

/** Version synchrone (sans DNS) — pour les chemins qui ne peuvent pas attendre. */
export function checkOutboundUrlSync(rawUrl: string, opts: GuardOptions = {}): UrlVerdict {
  let u: URL;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    return { ok: false, reason: `URL invalide : « ${String(rawUrl).slice(0, 120)} »` };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!/^https?:$/.test(u.protocol)) return { ok: false, host, reason: 'Schéma refusé (http/https uniquement).' };
  if (isInternalName(host)) return { ok: false, host, reason: `Hôte interne refusé (« ${host} »).` };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIpv4(host)) return { ok: false, host, reason: `IP privée refusée (« ${host} »).` };
  if (host.includes(':') && isPrivateIpv6(host)) return { ok: false, host, reason: `IPv6 privée refusée (« ${host} »).` };
  if (opts.carriesSecret) {
    if (u.protocol !== 'https:') return { ok: false, host, reason: "Une clé d'API ne part jamais en clair : https obligatoire." };
    const lower = host.toLowerCase();
    if (EXFIL_HOSTS.some((h) => lower === h || lower.endsWith(`.${h}`))) {
      return { ok: false, host, reason: `Collecteur de requêtes refusé pour une requête portant une clé (« ${host} »).` };
    }
  }
  return { ok: true, host };
}
