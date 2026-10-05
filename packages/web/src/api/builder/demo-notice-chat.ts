// ─── « Contenu d'exemple » : dit DANS LE CHAT, pas dans le site ─────────────
//
// [2026-09-25 — demande utilisateur] Le texte « ⚠ Contenu d'exemple / Les
// produits, modèles et tarifs affichés sur ce site sont des exemples… » était
// rendu comme un bandeau permanent sous le footer de CHAQUE page du site généré
// (composant DemoNotice). C'était la mauvaise surface :
//
//   • le message s'adresse au PROPRIÉTAIRE (« remplace-les par ton vrai
//     catalogue depuis Velbaz »), pas à ses visiteurs ;
//   • affiché sur le site public, il annonce à ses clients que sa boutique est
//     fausse — le propriétaire ne peut rien montrer à personne.
//
// Désormais : le site reste propre (seuls les badges « Exemple » posés sur les
// éléments concernés subsistent) et Velbaz DIT la chose au propriétaire dans le
// chat, en message assistant persistant.
//
// Ce qui NE change pas : le garde-fou de paiement côté serveur. Une commande
// portant sur un article qui n'existe pas dans le catalogue réel est toujours
// refusée (cf. CHECKOUT_BLOCK_COPY / commerce-guard) — c'est ce qui protège
// réellement les visiteurs, indépendamment de tout texte affiché.
import { eq } from "drizzle-orm";
import { db } from "../database/index";
import * as schema from "../database/schema";
import { demoNoticeChatMessage } from "./demo-content";

/** Le chat d'un projet utilise `sessionId === companyId` (cf. api/index.ts). */
const messageId = (companyId: string) => `demo-notice-${companyId}`;

/**
 * Poste (ou rafraîchit) le message « contenu d'exemple » dans le chat du projet.
 *
 * Idempotent : l'id du message est déterministe, donc un rebuild ne remplit pas
 * le chat de doublons — le message existant est remonté en bas du fil avec le
 * texte à jour.
 *
 * Ne lève JAMAIS : une information ne doit pas pouvoir faire échouer un build.
 *
 * @returns true si le message a bien été écrit.
 */
export async function announceDemoContentInChat(
  companyId: string,
  lang?: string | null,
): Promise<boolean> {
  if (!companyId) return false;
  const content = demoNoticeChatMessage(lang);
  try {
    await db
      .insert(schema.chatMessages)
      .values({
        id: messageId(companyId),
        sessionId: companyId,
        role: "assistant",
        content,
        model: "velbaz",
        createdAt: new Date(),
      } as any)
      .onConflictDoUpdate({
        target: schema.chatMessages.id,
        set: { content, createdAt: new Date() } as any,
      });
    return true;
  } catch {
    return false;
  }
}

/**
 * Le message n'a plus de raison d'être dès qu'un vrai catalogue est branché :
 * on le retire du chat pour ne pas laisser un avertissement périmé au-dessus
 * d'un site devenu réel. Ne lève jamais.
 */
export async function clearDemoContentAnnouncement(companyId: string): Promise<void> {
  if (!companyId) return;
  try {
    await db.delete(schema.chatMessages).where(eq(schema.chatMessages.id, messageId(companyId)));
  } catch {
    /* nettoyage best-effort */
  }
}
