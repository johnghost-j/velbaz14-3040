// ─── Email provider (Resend) ─────────────────────────────────────────────────
// Branche l'envoi réel côté API. Sans RESEND_API_KEY, mode "dry-run": on log et on
// enregistre l'email en base (status='not_sent') sans planter — le produit continue
// de tourner et tu ajoutes la clé quand tu veux (env RESEND_API_KEY).
//
// Setup: crée un compte resend.com → API key → ajoute RESEND_API_KEY et
// RESEND_FROM (ex: "Velbaz <hello@tondomaine.com>") dans .env.

// Clés résolues au RUNTIME (secret-store chiffré -> repli env). Permet d'ajouter
// la clé Resend depuis le panel admin sans redémarrer.
import { getSecret } from './secret-store';
import { cleanDisplayName, isEmailAddress } from './email-sender';
const resendKey = () => getSecret('RESEND_API_KEY') || '';
const resendFrom = () => getSecret('RESEND_FROM') || 'Velbaz <onboarding@resend.dev>';

/** Adresse nue contenue dans un en-tête From (`Nom <a@b.c>` ou `a@b.c`). */
function addressOf(header: string): string | null {
  const m = header.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (m) return m[1];
  return isEmailAddress(header) ? header.trim() : null;
}

/**
 * Normalise `input.from` :
 *  - vide → expéditeur par défaut (RESEND_FROM, « Velbaz » pour la plateforme) ;
 *  - adresse ou `Nom <adresse>` → utilisée telle quelle (adresse explicite) ;
 *  - NOM seul (ex. le nom d'un site généré) → `"Nom" <adresse par défaut>`.
 * Avant, un nom seul partait tel quel : Resend le rejetait (422) et la CLI
 * l'ignorait, d'où des emails de site signés « Velbaz ».
 */
export function resolveFrom(from?: string | null, fallback: string = resendFrom()): { header: string; explicitAddress: boolean; displayName: string | null } {
  const raw = String(from || '').trim();
  if (!raw) return { header: fallback, explicitAddress: false, displayName: null };
  const addr = addressOf(raw);
  if (addr) {
    const name = cleanDisplayName(raw.replace(/<[^>]*>/, ''));
    return { header: name && name !== addr ? `"${name}" <${addr}>` : addr, explicitAddress: true, displayName: name || null };
  }
  const name = cleanDisplayName(raw);
  const defaultAddr = addressOf(fallback) || 'onboarding@resend.dev';
  return { header: name ? `"${name}" <${defaultAddr}>` : fallback, explicitAddress: false, displayName: name || null };
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  skipped?: boolean;   // true si pas de clé (dry-run)
  error?: string;
  /**
   * Renseigné quand le nom/adresse d'expéditeur demandé n'a PAS pu être
   * appliqué (ex. commande `send-email` sans domaine vérifié → expéditeur par
   * défaut du compte Runable, aujourd'hui « Velbaz <no-reply@velbaz.com> »).
   * L'email est parti, mais pas sous l'identité voulue : à afficher, pas à taire.
   */
  senderNote?: string;
}

