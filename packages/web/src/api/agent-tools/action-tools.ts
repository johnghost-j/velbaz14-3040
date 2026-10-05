// ─── Outils d'ACTION de l'agent : email, image, document ────────────────────
//
// Bug corrigé (2026-10-02) : « envoie-moi un mail à mon compte » → le chat
// répondait qu'il ne pouvait pas envoyer d'email, alors que la plateforme en
// envoie pendant la création d'un projet. La capacité existait, mais aucun outil
// ne la donnait au modèle. Ces outils la lui donnent POUR DE VRAI :
//   - send_email     : envoi réel (Resend, sinon commande send-email) ;
//   - generate_image : génération réelle + URL publique affichée dans le chat ;
//   - create_document: document du projet, téléchargeable en PDF depuis le chat.
//
// Garde-fous (le modèle lit aussi des pages web, donc peut être manipulé) :
//   - par défaut l'email part au TITULAIRE DU COMPTE ;
//   - une autre adresse n'est acceptée que si l'utilisateur l'a écrite LUI-MÊME
//     dans son message (une adresse soufflée par une page web est refusée) ;
//   - un seul destinataire par appel, quota horaire par utilisateur ;
//   - résultat réel renvoyé au modèle (jamais de faux « c'est envoyé »).

import { tool } from 'ai';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database/index';
import * as schema from '../database/schema';
import { sendEmailAuto, explainEmailFailure } from '../email-provider';
import { loadSiteSender } from '../email-sender-load';
import { isEmailAddress } from '../email-sender';
import { uploadDataUriToPublicUrl } from '../cdn-upload';
import { agentCapabilities } from './capabilities';
import type { AgentProgress, ToolContext } from './types';

// ── Destinataire ─────────────────────────────────────────────────────────────

const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Adresses écrites par l'utilisateur dans son propre message. */
export function emailsInUserText(text: string | undefined): string[] {
  return [...new Set((String(text || '').match(EMAIL_IN_TEXT_RE) || []).map((e) => e.toLowerCase()))];
}

export type RecipientDecision =
  | { ok: true; to: string; toSelf: boolean }
  | { ok: false; reason: string };

/**
 * Décide à qui l'email part. Vide / « moi » → le compte de l'utilisateur.
 * Une adresse tierce doit figurer telle quelle dans le message de l'utilisateur.
 */
export function decideRecipient(requested: string | undefined, accountEmail: string | undefined, userText: string | undefined): RecipientDecision {
  const account = String(accountEmail || '').trim().toLowerCase();
  const raw = String(requested || '').trim().toLowerCase();
  const self = !raw || /^(moi|me|myself|mon compte|my account|self|user|utilisateur)$/i.test(raw) || raw === account;
  if (self) {
    if (!isEmailAddress(account)) return { ok: false, reason: "Ton compte n'a pas d'adresse email enregistrée : je ne peux pas t'écrire." };
    return { ok: true, to: account, toSelf: true };
  }
  if (!isEmailAddress(raw)) return { ok: false, reason: `« ${requested} » n'est pas une adresse email valide.` };
  if (!emailsInUserText(userText).includes(raw)) {
    return {
      ok: false,
      reason: `Par sécurité, je n'écris à une autre adresse que ton compte que si TU me la donnes dans ton message. ` +
        `Écris-moi l'adresse exacte (ex. « envoie à ${raw} ») et je l'envoie.`,
    };
  }
  return { ok: true, to: raw, toSelf: false };
}

// ── Quota ────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
export const EMAIL_HOURLY_LIMIT = 10;
const G = globalThis as any;
const sentLog: Map<string, number[]> = (G.__velbaz_agent_email_log ??= new Map<string, number[]>());

/** true si l'utilisateur peut encore envoyer (et réserve l'envoi). */
export function takeEmailQuota(userId: string, now = Date.now(), limit = EMAIL_HOURLY_LIMIT): boolean {
  const recent = (sentLog.get(userId) || []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= limit) { sentLog.set(userId, recent); return false; }
  recent.push(now);
  sentLog.set(userId, recent);
  return true;
}

