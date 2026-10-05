// ─── Sécurité des apps générées ─────────────────────────────────────────────
// [2026-10-01] Les trois failles classiques d'une app « vibe-codée » :
//   1. UPLOAD non contrôlé → un fichier .php/.jsp/.html/.svg déposé puis exécuté
//      ou servi depuis l'origine du site (prise de contrôle / XSS stocké).
//   2. WEBHOOK de paiement non signé → n'importe qui « confirme » un paiement.
//   3. XSS → du HTML/JS glissé dans un commentaire, un pseudo… et exécuté chez
//      tous les visiteurs (vol de session = fuite de données).
//
// Ce module fournit :
//   - server/uploads.ts  : upload sécurisé (liste blanche, octets magiques,
//                          taille max, extensions dangereuses bloquées, nom
//                          aléatoire, stockage hors public/, service en nosniff
//                          + CSP sandbox) ;
//   - src/lib/security.ts: sanitizeHtml / safeUrl / safeJson / uploadFile ;
//   - hardenGeneratedCode: filet déterministe — tout dangerouslySetInnerHTML
//                          dynamique écrit par l'IA passe par sanitizeHtml ;
//   - ensureSecurityMounted: branche l'upload + les en-têtes de sécurité dans
//                          le server/index.ts d'un projet EXISTANT.
// Les deux fichiers sont des fichiers d'INFRA (cf. runner.ts) : le contenu
// appartient au code Velbaz, il est réimposé à chaque démarrage d'aperçu.

export const SERVER_UPLOADS = String.raw`// Upload SÉCURISÉ — fichier géré par Velbaz (réécrit à chaque démarrage).
// Règles : liste blanche de types, type RÉEL vérifié sur les octets (pas sur
// l'extension ni le Content-Type annoncé), 5 Mo max, extensions exécutables
// refusées, nom aléatoire, stockage HORS de public/ (jamais exécuté), service
// en nosniff + CSP sandbox.
import { Hono } from "hono";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const uploadRoute = new Hono();

const DIR = ".data/uploads";
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", pdf: "application/pdf",
};
const BLOCKED_EXT = /^(php\d?|phtml|phar|pht|jsp|jspx|jsw|jsv|jspf|asp|aspx|ashx|asmx|cer|cgi|pl|py|rb|sh|bash|zsh|bat|cmd|ps1|vbs|exe|dll|msi|com|scr|jar|war|js|mjs|cjs|ts|tsx|jsx|html?|xhtml|shtml|svg|svgz|xml|xsl|swf|htaccess|htpasswd|config|ini)$/i;

function sniff(b: Uint8Array): string | null {
  const at = (i: number, s: string) => s.split("").every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, "PNG") && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (at(4, "ftyp") && (at(8, "avif") || at(8, "avis"))) return "avif";
  if (at(0, "%PDF-")) return "pdf";
  return null;
}

// Code serveur/navigateur caché dans un fichier « image » (polyglotte).
function hasEmbeddedCode(b: Uint8Array): boolean {
  const txt = Buffer.from(b.subarray(0, Math.min(b.length, 2 * 1024 * 1024))).toString("latin1");
  return /<\?php|<\?=|<%@|<%=|<script[\s>]|javascript:/i.test(txt);
}

export type UploadCheck = { ok: true; ext: string; mime: string } | { ok: false; status: number; error: string };

export function checkUpload(bytes: Uint8Array, originalName = "", declaredType = ""): UploadCheck {
  if (!bytes.length) return { ok: false, status: 400, error: "Fichier vide." };
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, status: 413, error: "Fichier trop lourd (5 Mo maximum)." };
  const parts = String(originalName || "").toLowerCase().split(".").slice(1);
  if (parts.some((p) => BLOCKED_EXT.test(p.trim()))) return { ok: false, status: 415, error: "Type de fichier interdit." };
  const ext = sniff(bytes);
  if (!ext) return { ok: false, status: 415, error: "Type non accepté : PNG, JPEG, WebP, GIF, AVIF ou PDF uniquement." };
  const declared = String(declaredType || "").toLowerCase().split(";")[0].trim();
  if (declared && declared !== "application/octet-stream" && declared !== TYPES[ext] && !(ext === "jpg" && declared === "image/jpg")) {
    return { ok: false, status: 415, error: "Le contenu du fichier ne correspond pas à son type." };
  }
  if (ext !== "pdf" && hasEmbeddedCode(bytes)) return { ok: false, status: 415, error: "Fichier refusé (contenu suspect)." };
  return { ok: true, ext, mime: TYPES[ext] };
}

const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30;
}

uploadRoute.post("/upload", async (c) => {
  const ip = (c.req.header("x-forwarded-for") || "").split(",")[0].trim() || "local";
  if (rateLimited(ip)) return c.json({ error: "Trop d'envois, réessaie dans quelques minutes." }, 429);
  const len = Number(c.req.header("content-length") || 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) return c.json({ error: "Fichier trop lourd (5 Mo maximum)." }, 413);

  let bytes: Uint8Array | null = null;
  let name = "";
  let type = "";
  const ct = (c.req.header("content-type") || "").toLowerCase();
  try {
    if (ct.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const f: any = form["file"];
      if (f && typeof f === "object" && typeof f.arrayBuffer === "function") {
        bytes = new Uint8Array(await f.arrayBuffer());
        name = String(f.name || "");
        type = String(f.type || "");
      }
    } else {
      const body: any = await c.req.json().catch(() => ({}));
      const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/is.exec(String(body?.dataUrl || ""));
      if (m) { bytes = new Uint8Array(Buffer.from(m[2], "base64")); type = m[1]; name = String(body?.name || ""); }
    }
  } catch {
    return c.json({ error: "Envoi illisible." }, 400);
  }
  if (!bytes) return c.json({ error: "Aucun fichier reçu (champ « file »)." }, 400);

  const check = checkUpload(bytes, name, type);
  if (!check.ok) return c.json({ error: check.error }, check.status as any);

  const id = randomUUID() + "." + check.ext;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, id), bytes);
  return c.json({ ok: true, id, path: "/files/" + id, type: check.mime, size: bytes.length }, 201);
});

uploadRoute.get("/files/:id", (c) => {
  const id = c.req.param("id");
  const m = /^[0-9a-f-]{36}\.(png|jpg|webp|gif|avif|pdf)$/.exec(id);
  if (!m) return c.json({ error: "not_found" }, 404);
  const full = join(DIR, id);
  if (!existsSync(full)) return c.json({ error: "not_found" }, 404);
  const ext = m[1];
  return new Response(readFileSync(full), {
    status: 200,
    headers: {
      "Content-Type": TYPES[ext],
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Content-Disposition": ext === "pdf" ? 'attachment; filename="' + id + '"' : "inline",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});
`;

