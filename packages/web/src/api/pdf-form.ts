// ─── Lecture des champs d'un PDF formulaire (AcroForm) ──────────────────────
//
// Pourquoi : l'admin remplit le PDF « VELBAZ-CLES-API.pdf » dans son lecteur
// (Chrome, Aperçu, Acrobat) et le dépose tel quel dans le coffre. Un PDF n'est
// pas du texte : lu comme du texte, il ne donne rien et l'import trouvait
// « 0 clé ». Ce module extrait les paires (nom du champ → valeur saisie) sans
// dépendance externe, puis l'import les traite comme des lignes KEY=VALUE.
//
// Couvre les deux façons dont un lecteur enregistre un formulaire rempli :
//   • objets PDF classiques non compressés (Acrobat, Aperçu, pypdf) ;
//   • flux d'objets compressés /ObjStm (Chrome, PDF 1.5+) → inflate zlib.
//
// Aucune valeur n'est journalisée ici.
//
import { inflateSync } from 'node:zlib';

/** true si le contenu binaire est un PDF. */
export function isPdf(bytes: Uint8Array): boolean {
  // La signature peut être précédée de quelques octets parasites.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

/** Décode une chaîne PDF littérale `(...)` : échappements + octal. */
function decodeLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === '\n') { /* continuation de ligne */ }
    else if (n === '\r') { if (raw[i + 1] === '\n') i++; }
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n; // \( \) \\ et tout le reste
  }
  return out;
}

/** Décode une chaîne PDF hexadécimale `<...>`. */
function decodeHex(raw: string): string {
  const hex = raw.replace(/[^0-9A-Fa-f]/g, '');
  const even = hex.length % 2 ? `${hex}0` : hex;
  const buf = Buffer.from(even, 'hex');
  return bufToText(buf);
}

/** UTF-16BE (BOM FE FF), UTF-16LE, sinon latin1 (PDFDocEncoding approché). */
function bufToText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.subarray(2).swap16().toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  const s = buf.toString('latin1');
  // Un PDF peut stocker de l'UTF-8 brut : on le récupère si c'est valide.
  try {
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('�') && /[\u0080-￿]/.test(s)) return utf8;
  } catch { /* garde latin1 */ }
  return s;
}

/**
 * Lit une chaîne PDF à partir de la position d'ouverture.
 * @returns le texte décodé et l'index juste après la fermeture, ou null.
 */
function readStringAt(src: string, open: number): { text: string; end: number } | null {
  if (src[open] === '(') {
    let depth = 1;
    let i = open + 1;
    let raw = '';
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '\\') { raw += c + (src[i + 1] ?? ''); i += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
      raw += c;
      i++;
    }
    return { text: decodeLiteral(raw), end: i + 1 };
  }
  if (src[open] === '<' && src[open + 1] !== '<') {
    const close = src.indexOf('>', open + 1);
    if (close < 0) return null;
    return { text: decodeHex(src.slice(open + 1, close)), end: close + 1 };
  }
  return null;
}

/** Saute les blancs et commentaires PDF. */
function skipWs(src: string, i: number): number {
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue; }
    if (c === '%') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    break;
  }
  return i;
}

/**
 * Décompresse les flux d'objets (/Type /ObjStm) et renvoie leur contenu en
 * latin1, concaténé, afin que la recherche de champs y passe aussi.
 * Chrome enregistre les formulaires remplis de cette façon.
 */
function expandObjectStreams(buf: Buffer): string {
  const src = buf.toString('latin1');
  let out = '';
  const re = /\/Type\s*\/ObjStm/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Remonte au début de l'objet, puis trouve le flux qui suit.
    const objStart = src.lastIndexOf('obj', m.index);
    if (objStart < 0) continue;
    const sIdx = src.indexOf('stream', m.index);
    if (sIdx < 0) continue;
    const dict = src.slice(objStart, sIdx);
    if (!/\/Filter\s*\/FlateDecode/.test(dict)) continue;
    let dataStart = sIdx + 'stream'.length;
    if (src[dataStart] === '\r') dataStart++;
    if (src[dataStart] === '\n') dataStart++;
    const endIdx = src.indexOf('endstream', dataStart);
    if (endIdx < 0) continue;
    try {
      const raw = buf.subarray(dataStart, endIdx);
      out += `\n${inflateSync(raw).toString('latin1')}`;
    } catch { /* flux illisible : ignoré */ }
  }
  return out;
}

export interface PdfField {
  name: string;
  value: string;
}

/**
 * Extrait les champs remplis d'un PDF formulaire.
 * Les champs vides sont ignorés. Le dernier état saisi gagne (les lecteurs
 * ajoutent une mise à jour incrémentale à la fin du fichier).
 */
export function extractPdfFields(bytes: Uint8Array): PdfField[] {
  const buf = Buffer.from(bytes);
  const src = buf.toString('latin1') + expandObjectStreams(buf);

  const found = new Map<string, string>();
  // Un champ de formulaire porte toujours /T (son nom). La valeur saisie est
  // dans /V, qui peut précéder ou suivre /T dans le dictionnaire.
  const re = /\/T\s*(?=[(<])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const nameAt = skipWs(src, m.index + m[0].length);
    const nameRead = readStringAt(src, nameAt);
    if (!nameRead) continue;
    const name = nameRead.text.trim();
    if (!name) continue;

    // Fenêtre du dictionnaire autour du /T pour y chercher le /V correspondant.
    const from = Math.max(0, m.index - 3000);
    const to = Math.min(src.length, nameRead.end + 3000);
    const window = src.slice(from, to);
    const rel = m.index - from;

    // On prend le /V le plus proche du /T (avant ou après), en ignorant
    // /DV (valeur par défaut) et les /V d'autres objets trop éloignés.
    let best: { text: string; dist: number } | null = null;
    const vre = /(^|[^A-Za-z/])\/V\s*(?=[(<])/g;
    let v: RegExpExecArray | null;
    while ((v = vre.exec(window))) {
      const at = skipWs(window, v.index + v[0].length);
      const read = readStringAt(window, at);
      if (!read) continue;
      const dist = Math.abs(v.index - rel);
      if (!best || dist < best.dist) best = { text: read.text, dist };
    }
    if (!best) continue;
    const value = best.text.trim();
    if (!value) continue;
    found.set(name, value); // mise à jour incrémentale : la dernière gagne
  }

  return [...found].map(([name, value]) => ({ name, value }));
}

/**
 * Convertit un PDF formulaire rempli en contenu .env, directement digérable
 * par parseEnvBundle(). Renvoie '' si aucun champ rempli.
 */
export function pdfToEnvContent(bytes: Uint8Array): string {
  const fields = extractPdfFields(bytes);
  const lines = fields
    .filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name))
    .map((f) => `${f.name.toUpperCase()}=${f.value.replace(/[\r\n]+/g, ' ').trim()}`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}
