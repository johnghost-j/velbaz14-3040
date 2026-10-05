// ─── Blocs du chat : [CALL] / [SMS] → cartes en direct ──────────────────────
//
// L'IA écrit une INTENTION :
//   [CALL]{"to":"+33612345678","name":"Jean Dupont","goal":"…","language":"fr"}[/CALL]
//   [SMS]{"to":"+33612345678","name":"Jean Dupont","message":"…","goal":"…"}[/SMS]
// Le serveur la valide, lance l'appel / envoie le SMS, puis remplace le bloc
// par [CALL_VIEW]{"id":"lc_…"}[/CALL_VIEW] ou [SMS_VIEW]{"id":"st_…"}[/SMS_VIEW].
// Le navigateur ne reçoit qu'un id : tout l'état vient ensuite du serveur.
// Une intention refusée devient une alerte lisible (jamais un faux « envoyé »).

import { createLiveCall } from './live-calls';
import { startSmsThread } from './sms';

const CALL_RE = /\[CALL\]([\s\S]*?)\[\/CALL\]/g;
const SMS_RE = /\[SMS\]([\s\S]*?)\[\/SMS\]/g;

export const hasCommsBlocks = (t: string) => /\[(CALL|SMS)\]/.test(t);

function alert(kind: 'warning' | 'danger', title: string, message: string) {
  return `[ALERT_VIEW]${JSON.stringify({ kind, title, message })}[/ALERT_VIEW]`;
}

/** Coupe un bloc ouvert jamais fermé (réponse tronquée). */
function dropUnterminated(text: string): string {
  let out = text;
  for (const tag of ['CALL', 'SMS']) {
    const open = out.lastIndexOf(`[${tag}]`);
    if (open >= 0 && out.indexOf(`[/${tag}]`, open) < 0) out = out.slice(0, open);
  }
  return out;
}