export const SECURITY_LIB = String.raw`// Sécurité côté navigateur — fichier géré par Velbaz (réécrit à chaque démarrage).
//   sanitizeHtml(html) : à utiliser pour TOUT HTML venant d'un utilisateur ou de l'API.
//   safeUrl(url)       : pour tout href/src venant de données (bloque javascript:, data:…).
//   safeJson(value)    : pour un <script type="application/ld+json">.
//   uploadFile(file)   : upload sécurisé vers /api/upload → { url, id, type, size }.

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") + "/api";

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** URL sûre pour href/src. Autorise http(s), mailto, tel, chemins relatifs et ancres. */
export function safeUrl(url: unknown, fallback = "#"): string {
  const u = String(url ?? "").trim();
  if (!u) return fallback;
  const compact = u.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();
  if (/^(https?:|mailto:|tel:)/.test(compact)) return u;
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/.test(compact)) return u;
  if (/^[a-z][a-z0-9+.-]*:/.test(compact)) return fallback; // javascript:, vbscript:, data:text/html…
  return u; // relatif : /x, ./x, #x, ?x
}

/** JSON injectable dans un <script> sans pouvoir le refermer. */
export function safeJson(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return String(s ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const ALLOWED_TAGS = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "del", "mark", "small", "sub", "sup", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "code", "pre", "span", "div", "img", "hr", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "form", "input", "button", "textarea", "select", "link", "meta", "base", "frame", "frameset"]);
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "loading"],
  "*": ["class", "colspan", "rowspan"],
};

/** Nettoie un HTML non fiable : balises et attributs en liste blanche, URLs vérifiées. */
export function sanitizeHtml(html: unknown): string {
  const src = String(html ?? "");
  if (!src) return "";
  if (typeof DOMParser === "undefined") return escapeHtml(src);
  const doc = new DOMParser().parseFromString("<body>" + src + "</body>", "text/html");
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) { child.remove(); continue; }
      if (!ALLOWED_TAGS.has(tag)) {
        walk(child);
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      const allowed = new Set([...(ALLOWED_ATTRS[tag] || []), ...ALLOWED_ATTRS["*"]]);
      for (const attr of Array.from(child.attributes)) {
        const n = attr.name.toLowerCase();
        if (!allowed.has(n)) { child.removeAttribute(attr.name); continue; }
        if (n === "href" || n === "src") {
          const v = safeUrl(attr.value, "");
          if (!v) child.removeAttribute(attr.name); else child.setAttribute(attr.name, v);
        }
      }
      if (tag === "a" && child.getAttribute("target") === "_blank") child.setAttribute("rel", "noopener noreferrer");
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export const UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif,application/pdf";
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Upload sécurisé. Le serveur revérifie tout (type réel, taille, extension). */
export async function uploadFile(file: File | Blob, name?: string): Promise<{ url: string; id: string; type: string; size: number }> {
  if (file.size > UPLOAD_MAX_BYTES) throw new Error("Fichier trop lourd (5 Mo maximum).");
  if (file.type && !UPLOAD_ACCEPT.split(",").includes(file.type)) throw new Error("Type non accepté : image (PNG, JPEG, WebP, GIF, AVIF) ou PDF.");
  const form = new FormData();
  form.append("file", file, name || (file as File).name || "upload");
  let token = "";
  try { token = localStorage.getItem("auth_token:" + (import.meta.env.BASE_URL || "/")) || ""; } catch {}
  const res = await fetch(API_BASE + "/upload", { method: "POST", body: form, headers: token ? { Authorization: "Bearer " + token } : {} });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || "Échec de l'envoi.");
  return { url: API_BASE + body.path, id: body.id, type: body.type, size: body.size };
}
`;