/** Rend un quota réservé quand l'envoi a échoué. */
function releaseEmailQuota(userId: string): void {
  const list = sentLog.get(userId);
  if (list?.length) list.pop();
}

// ── Corps de l'email ─────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Texte (markdown léger) → HTML sobre : paragraphes, **gras**, liens. */
export function emailTextToHtml(text: string): string {
  const inline = (s: string) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  const paras = String(text || '').trim().split(/\n{2,}/).map((p) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      return `<ul style="margin:0 0 14px;padding-left:20px">${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p style="margin:0 0 14px;line-height:1.55">${lines.map(inline).join('<br>')}</p>`;
  });
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7fb;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2330;font-size:15px">` +
    `<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:26px">${paras.join('')}</div></body></html>`;
}

// ── Outils ───────────────────────────────────────────────────────────────────

export function buildActionTools(
  ctx: ToolContext,
  emit: (step: AgentProgress) => void,
  note: (tool: string, input: any, ok: boolean, summary: string, ms: number) => void,
  nextId: (p: string) => string,
): Record<string, any> {
  const tools: Record<string, any> = {};
  const user = ctx.user;

  tools.send_email = tool({
    description:
      "Envoie un VRAI email. recipient='me' : à l'adresse du compte de l'utilisateur (« envoie-moi un mail »). " +
      "recipient='other' : à quelqu'un d'autre ; son adresse va dans 'to' et doit apparaître dans le message de l'utilisateur. " +
      "Si l'utilisateur veut écrire à une autre personne sans donner son adresse, N'APPELLE PAS l'outil : demande-lui l'adresse. " +
      "Dans un projet, l'email porte le nom du site (jamais « Velbaz ») sauf si sender='velbaz'. " +
      "Renvoie le résultat réel : ne dis « envoyé » que si l'outil confirme.",
    inputSchema: z.object({
      recipient: z.enum(['me', 'other']).describe("'me' = l'utilisateur lui-même ; 'other' = une autre personne (adresse obligatoire dans 'to')."),
      to: z.string().optional().describe("Adresse du destinataire quand recipient='other'."),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(20000).describe('Corps du message (texte, **gras**, listes « - », liens).'),
      sender: z.enum(['site', 'velbaz']).optional().describe("Identité d'expédition. Défaut : le site du projet s'il y en a un, sinon Velbaz."),
    }),
    execute: async (input: { recipient: 'me' | 'other'; to?: string; subject: string; body: string; sender?: 'site' | 'velbaz' }) => {
      const t0 = Date.now();
      if (!user?.id) {
        note('send_email', { to: input.to }, false, 'utilisateur non identifié', Date.now() - t0);
        return "Envoi impossible : tu n'es pas connecté, je ne sais pas à quelle adresse écrire. Connecte-toi puis redemande.";
      }
      // Un email pour un tiers ne doit JAMAIS retomber silencieusement sur le
      // compte de l'utilisateur (bug mesuré : « envoie un mail à mon associé »
      // → parti à l'utilisateur, annoncé comme envoyé à l'associé).
      if (input.recipient === 'other' && !String(input.to || '').trim()) {
        note('send_email', {}, false, 'adresse du tiers manquante', Date.now() - t0);
        return "Email NON envoyé : il me faut l'adresse email exacte de cette personne. Demande-la à l'utilisateur.";
      }
      const dest = decideRecipient(input.recipient === 'me' ? undefined : input.to, user.email, ctx.userMessage);
      if (!dest.ok) {
        note('send_email', { to: input.to }, false, dest.reason, Date.now() - t0);
        return `Email NON envoyé. ${dest.reason}`;
      }
      if (!takeEmailQuota(user.id)) {
        note('send_email', { to: dest.to }, false, 'quota horaire', Date.now() - t0);
        return `Email NON envoyé : limite de ${EMAIL_HOURLY_LIMIT} emails par heure depuis le chat atteinte. Réessaie plus tard.`;
      }
      emit({ id: nextId('mail'), label: `Envoi d'un email à ${dest.to}`, preview: { kind: 'analyze', caption: input.subject.slice(0, 120) } });

      // Identité : le site du projet (nom, adresse configurée) ; hors projet,
      // un mail à soi-même vient de Velbaz, un mail à un tiers porte le nom de
      // l'utilisateur et les réponses lui reviennent.
      let from: string | undefined;
      let replyTo: string | undefined;
      const useSite = !!ctx.companyId && input.sender !== 'velbaz';
      if (useSite) {
        const s = await loadSiteSender(ctx.companyId!).catch(() => null);
        from = s?.from;
        replyTo = dest.toSelf ? undefined : (s?.replyTo || user.email);
      } else if (!dest.toSelf) {
        from = user.name || undefined;
        replyTo = user.email;
      }

      const res = await sendEmailAuto({
        to: dest.to,
        subject: input.subject.trim(),
        text: input.body,
        html: emailTextToHtml(input.body),
        from,
        replyTo,
      }).catch((e: any) => ({ ok: false, error: String(e?.message || e) } as { ok: boolean; error?: string; id?: string; senderNote?: string }));

      if (!res.ok) releaseEmailQuota(user.id);
      if (ctx.companyId) {
        await db.insert(schema.emails).values({
          id: uuidv4(), companyId: ctx.companyId, type: 'outbound', subject: input.subject.slice(0, 300),
          body: input.body, recipientEmail: dest.to, status: res.ok ? 'sent' : 'failed', generatedBy: 'chat_agent',
        }).catch(() => { /* journal non bloquant */ });
      }
      const summary = res.ok ? `envoyé à ${dest.to}` : `échec : ${explainEmailFailure(res.error)}`;
      note('send_email', { to: dest.to, subject: input.subject }, res.ok, summary, Date.now() - t0);
      if (!res.ok) return `Email NON envoyé à ${dest.to} : ${explainEmailFailure(res.error)}. Dis-le tel quel à l'utilisateur.`;
      const whoTo = dest.toSelf ? `à l'adresse du compte de l'utilisateur (${dest.to}), à personne d'autre` : `à ${dest.to}`;
      return `Email envoyé ${whoTo} (objet : « ${input.subject.trim()} »)${res.id ? `, id ${res.id}` : ''}. Rapporte le destinataire exact.` +
        (res.senderNote ? ` Note expéditeur : ${res.senderNote}.` : '');
    },
  });

  tools.generate_image = tool({
    description:
      "Génère une VRAIE image (illustration, visuel, photo réaliste, logo, bannière) à partir d'une description détaillée. " +
      "Renvoie une balise [IMG:url] : recopie-la TELLE QUELLE dans ta réponse pour que l'image s'affiche dans le chat.",
    inputSchema: z.object({
      prompt: z.string().min(3).max(2000).describe("Description visuelle précise (sujet, style, couleurs, cadrage), en anglais de préférence."),
    }),
    execute: async ({ prompt }: { prompt: string }) => {
      const t0 = Date.now();
      const caps = agentCapabilities();
      if (!caps.generateImage) {
        note('generate_image', {}, false, 'capacité non branchée', Date.now() - t0);
        return "Génération d'image indisponible sur ce serveur pour le moment. Dis-le franchement à l'utilisateur.";
      }
      const payer = user?.id;
      if (!payer) {
        note('generate_image', {}, false, 'utilisateur non identifié', Date.now() - t0);
        return "Génération impossible : utilisateur non connecté (la génération d'image consomme des crédits).";
      }
      if (caps.chargeImage) {
        const tr = await caps.chargeImage(payer, ctx.companyId).catch((e: any) => ({ ok: false, error: String(e?.message || e) }));
        if (!tr.ok) {
          note('generate_image', {}, false, tr.error || 'solde insuffisant', Date.now() - t0);
          return `Image NON générée : ${tr.error || 'solde de crédits insuffisant'}.`;
        }
      }
      emit({ id: nextId('img'), label: "Génération d'une image", preview: { kind: 'analyze', caption: prompt.slice(0, 160) } });
      const img = await caps.generateImage(prompt).catch(() => null);
      if (!img) {
        note('generate_image', {}, false, 'génération échouée', Date.now() - t0);
        return "La génération d'image a échoué (modèle indisponible ou refus). Dis-le à l'utilisateur et propose de reformuler.";
      }
      const dataUri = `data:${img.mimeType};base64,${img.data}`;
      const url = await uploadDataUriToPublicUrl(dataUri, 'chat_img');
      if (ctx.companyId) {
        await db.insert(schema.documents).values({
          id: uuidv4(), companyId: ctx.companyId, title: prompt.slice(0, 120), type: 'image_custom',
          content: dataUri, generatedBy: 'chat_agent',
        }).catch(() => { /* galerie non bloquante */ });
      }
      if (!url) {
        note('generate_image', {}, false, 'upload échoué', Date.now() - t0);
        return ctx.companyId
          ? "Image générée et rangée dans les images du projet, mais l'hébergement de l'aperçu a échoué : je ne peux pas l'afficher ici."
          : "Image générée, mais son hébergement a échoué : je ne peux pas l'afficher. Propose de réessayer.";
      }
      emit({ id: nextId('img-ok'), label: 'Image prête', preview: { kind: 'screenshot', imageUrl: url, caption: prompt.slice(0, 120) } });
      note('generate_image', {}, true, url, Date.now() - t0);
      return `Image générée. Recopie cette balise telle quelle dans ta réponse : [IMG:${url}]`;
    },
  });

  if (ctx.companyId) {
    const companyId = ctx.companyId;
    tools.create_document = tool({
      description:
        "Crée un document (rapport, devis, contrat, plan, fiche…) rangé dans le projet. L'utilisateur l'ouvre depuis le chat et le télécharge en PDF. " +
        "Renvoie une balise [FILE:…] : recopie-la TELLE QUELLE dans ta réponse.",
      inputSchema: z.object({
        title: z.string().min(1).max(120),
        content: z.string().min(1).max(60000).describe('Contenu COMPLET en Markdown (titres #, listes, tableaux).'),
      }),
      execute: async ({ title, content }: { title: string; content: string }) => {
        const t0 = Date.now();
        const slug = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
        const path = `documents/${slug}.md`;
        emit({ id: nextId('doc'), label: `Rédaction du document « ${title} »`, preview: { kind: 'code', caption: path } });
        try {
          const now = new Date().toISOString();
          const [row] = await db.select().from(schema.projectFiles)
            .where(and(eq(schema.projectFiles.companyId, companyId), eq(schema.projectFiles.filePath, path))).limit(1);
          if (row) {
            await db.update(schema.projectFiles).set({ content, version: (row.version || 1) + 1, updatedAt: now })
              .where(eq(schema.projectFiles.id, row.id));
          } else {
            await db.insert(schema.projectFiles).values({
              id: uuidv4(), companyId, filePath: path, content, fileType: 'document', version: 1, createdAt: now, updatedAt: now,
            });
          }
          const fileTag = `${path}|${title.replace(/[\]|]/g, ' ').trim()}`;
          note('create_document', { path }, true, fileTag, Date.now() - t0);
          return `Document enregistré. Recopie cette balise telle quelle dans ta réponse : [FILE:${fileTag}]`;
        } catch (e: any) {
          note('create_document', { path }, false, e?.message || 'échec', Date.now() - t0);
          return `Document NON enregistré : ${e?.message || e}`;
        }
      },
    });
  }

  return tools;
}

/** Lignes d'instructions correspondantes (prompt système). */
export function actionToolsInstructions(hasProject: boolean, hasUser: boolean): string {
  return [
    hasUser
      ? "- send_email : envoyer un VRAI email. « Envoie-moi un mail » = recipient='me'. À un tiers : recipient='other' + l'adresse que l'utilisateur t'a écrite ; sans adresse, demande-la au lieu d'envoyer."
      : "- send_email : (utilisateur non connecté → envoi impossible, dis-le)",
    "- generate_image : générer une vraie image ; recopie la balise [IMG:url] renvoyée dans ta réponse.",
    hasProject ? "- create_document : créer un document du projet (téléchargeable en PDF) ; recopie la balise [FILE:…] renvoyée." : '',
  ].filter(Boolean).join('\n');
}
