// ─────────────────────────────────────────────────────────────
//  CONFIG MARQUE — un seul endroit à changer pour renommer l'app
//  Change BRAND (et éventuellement les autres) puis rebuild.
// ─────────────────────────────────────────────────────────────

/** Nom affiché de l'app (partout dans l'UI). */
export const BRAND = 'Velbaz';

/** Slug minuscule dérivé du nom (utilisé pour domaine/emails par défaut). */
const SLUG = BRAND.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Entité légale (mentions légales, docs). */
export const LEGAL_ENTITY = `${BRAND}, Inc.`;

/** Domaine principal. */
export const WEBSITE = `${SLUG}.app`;

/** Emails de contact. */
export const CONTACT_EMAIL = `legal@${SLUG}.app`;
export const SUPPORT_EMAIL = `support@${SLUG}.app`;

/** Juridiction (loi applicable dans les docs légaux). */
export const JURISDICTION = 'the State of Delaware, United States';

/** Noms des paliers de modèles. */
export const TIER_MAX = `${BRAND} Max`;
export const TIER_PRO = `${BRAND} Pro`;
export const TIER_LITE = `${BRAND} Lite`;
// Palier interne admin-only : gardé sous son nom de modèle brut, et non
// rebaptisé `${BRAND} …`, justement pour qu'on ne le confonde jamais avec un
// palier du catalogue (cf. ADMIN_ONLY_TIERS côté serveur).
export const TIER_LUNA = 'GPT 6 Luna';
// Modèle « Velbaz » (ex-« Velbaz 2.0 », renommé le 2026-10-03) : le modèle
// unique de TOUS les comptes normaux. Il ne change pas que le modèle du chat —
// il bascule tout le pipeline (code, agents, images) sur ses modèles
// (cf. api/agent/model-mode.ts). L'id technique reste 'velbaz2'.
export const TIER_VELBAZ2 = BRAND;
