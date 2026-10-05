// ─── Texte montré au client : aucun fournisseur, modèle ni outil interne ─────
//
// [2026-10-04] Demande : « dans le système ou le chat, l'IA ne doit jamais
// parler de Printify ni de comment elle génère les produits — rien ne doit
// fuiter ». Avant, le chat, l'activité des agents et les pop-ups disaient
// « créé sur Printify », « coût Printify réel », « mockup Printify — blueprint
// 384 », « automatique (CJ) », et l'IA (dont le prompt mentionne Printify)
// pouvait le répéter.
//
// Corrigé à la SOURCE : les messages serveur sont réécrits et les prompts du
// chat interdisent de nommer fournisseurs, modèles et outils
// (agents/confidentiality.ts). Ce module est la barrière au POINT DE SORTIE
// (comme error-scrub.ts) pour ce que l'on ne contrôle pas mot à mot : le texte
// écrit par l'IA, et les anciennes lignes déjà en base.
//
// Ce qui n'est JAMAIS modifié (sinon on casserait l'app) :
//   - les URL (http(s)://…) — les photos produits sont hébergées chez le
//     fournisseur ;
//   - les identifiants machine : nom collé à `_`, `.`, `/` ou une lettre
//     (`printify_design`, `printifyProductId`, `x.printify.com`) ; et, dans
//     une réponse JSON, une valeur entière qui est un identifiant
//     (`printify`, `PRINTIFY_API_TOKEN`) ;
//   - les clés techniques (id, url, type, status…) d'une réponse JSON.

import type { Context } from 'hono';
import { proxyMediaUrls, toProxiedMediaUrl } from './media-proxy';

type Rule = [RegExp, string | ((m: string, ...g: string[]) => string)];

// Nom collé à un identifiant (`printify_design`, `printifyProductId`,
// `x.printify.com`) : jamais touché.
const L = '(?<![\\w./@-])';
const R = '(?![\\w@-]|\\.[a-z])';
const w = (s: string) => new RegExp(`${L}(?:${s})${R}`, 'gi');

const SUPPLIER = 'Printify|Printful|CJ ?Dropshipping|CJdropshipping|AliExpress|Alibaba|Zendrop|Spocket';

/** Garde la majuscule initiale du texte remplacé (« Mockup … » → « Aperçu … »). */
const keepCase = (rep: string) => (m: string) => (/^\p{Lu}/u.test(m) ? rep[0].toUpperCase() + rep.slice(1) : rep);

