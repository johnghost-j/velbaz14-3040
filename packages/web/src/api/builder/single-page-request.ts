/**
 * [2026-10-04] Détection « l'utilisateur veut UNE seule page (blanche) ».
 * Sorti de engine.ts pour être partagé tel quel par le serveur (plan) et le
 * chat (qui décide d'afficher ou non le questionnaire de pages) — le chat en
 * avait une copie qui lisait « …avec une page showroom » comme une page unique.
 */
import { stripSubjectLock } from "../idea-subject";

export function isSinglePageRequest(text: string): boolean {
  // [2026-10-04] « une marque de meubles avec une page showroom » était lu
  // comme « une (seule) page » → plan d'UNE page blanche. « une page X » qui
  // AJOUTE ou NOMME une page parmi d'autres n'est pas une demande de site d'une
  // page : on retire ces tournures avant de tester « une page ».
  const t = stripSubjectLock(text || "").toLowerCase()
    .replace(/\b(avec|ajoute[rsz]?|rajoute[rsz]?|plus|aussi|et|dont|inclu\w*|with|add)\s+(une|un|1|a|an)\s+(autre\s+|other\s+)?page\b(?!\s+(blanche?|vide|vierge|blank|empty|seule|unique))/g, " ")
    .replace(/\b(une|1)\s+page\s+(de\s+|d'|du\s+|des\s+)?(showroom|show-room|contact|faq|tarifs?|prix|boutique|shop|blog|journal|menu|carte|r[ée]servations?|panier|produits?|galerie|[ée]quipe|services?|prestations?|[àa]\s+propos|histoire|actualit[ée]s|collections?|catalogue|mod[eè]les?)\b/g, " ");
  return /\b(page|site|landing)\b[\s\S]{0,25}?\b(blanche?|vide|vierge|blank|empty)\b/.test(t)
    || /\b(blank|empty)\s+(page|site|landing)\b/.test(t)
    || /\b(une|1)\s+(seule\s+)?page\b/.test(t)
    || /\bjuste\s+(une|1)\s+page\b/.test(t)
    || /\b(single|one)\s+page\b/.test(t);
}