// ── Branchement dans server/index.ts ────────────────────────────────────────
const SEC_HEADERS_MW = `app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});`;

/** Ajoute l'upload sécurisé + les en-têtes de sécurité à un server/index.ts (idempotent). */
export function ensureSecurityMounted(index: string): string {
  let s = String(index || "");
  if (!s.includes("new Hono(")) return s;
  if (!/from\s+["']\.\/uploads["']/.test(s)) {
    const imports = [...s.matchAll(/^import[^\n]*\n/gm)];
    const last = imports[imports.length - 1];
    const line = `import { uploadRoute } from "./uploads";\n`;
    s = last ? s.slice(0, last.index! + last[0].length) + line + s.slice(last.index! + last[0].length) : line + s;
  }
  if (!s.includes("X-Content-Type-Options")) {
    const m = /^(\s*)app\.use\(\s*["']\*["']\s*,\s*cors\(\)\s*\);?[^\n]*\n/m.exec(s)
      || /^const app = new Hono\([^\n]*\n/m.exec(s);
    if (m) s = s.slice(0, m.index + m[0].length) + "\n" + SEC_HEADERS_MW + "\n" + s.slice(m.index + m[0].length);
  }
  if (!/app\.route\(\s*["']\/["']\s*,\s*uploadRoute\s*\)/.test(s)) {
    const exp = /^export default app;?/m.exec(s);
    if (exp) s = s.slice(0, exp.index) + `app.route("/", uploadRoute);\n\n` + s.slice(exp.index);
  }
  return s;
}

// ── Filet anti-XSS sur le code écrit par l'IA ───────────────────────────────

/** Index de fin (exclu) de l'expression qui commence à `start`, jusqu'au `}` de l'objet. */
function scanExpression(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; continue;
    }
    if (ch === "`") {
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") {
          let d = 1; i += 2;
          while (i < src.length && d > 0) {
            if (src[i] === "{") d++; else if (src[i] === "}") d--;
            if (d > 0) i++;
          }
          i++; continue;
        }
        i++;
      }
      i++; continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "}") { if (depth === 0) return i; depth--; }
    else if (ch === "," && depth === 0) return i;
    i++;
  }
  return -1;
}

function relativeLibImport(filePath: string): string {
  const dir = filePath.split("/").slice(0, -1); // ex. ["src","pages"]
  if (dir[0] !== "src") return "@/lib/security";
  const up = dir.length - 1;
  return (up === 0 ? "./" : "../".repeat(up)) + "lib/security";
}

/**
 * Tout `dangerouslySetInnerHTML={{ __html: X }}` dont X est dynamique passe par
 * sanitizeHtml (ou safeJson pour un <script type="application/ld+json">).
 * Les chaînes littérales statiques et les <style>/<script> écrits par l'IA ne
 * sont pas touchés. Idempotent.
 */
export function hardenGeneratedCode(filePath: string, code: string): string {
  if (!/\.(tsx|jsx)$/.test(filePath) || !filePath.startsWith("src/") || filePath === "src/lib/security.ts") return code;
  if (!code.includes("dangerouslySetInnerHTML")) return code;
  let out = "";
  let pos = 0;
  let usedHtml = false, usedJson = false;
  const re = /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const exprStart = m.index + m[0].length;
    const exprEnd = scanExpression(code, exprStart);
    if (exprEnd < 0) break;
    const expr = code.slice(exprStart, exprEnd).trim();
    const before = code.slice(Math.max(0, m.index - 400), m.index);
    const tag = (before.match(/<([a-zA-Z][\w.]*)(?![\s\S]*<[a-zA-Z])/) || [])[1]?.toLowerCase() || "";
    let wrapped: string | null = null;
    const isStatic = /^(["'])(?:(?!\1)[^\\]|\\.)*\1$/.test(expr) || /^`[^`$]*`$/.test(expr);
    const already = /^__vz(SanitizeHtml|SafeJson)\(/.test(expr) || /^(sanitizeHtml|safeJson)\(/.test(expr);
    if (!expr || isStatic || already || tag === "style") wrapped = null;
    else if (tag === "script") {
      if (/^JSON\.stringify\(/.test(expr)) { wrapped = `__vzSafeJson(${expr})`; usedJson = true; }
    } else { wrapped = `__vzSanitizeHtml(${expr})`; usedHtml = true; }
    out += code.slice(pos, exprStart) + (wrapped ?? code.slice(exprStart, exprEnd));
    pos = exprEnd;
    re.lastIndex = exprEnd;
  }
  out += code.slice(pos);
  if (!usedHtml && !usedJson) return code;
  const wanted = [
    usedHtml && !out.includes("as __vzSanitizeHtml") ? "sanitizeHtml as __vzSanitizeHtml" : "",
    usedJson && !out.includes("as __vzSafeJson") ? "safeJson as __vzSafeJson" : "",
  ].filter(Boolean);
  if (wanted.length) {
    const line = `import { ${wanted.join(", ")} } from "${relativeLibImport(filePath)}";\n`;
    const imports = [...out.matchAll(/^import[\s\S]*?from\s+["'][^"']+["'];?[^\n]*\n/gm)];
    const last = imports[imports.length - 1];
    out = last ? out.slice(0, last.index! + last[0].length) + line + out.slice(last.index! + last[0].length) : line + out;
  }
  return out;
}

/** Bloc de règles injecté dans le prompt système du générateur de code. */
export const SECURITY_RULES = `- SÉCURITÉ (obligatoire, non négociable) :
  • UPLOAD de fichier : utilise UNIQUEMENT \`uploadFile(file)\` importé depuis "../lib/security" (→ { url }). L'input porte \`accept={UPLOAD_ACCEPT}\` (même import). Jamais de fichier écrit dans public/, jamais de base64 stocké dans data, jamais de route d'upload maison.
  • XSS : n'utilise JAMAIS dangerouslySetInnerHTML avec un contenu venant d'un utilisateur, d'un formulaire ou de l'API — affiche-le comme texte JSX ({valeur}). Si un HTML riche est vraiment nécessaire : \`dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}\` (import depuis "../lib/security"). Tout href/src venant de données passe par \`safeUrl(url)\` (bloque javascript:). Jamais d'eval, de new Function, ni de innerHTML/document.write.
  • PAIEMENT : une commande n'est JAMAIS marquée payée sur la foi d'une requête du navigateur ou d'un webhook non signé. Le paiement passe par le checkout() existant (session Stripe vérifiée côté serveur). Si un webhook Stripe est indispensable côté serveur : corps BRUT (await c.req.text()) + \`stripe.webhooks.constructEvent(raw, c.req.header("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)\`, et refus 400 si la signature est absente ou invalide.`;