const RULES: Rule[] = [
  // ── Fabrication / fournisseurs ────────────────────────────────────────────
  [/\s*\(?\bblueprint\s*#?\s*\d+\)?/gi, ''],
  // « 🖨️ Printify : … » / « Printify — … » en tête de message → « Création : ».
  [new RegExp(`(^|\\n|\\p{Extended_Pictographic}\\uFE0F?\\s*)(?:${SUPPLIER})(?=\\s*[:—–])`, 'giu'), '$1Création'],
  // « le catalogue Printify » → « le catalogue ».
  [new RegExp(`${L}(catalogues?|catalogs?) (?:de |du |of )?(?:${SUPPLIER})${R}`, 'gi'), '$1'],
  [new RegExp(`${L}(?:${SUPPLIER}) (catalogs?)${R}`, 'gi'), '$1'],
  [new RegExp(`${L}(?:vrai |réel )?produits? (?:${SUPPLIER})${R}\\s*\\(?#?[0-9a-f]{8,}\\)?`, 'gi'), 'produit fabriqué'],
  [new RegExp(`${L}(?:co[uû]ts?|prix) (?:r[ée]el )?(?:${SUPPLIER})(?: r[ée]el)?${R}`, 'gi'), 'coût de fabrication réel'],
  [new RegExp(`${L}(?:mockups?|maquettes?) (?:r[ée]els? )?(?:${SUPPLIER})${R}(?: r[ée]els?)?`, 'gi'), keepCase('aperçu du produit')],
  [new RegExp(`${L}(?:sur|chez|via|par|avec|dans|depuis|de) (?:${SUPPLIER})${R}`, 'gi'), 'chez notre atelier partenaire'],
  [new RegExp(`${L}(?:on|at|via|with|through|by|from|in) (?:${SUPPLIER})${R}`, 'gi'), 'with our production partner'],
  [new RegExp(`${L}produits? (?:${SUPPLIER})${R}`, 'gi'), (m) => (/^produits/i.test(m) ? 'produits fabriqués' : 'produit fabriqué')],
  [/\s*\((?:CJ|Printify|AliExpress)\)/g, ''],
  [new RegExp(`${L}(?:${SUPPLIER})${R}`, 'gi'), 'notre atelier partenaire'],
  // « mockup » trahit la façon dont la photo est produite → « aperçu ».
  [/(?<![\w./@-])(du|le|un) mockup(?![\w@-])/gi, (m, art: string) => {
    const a = art.toLowerCase();
    const r = a === 'du' ? "de l'aperçu" : a === 'le' ? "l'aperçu" : 'un aperçu';
    return /^\p{Lu}/u.test(art) ? r[0].toUpperCase() + r.slice(1) : r;
  }],
  [/(?<![\w./@-])mockups(?![\w@-])/gi, keepCase('aperçus')],
  [/(?<![\w./@-])mockup(?![\w@-])/gi, keepCase('aperçu')],
  // ── Modèles et outils d'IA ────────────────────────────────────────────────
  [/(?<![\w./@-])(?:openai|google|anthropic|meta-llama|x-ai|mistralai|deepseek|qwen|bytedance|fal-ai|black-forest-labs)\/[\w.:-]+/gi, 'Velbaz AI'],
  [w('chat ?gpt|gpt[- ]?\\d[\\w.-]*(?: luna)?|gpt'), 'Velbaz AI'],
  [w('(?:google )?gemini[- ](?:\\d[\\w.-]*|pro|flash|nano|ultra)(?:[- ](?:pro|flash|lite|image|preview))*'), 'Velbaz AI'],
  [w('claude[- ](?:\\d[\\w.-]*|opus|sonnet|haiku)(?:[- ][\\d.]+)?'), 'Velbaz AI'],
  // Seulement des noms sans ambiguïté : « Runway », « Sora », « Imagen » seuls
  // peuvent être un nom de marque client, ils ne sont visés qu'avec leur version.
  [w('nano[- ]banana(?: pro| 2)?|seedream(?: ?v?[\\d.]+)?(?: pro)?|flux(?:[ .-]?\\d[\\w.]*| pro| kontext| schnell| dev)+|stable diffusion(?: xl)?|sdxl|dall-?e(?: ?\\d)?|midjourney|imagen ?\\d|kling(?: ?(?:ai|v?\\d[\\d.]*))?|veo ?\\d[\\w.]*|runway gen-?\\d|sora ?\\d'), 'notre IA'],
  [w('higgsfield|elevenlabs|openrouter|fal\\.ai|replicate\\.com|remove\\.bg|rembg'), 'notre IA'],
  [w('OpenAI|Anthropic|DeepSeek|Mistral AI'), 'Velbaz'],
  [w('Runable'), 'Velbaz'],
  [w('Turso|libsql'), 'notre base de données'],
];

/** Chaîne d'identifiant machine : jamais réécrite (`printify`, `openai/gpt-6-luna`). */
function isMachineToken(s: string): boolean {
  return /^[a-z0-9_.:/@#-]+$/.test(s) || /^[A-Z0-9_]+$/.test(s);
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+|\bdata:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g;

/** Texte destiné au client, sans nom de fournisseur, modèle ou outil. */
export function toCustomerText(input: string): string {
  const s = String(input ?? '');
  if (!s) return s;
  // Les URL sont mises de côté, puis remises telles quelles — sauf celles d'un
  // fournisseur, remplacées par l'adresse Velbaz `/api/img/…` (media-proxy.ts).
  const urls: string[] = [];
  let out = s.replace(URL_RE, (u) => { urls.push(/^https?:/.test(u) ? toProxiedMediaUrl(u) : u); return `\uE000${urls.length - 1}\uE000`; });
  for (const [re, rep] of RULES) out = out.replace(re, rep as any);
  // « chez notre atelier partenaire chez notre atelier partenaire » après deux règles voisines.
  out = out.replace(/(notre atelier partenaire)(?:\s+\1)+/g, '$1');
  return urls.length ? out.replace(/\uE000(\d+)\uE000/g, (_, i) => urls[Number(i)]) : out;
}

// ── Flux (SSE) : un nom peut arriver coupé en deux morceaux (« Print » + « ify ») ──
// On garde au moins TAIL caractères en réserve et on ne coupe que sur un
// espace où « nettoyer la tête puis la queue » donne exactement le même texte
// que « nettoyer le tout » : aucun nom (même en plusieurs mots) ne chevauche
// alors la coupure. Le plus long motif visé fait moins de TAIL caractères.
const TAIL = 80;
const MAX_TRIES = 12;

export function createCustomerTextStream() {
  let buf = '';
  return {
    push(chunk: string): string {
      buf += chunk;
      if (buf.length <= TAIL) return '';
      const whole = toCustomerText(buf);
      let tries = 0;
      for (let i = buf.length - TAIL; i > 0 && tries < MAX_TRIES; i--) {
        if (!/\s/.test(buf[i])) continue;
        tries++;
        const cut = i + 1;
        const headClean = toCustomerText(buf.slice(0, cut));
        const tail = buf.slice(cut);
        if (headClean + toCustomerText(tail) !== whole) continue;
        buf = tail;
        return headClean;
      }
      // Pas de coupure sûre (URL, base64, nom à cheval) : on attend la suite ;
      // `flush()` à la fin du message rend tout.
      return '';
    },
    flush(): string {
      const rest = toCustomerText(buf);
      buf = '';
      return rest;
    },
    reset() { buf = ''; },
  };
}

// ── Réponses JSON ─────────────────────────────────────────────────────────────
/** Clés techniques dont la valeur n'est jamais réécrite. */
const SKIP_KEY = /(?:^|_)(?:id|ids|url|urls|uri|src|href|path|slug|hash|key|keys|token|secret|password|email|type|kind|status|state|source|provider|mode|role|action|phase|category|model|models|tier|code|html|css|diff|patch|files|sku|ref|lang|locale|color|colors|icon|currency)$|(?:Id|Ids|Url|Urls|Uri|Src|Href|Path|Key|Token|Type|Status|Mode|Model|Code)$/;

/** Valeur technique (clé `imageUrl`, identifiant…) : seules les adresses de photos changent. */
function proxyMediaDeep(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') return proxyMediaUrls(value);
  if (Array.isArray(value)) return value.map((v) => proxyMediaDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = proxyMediaDeep(v, depth + 1);
    return out;
  }
  return value;
}

export function toCustomerPayload(value: unknown, key = '', depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') return (key && SKIP_KEY.test(key)) || isMachineToken(value) ? proxyMediaUrls(value) : toCustomerText(value);
  if (Array.isArray(value)) return value.map((v) => toCustomerPayload(v, key, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SKIP_KEY.test(k) ? proxyMediaDeep(v, depth + 1) : toCustomerPayload(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Routes jamais réécrites : admin, code/fichiers et pages du site du client
 * (relus puis réenregistrés par l'éditeur : les réécrire changerait son site),
 * exports, secrets.
 */
const EXEMPT_PATH = /\/(?:admin)(?:\/|$)|\/(?:file-content|file-download|project-file|project-files|secrets|export|website|pages|checkpoints|email-config)(?:\/|$)|\/chimera\/assets\//;

// ── Événements SSE ────────────────────────────────────────────────────────────
// `token` et `draftToken` sont des morceaux de texte mis bout à bout par le
// client : ils passent par un flux tamponné. `draftReset` jette le brouillon ;
// `done` (ou la fin du flux) vide d'abord les tampons.
const STREAM_KEYS = ['token', 'draftToken'] as const;

export function createSseRewriter() {
  const streams: Record<string, ReturnType<typeof createCustomerTextStream>> = {};
  const streamOf = (k: string) => (streams[k] ??= createCustomerTextStream());
  const enc = (obj: unknown) => `data: ${JSON.stringify(obj)}`;

  const flushAll = (): string[] => {
    const out: string[] = [];
    for (const k of STREAM_KEYS) {
      const rest = streams[k]?.flush();
      if (rest) out.push(enc({ [k]: rest }));
    }
    return out;
  };

  /** Réécrit UN bloc SSE (sans le « \n\n » final). Peut en produire plusieurs. */
  const rewriteBlock = (block: string): string[] => {
    const lines = block.split('\n');
    const dataLines = lines.filter((l) => l.startsWith('data:'));
    if (dataLines.length !== 1) return [block];
    const raw = dataLines[0].slice(5).trimStart();
    let obj: any;
    try { obj = JSON.parse(raw); } catch { return [toCustomerText(block)]; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [block];

    const before: string[] = [];
    if (obj.draftReset) streams.draftToken?.reset();
    if (obj.done) before.push(...flushAll());
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if ((STREAM_KEYS as readonly string[]).includes(k) && typeof v === 'string') {
        next[k] = streamOf(k).push(v);
      } else {
        next[k] = SKIP_KEY.test(k) ? proxyMediaDeep(v) : toCustomerPayload(v, k);
      }
    }
    // Un morceau entièrement retenu dans le tampon : on n'envoie pas d'événement vide.
    const onlyStream = Object.keys(obj).every((k) => (STREAM_KEYS as readonly string[]).includes(k));
    if (onlyStream && Object.values(next).every((v) => v === '')) return before;
    const others = lines.filter((l) => !l.startsWith('data:'));
    return [...before, [...others, enc(next)].join('\n')];
  };

  return { rewriteBlock, flushAll };
}

function rewriteSseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const rw = createSseRewriter();
  let pending = '';
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, i);
        pending = pending.slice(i + 2);
        for (const b of rw.rewriteBlock(block)) controller.enqueue(encoder.encode(`${b}\n\n`));
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.trim()) for (const b of rw.rewriteBlock(pending)) controller.enqueue(encoder.encode(`${b}\n\n`));
      for (const b of rw.flushAll()) controller.enqueue(encoder.encode(`${b}\n\n`));
    },
  }));
}

/**
 * Middleware : réécrit le texte des réponses JSON et SSE de l'API pour tout
 * le monde (sauf les routes admin et le code du projet). Les logs serveur
 * gardent les noms réels.
 */
export const isCustomerTextExempt = (path: string) => EXEMPT_PATH.test(path);

export function customerTextGuard() {
  return async (c: Context, next: () => Promise<void>) => {
    await next();
    const res = c.res;
    if (!res?.body || EXEMPT_PATH.test(c.req.path)) return;
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      c.res = new Response(rewriteSseBody(res.body), { status: res.status, statusText: res.statusText, headers });
      return;
    }
    if (!type.includes('application/json')) return;
    const len = Number(res.headers.get('content-length') || '0');
    if (len > 8_000_000) return;
    let text: string;
    try { text = await res.clone().text(); } catch { return; }
    if (text.length > 8_000_000 || !/printify|printful|dropshipping|aliexpress|alibaba|zendrop|spocket|blueprint|gpt|gemini|claude|openai|anthropic|deepseek|mistral|banana|seedream|flux|diffusion|dall|midjourney|imagen|kling|veo|runway|sora|higgsfield|elevenlabs|openrouter|fal\.ai|replicate|remove\.bg|rembg|runable|turso|libsql|\(cj\)|alicdn|fal\.media|higgsfield/i.test(text)) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const cleaned = JSON.stringify(toCustomerPayload(parsed));
    if (cleaned === text) return;
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    c.res = new Response(cleaned, { status: res.status, statusText: res.statusText, headers });
  };
}