export function stripCommsBlocks(text: string, reason?: string): string {
  let had = false;
  let out = text.replace(CALL_RE, () => { had = true; return ''; }).replace(SMS_RE, () => { had = true; return ''; });
  out = dropUnterminated(out).trim();
  if (had && reason) out = `${out}\n\n${alert('warning', 'Action non lancée', reason)}`;
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export async function applyCommsBlocks(text: string, ctx: { companyId: string; userId: string; companyName?: string; origin?: string }): Promise<string> {
  let out = text;
  let calls = 0;
  for (const m of [...text.matchAll(CALL_RE)]) {
    let d: any = null;
    try { d = JSON.parse(m[1].trim()); } catch { d = null; }
    let rep: string;
    if (!d) rep = alert('danger', 'Appel non lancé', 'Bloc d’appel illisible.');
    else if (calls >= 1) rep = alert('warning', 'Appel non lancé', 'Un seul appel à la fois depuis le chat.');
    else {
      const r = await createLiveCall({ ...ctx, to: d.to ?? d.phone, contactName: d.name ?? d.contactName, goal: d.goal ?? d.script ?? d.objective, language: d.language });
      if (r.ok) { calls++; rep = `[CALL_VIEW]${JSON.stringify({ id: r.call.id })}[/CALL_VIEW]`; }
      else rep = alert('danger', 'Appel non lancé', r.error);
    }
    out = out.replace(m[0], () => rep);
  }
  let sms = 0;
  for (const m of [...text.matchAll(SMS_RE)]) {
    let d: any = null;
    try { d = JSON.parse(m[1].trim()); } catch { d = null; }
    let rep: string;
    if (!d) rep = alert('danger', 'SMS non envoyé', 'Bloc SMS illisible.');
    else if (sms >= 3) rep = alert('warning', 'SMS non envoyé', 'Maximum 3 SMS par réponse.');
    else {
      const r = await startSmsThread({ ...ctx, to: d.to ?? d.phone, contactName: d.name ?? d.contactName, message: d.message ?? d.body ?? d.text, context: d.goal ?? d.context });
      if (r.ok) { sms++; rep = `[SMS_VIEW]${JSON.stringify({ id: r.thread.id, messageId: r.message.id })}[/SMS_VIEW]`; }
      else rep = alert('danger', 'SMS non envoyé', r.error);
    }
    out = out.replace(m[0], () => rep);
  }
  return dropUnterminated(out).replace(/\n{3,}/g, '\n\n').trim();
}

/** Protocole injecté dans le prompt projet (bêta admin). */
export const COMMS_PROTOCOL = `## APPELS TÉLÉPHONIQUES IA ET SMS — \`[CALL]\` / \`[SMS]\`
Tu peux APPELER quelqu'un au téléphone (une IA vocale parle à ta place, en direct) ou lui envoyer un SMS. L'utilisateur voit l'appel en direct dans le chat (animation, transcription, il peut te glisser des consignes pendant l'appel) et les SMS dans une conversation dédiée.

Appel :
[CALL]{"to":"+33612345678","name":"Jean Dupont","goal":"Ce que l'appel doit obtenir, précis : qui tu es, pourquoi tu appelles, ce que tu demandes, ce qui compte comme réussite.","language":"fr"}[/CALL]
SMS :
[SMS]{"to":"+33612345678","name":"Jean Dupont","message":"Le texte exact du SMS (court, poli, signé du nom du projet).","goal":"Le but de l'échange, pour pouvoir répondre ensuite."}[/SMS]

CETTE CAPACITÉ EST RÉELLE : Velbaz est branché à un vrai service de téléphonie. Tu ne dis JAMAIS que tu ne peux pas appeler ou envoyer de SMS, que tu n'as pas accès au téléphone, ni que l'interface est une démo ou une simulation. Si une info manque (numéro, objectif), tu la DEMANDES en une phrase courte, dans la langue de l'utilisateur (« Je peux t'appeler. À quel numéro ? »). « appelle-moi » = appeler l'utilisateur lui-même : demande-lui son numéro s'il ne l'a pas donné. Pas de questionnaire [QUESTIONS] pour un appel ou un SMS. Dès que tu as le numéro et le but : tu ÉMETS le bloc dans CETTE réponse. Écrire « je lance l'appel » sans bloc [CALL] = rien ne se passe. UNE seule question, une seule fois : si l'objectif reste vague (« appelle-moi », « pour tester »), choisis toi-même un objectif simple (appel de test : te présenter au nom du projet, vérifier que la personne t'entend bien, demander si elle a une question) et lance l'appel.

RÈGLES ABSOLUES (vrais appels, vrais SMS, vraies personnes) :
1. Tu n'émets un bloc QUE si l'utilisateur t'a demandé d'appeler / d'écrire à quelqu'un, ET t'a donné le numéro (ou le numéro figure clairement dans la conversation). Tu n'inventes JAMAIS un numéro.
2. Avant d'émettre, si le numéro, la personne ou l'objectif n'est pas clair, demande-le. Si tout est clair et que l'utilisateur a dit « appelle » / « envoie », vas-y directement.
3. Numéro au format international E.164 (+33…). Un numéro français 06/07 → +336/+337.
4. Un seul [CALL] par réponse, 3 [SMS] maximum. Pas de démarchage de masse, pas de faux prétexte, pas d'usurpation d'identité : l'IA dit pour qui elle appelle et admet être une IA si on lui demande.
5. Si une personne a répondu STOP ou a demandé à ne plus être contactée, tu ne la recontactes JAMAIS.
6. Tu n'affirmes jamais qu'un appel a abouti ou qu'un SMS a été reçu : la carte affichée montre l'état réel. Une phrase d'intro suffit autour du bloc.`;

/**
 * Note injectée à la place de COMMS_PROTOCOL pour les comptes Free : l'IA ne
 * peut ni appeler ni envoyer de SMS, mais doit le dire clairement (et orienter
 * vers /plans) au lieu de prétendre l'avoir fait.
 */
export const COMMS_LOCKED_NOTE = `## APPELS / SMS — NON INCLUS DANS LE PLAN DE L'UTILISATEUR
Les appels téléphoniques et les SMS passés par l'IA sont réservés aux plans Business et Enterprise. L'utilisateur est sur le plan Free : tu ne peux ni appeler ni envoyer de SMS, et tu n'émets JAMAIS de bloc [CALL] ou [SMS]. S'il te le demande, dis-le simplement en une phrase et propose-lui de passer au plan Business sur la page /plans (tu peux quand même lui rédiger le texte du SMS ou le script de l'appel).`;
