// ─── Mode « Velbaz 2.0 » mémorisé (flag admin dans app_config) ───────────────
//
// Le palier « Velbaz 2.0 » choisi dans le chat est mémorisé dans app_config :
// un build relancé plus tard, une validation de produit, la synchro du
// catalogue… ne transportent pas le palier, ils doivent suivre ce choix.
//
// [2026-10-03] Avant, le flag n'était relu que par 3 routes (build, création de
// projet, reprise). Toutes les autres routes d'un admin en Velbaz 2.0
// (brand-preview/approve → catalog-sync, product-visualize/approve, création
// Printify…) repartaient sur anthropic/claude-sonnet-4.6. Il est désormais
// appliqué à l'authentification (checkAuth), donc à toute requête admin.
//
// Le flag est global mais n'est JAMAIS honoré pour un compte non admin.
// [2026-10-03] Un compte non admin est désormais TOUJOURS en Velbaz (le mode
// est devenu le modèle public) : le flag ne sert plus qu'au choix de l'admin.
import { eq } from "drizzle-orm";
import { db } from "../database/index";
import * as schema from "../database/schema";
import { isAdminUser } from "../security";
import { dbRetry } from "../db-retry";
import { applyRememberedVelbaz2, runWithModelMode } from "./model-mode";

export const VELBAZ2_FLAG_KEY = "admin_velbaz2_mode";

/**
 * checkAuth tourne sur presque chaque requête : on ne relit pas la base à
 * chaque fois. Cache court, mis à jour immédiatement par setVelbaz2Flag (seul
 * écrivain, même process). Sur globalThis pour survivre au HMR.
 */
const FLAG_CACHE_TTL_MS = 5_000;
interface FlagCache { value: boolean; at: number }
const g = globalThis as any;
function cached(): FlagCache | null { return g.__velbaz2_flag_cache ?? null; }
function remember(value: boolean) { g.__velbaz2_flag_cache = { value, at: Date.now() } satisfies FlagCache; }

/** Test uniquement : oublie la valeur en cache. */
export function resetVelbaz2FlagCache(): void { g.__velbaz2_flag_cache = null; }

export async function getVelbaz2Flag(): Promise<boolean> {
  const c = cached();
  if (c && Date.now() - c.at < FLAG_CACHE_TTL_MS) return c.value;
  try {
    const row = await db.select().from(schema.appConfig).where(eq(schema.appConfig.key, VELBAZ2_FLAG_KEY)).get();
    // [2026-10-03] Velbaz est le modèle par défaut : sans choix mémorisé
    // (ligne absente), l'admin y est aussi. Seul un "0" explicite l'en sort.
    const value = row ? row.value === "1" : true;
    remember(value);
    return value;
  } catch (e: any) {
    // Pas de mise en cache d'une erreur transitoire : on retentera au prochain appel.
    console.warn("[velbaz2] lecture du flag KO :", e?.message);
    return c?.value ?? true;
  }
}

export async function setVelbaz2Flag(v: boolean, byUserId?: string): Promise<void> {
  try {
    const existing = await db.select().from(schema.appConfig).where(eq(schema.appConfig.key, VELBAZ2_FLAG_KEY)).get();
    if (existing) {
      if (existing.value !== (v ? "1" : "0")) {
        await db.update(schema.appConfig)
          .set({ value: v ? "1" : "0", updatedBy: byUserId, updatedAt: new Date() })
          .where(eq(schema.appConfig.key, VELBAZ2_FLAG_KEY));
      }
    } else {
      await db.insert(schema.appConfig).values({ key: VELBAZ2_FLAG_KEY, value: v ? "1" : "0", updatedBy: byUserId });
    }
    remember(v);
  } catch (e: any) {
    console.warn("[velbaz2] écriture du flag KO :", e?.message);
  }
}

/**
 * Mode Velbaz effectif pour un compte.
 * [2026-10-03] « Velbaz » (ex-Velbaz 2.0) est le modèle de TOUT LE MONDE :
 * un compte normal y est toujours, sans choix possible. Seul l'admin peut en
 * sortir (palier Max/Pro/Lite/Luna), et ce choix est mémorisé dans le flag.
 * Défaut admin = Velbaz tant qu'il n'a rien choisi d'autre (ligne absente →
 * getVelbaz2Flag() renvoie true).
 */
export async function velbazModeForUser(
  user: { email?: string | null; role?: string | null } | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (!isAdminUser(user)) return true;
  return getVelbaz2Flag();
}

/**
 * Appelé à l'authentification : TOUTE la requête (et les jobs de fond qu'elle
 * lance) passe sur les modèles Velbaz pour un compte normal, et pour un admin
 * dont le mode mémorisé est Velbaz. Ne réécrit jamais un choix explicite de la
 * requête.
 */
export async function applyRememberedVelbaz2ForUser(
  user: { email?: string | null; role?: string | null } | null | undefined,
): Promise<boolean> {
  const on = await velbazModeForUser(user);
  if (on) applyRememberedVelbaz2(true);
  return on;
}

/**
 * Job de plateforme lancé HORS requête (auto-réparation…) : ouvre son propre
 * scope de mode et y applique le flag admin. Sans ça, il n'a aucun scope et
 * n'est jamais substitué (selfheal restait sur claude-sonnet-4.6).
 */
export async function runWithRememberedVelbaz2<T>(fn: () => Promise<T>): Promise<T> {
  return runWithModelMode(async () => {
    if (await getVelbaz2Flag()) applyRememberedVelbaz2(true);
    return fn();
  });
}

/**
 * Job planifié HORS requête pour le compte d'un utilisateur (autopilot,
 * heartbeat, money-maker) : ouvre un scope et y applique le mode de CE compte.
 * Sans ça ces jobs n'ont aucun scope et tournaient sur les anciens modèles
 * (claude-sonnet-4.6 / gpt-5.4-mini) alors que le compte est en Velbaz.
 */
export async function runWithVelbazModeForUser<T>(userId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return runWithModelMode(async () => {
    // Pas de repli silencieux : si le compte est illisible (après retries), le
    // job échoue au lieu de tourner sur les anciens modèles.
    const user = userId
      ? (await dbRetry(() => db.select({ email: schema.users.email, role: schema.users.role })
          .from(schema.users).where(eq(schema.users.id, userId)).get())) || null
      : null;
    if (await velbazModeForUser(user)) applyRememberedVelbaz2(true);
    return fn();
  });
}

/** Idem, à partir de l'entreprise (le mode suit son propriétaire). */
export async function runWithVelbazModeForCompany<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const ownerId = (await dbRetry(() => db.select({ userId: schema.companies.userId })
    .from(schema.companies).where(eq(schema.companies.id, companyId)).get()))?.userId ?? null;
  return runWithVelbazModeForUser(ownerId, fn);
}