export function isEmailConfigured(): boolean {
  return resendKey().length > 0;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const to = Array.isArray(input.to) ? input.to : [input.to];
  if (!input.html && !input.text) {
    return { ok: false, error: 'Email needs html or text body' };
  }
  const RESEND_API_KEY = resendKey();
  if (!RESEND_API_KEY) {
    console.warn(`[email] RESEND_API_KEY manquante — dry-run. to=${to.join(',')} subject="${input.subject}"`);
    return { ok: false, skipped: true, error: 'RESEND_API_KEY not set' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: resolveFrom(input.from).header,
        to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        reply_to: input.replyTo,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[email] Resend error ${res.status}: ${body.slice(0, 300)}`);
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 200)}` };
    }
    const data: any = await res.json().catch(() => ({}));
    return { ok: true, id: data?.id };
  } catch (e: any) {
    console.error('[email] send failed:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ─── Provider auto-select (Resend → CLI interne) ─────────────────────────────
// Nouvelle brique pour Money Maker + apps générées. On NE change PAS le
// comportement de sendEmail()/isEmailConfigured() ci-dessus (dry-run Resend-only)
// pour ne pas déclencher d'envois inattendus dans les flux existants.
//
// Priorité : Resend si RESEND_API_KEY présent, sinon la commande sandbox
// `send-email` (envoi RÉEL immédiat). Bascule automatique dès que la clé Resend
// est ajoutée par l'utilisateur.

export type EmailProvider = 'resend' | 'cli' | 'none';

export function emailProvider(): EmailProvider {
  if (resendKey().length > 0) return 'resend';
  // La commande `send-email` est dispo dans le sandbox Runable.
  return 'cli';
}

export function canSendEmail(): boolean {
  return emailProvider() !== 'none';
}

const CLI_UNVERIFIED_RE = /sender domain is not verified|not verified/i;

async function sendViaCli(input: SendEmailInput): Promise<SendEmailResult> {
  // La commande n'accepte --from que pour un domaine vérifié dans Runable
  // (Domains). Un nom seul est refusé : sans adresse explicite on part de
  // l'expéditeur par défaut du compte Runable (mesuré le 2026-10-02 :
  // « Velbaz <no-reply@velbaz.com> ») et on le SIGNALE via senderNote.
  const wanted = input.from ? resolveFrom(input.from) : null;
  if (wanted?.explicitAddress) {
    const first = await runSendEmailCli(input, wanted.header);
    if (first.ok || !CLI_UNVERIFIED_RE.test(first.error || '')) return first;
    console.warn(`[email:cli] expéditeur ${wanted.header} refusé (domaine non vérifié dans Runable → Domains) — envoi depuis l'expéditeur par défaut`);
    const second = await runSendEmailCli(input);
    return second.ok
      ? { ...second, senderNote: `domaine de ${wanted.header} non vérifié dans Runable → Domains — envoyé depuis l'expéditeur par défaut de la plateforme (les réponses arrivent quand même au site)` }
      : second;
  }
  const r = await runSendEmailCli(input);
  return r.ok && wanted?.displayName
    ? { ...r, senderNote: `nom « ${wanted.displayName} » non appliqué : sans domaine d'envoi vérifié, l'email part de l'expéditeur par défaut de la plateforme (les réponses arrivent au site)` }
    : r;
}

async function runSendEmailCli(input: SendEmailInput, fromHeader?: string): Promise<SendEmailResult> {
  const to = Array.isArray(input.to) ? input.to : [input.to];
  const args: string[] = [];
  if (fromHeader) args.push('--from', fromHeader);
  for (const r of to) {
    args.push('--to', r);
  }
  args.push('--subject', input.subject);
  const useHtml = !!input.html;
  const body = input.html || input.text || '';
  args.push(useHtml ? '--html' : '--body', '-');
  if (input.replyTo) args.push('--reply-to', input.replyTo);
  try {
    // node:child_process (et non Bun.spawn) : sous Vite SSR le global `Bun`
    // n'existe pas. spawn est dispo partout (Node + Bun).
    const { spawn } = await import('node:child_process');
    return await new Promise<SendEmailResult>((resolve) => {
      const proc = spawn('send-email', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', (e: any) => {
        console.error('[email:cli] spawn failed:', e?.message || e);
        resolve({ ok: false, error: String(e?.message || e) });
      });
      proc.on('close', (code) => {
        if (code !== 0) {
          const msg = (err || out || `send-email exited ${code}`).slice(0, 300);
          console.error('[email:cli] failed:', msg);
          resolve({ ok: false, error: msg });
          return;
        }
        const idMatch = (out || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || (out || '').match(/id[:=]\s*([\w-]+)/i);
        resolve({ ok: true, id: idMatch?.[1] });
      });
      proc.stdin.write(body);
      proc.stdin.end();
    });
  } catch (e: any) {
    console.error('[email:cli] spawn failed:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Envoi réel avec sélection auto du provider. À utiliser pour Money Maker et
 * pour les apps générées. Ne fait jamais de dry-run silencieux : si aucun
 * provider n'est dispo, renvoie une erreur explicite.
 */
export async function sendEmailAuto(input: SendEmailInput): Promise<SendEmailResult> {
  if (!input.html && !input.text) {
    return { ok: false, error: 'Email needs html or text body' };
  }
  const provider = emailProvider();
  if (provider === 'resend') return sendEmail(input);
  if (provider === 'cli') return sendViaCli(input);
  return { ok: false, error: 'No email provider available' };
}

// ─── E-mails clients (confirmation de commande, suivi) ───────────────────────
// Un acheteur DOIT recevoir sa confirmation. Resend refuse l'envoi tant que le
// domaine de RESEND_FROM n'est pas vérifié (403 « domain is not verified »,
// ou « testing emails » avec onboarding@resend.dev) : avant, l'erreur était
// avalée et le client ne recevait rien. On retente alors via la commande
// `send-email` quand elle existe, et on renvoie une erreur LISIBLE sinon.

/** Refus Resend lié à la configuration (clé, domaine non vérifié) — pas au destinataire. */
export function isResendConfigRefusal(error?: string | null): boolean {
  const e = String(error || '');
  return /^Resend (401|403|422)\b/.test(e) || /domain is not verified|verify a domain|testing emails/i.test(e);
}

/** Message clair pour le propriétaire quand l'envoi échoue pour une raison de config. */
export function explainEmailFailure(error?: string | null): string {
  const e = String(error || '');
  if (/domain is not verified|verify a domain|testing emails|^Resend 403/i.test(e)) {
    return "domaine d'envoi Resend non vérifié (Admin Panel → vérifie le domaine de RESEND_FROM sur resend.com/domains)";
  }
  if (/RESEND_API_KEY not set/i.test(e)) return 'clé RESEND_API_KEY absente';
  return e.slice(0, 160) || 'erreur inconnue';
}

export async function sendCustomerEmail(input: SendEmailInput): Promise<SendEmailResult & { provider?: EmailProvider }> {
  if (!input.html && !input.text) return { ok: false, error: 'Email needs html or text body' };
  if (emailProvider() === 'resend') {
    const first = await sendEmail(input);
    if (first.ok) return { ...first, provider: 'resend' };
    if (!isResendConfigRefusal(first.error)) return { ...first, provider: 'resend' };
    const viaCli = await sendViaCli(input);
    if (viaCli.ok) return { ...viaCli, provider: 'cli' };
    console.warn(`[email] client non joint : Resend refusé (${explainEmailFailure(first.error)}) et repli indisponible (${viaCli.error || '?'})`);
    return { ok: false, error: first.error, provider: 'resend' };
  }
  const r = await sendViaCli(input);
  return { ...r, provider: 'cli' };
}
