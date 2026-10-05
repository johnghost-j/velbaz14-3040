/**
 * MESURE DU MONDE RÉEL
 *
 * Avant ce module, aucun agent ne savait ce qui se passait sur les sites
 * générés : zéro table de visites, `stats_snapshots` morte, et l'agent
 * `analytics` ne voyait que les métriques des posts sociaux. Résultat : les
 * décisions « keep / improve / kill » se prenaient sans savoir si le site
 * recevait du trafic, d'où il venait, et où les visiteurs décrochaient.
 *
 * Ici on écrit et on lit la table `site_visits` (créée par
 * `ensureRuntimeTables`). Un événement = une ligne :
 *   pageview        → une page vue
 *   lead            → un email capturé
 *   checkout_start  → un tunnel de paiement ouvert
 *   purchase        → un paiement encaissé (écrit côté serveur, pas le navigateur)
 *
 * Toutes les écritures sont non-bloquantes et n'échouent jamais vers l'appelant :
 * un beacon qui rate ne doit jamais casser une page ni un webhook Stripe.
 */

import { client } from '../database/client';
import { ensureRuntimeTables } from '../database/runtime-tables';
import { attribute, normalizePath, type Channel } from './attribution';
import type { ChannelRow, DayRow, PathRow, SiteAnalytics } from './brief';
import { v4 as uuidv4 } from 'uuid';

// Les fonctions purement calculatoires (résumé, diagnostic de fuite) vivent dans
// `brief.ts` pour rester testables sans base de données. On les ré-exporte ici
// afin que les appelants n'aient qu'un seul point d'entrée.
export { analyticsBrief, biggestLeak } from './brief';
export type { ChannelRow, DayRow, PathRow, SiteAnalytics } from './brief';

export type VisitEvent = 'pageview' | 'lead' | 'checkout_start' | 'purchase' | 'checkout_return';

export const VISIT_EVENTS: VisitEvent[] = ['pageview', 'lead', 'checkout_start', 'purchase', 'checkout_return'];

/** Étapes du tunnel, dans l'ordre. */
export const FUNNEL_STEPS: VisitEvent[] = ['pageview', 'lead', 'checkout_start', 'purchase'];

export type RecordVisitInput = {
  companyId: string;
  /** Identifiant de session côté navigateur (ou synthétique côté serveur). */
  sessionId?: string | null;
  event?: VisitEvent;
  /** URL ou chemin de la page. Les UTM y sont lus. */
  url?: string | null;
  referrer?: string | null;
  userAgent?: string | null;
  country?: string | null;
  /** Montant associé (purchase). */
  value?: number | null;
  meta?: Record<string, unknown> | null;
  /** Canal forcé (événement serveur : on connaît déjà la source). */
  channel?: Channel;
  /** Enregistrer même si l'UA ressemble à un bot (événements serveur). */
  allowBot?: boolean;
  /** Session Stripe liée (checkout_return, purchase) — sert à attribuer le CA. */
  stripeSessionId?: string | null;
};

export type RecordVisitResult = { recorded: boolean; reason?: string; id?: string };

function isEvent(v: unknown): v is VisitEvent {
  return typeof v === 'string' && (VISIT_EVENTS as string[]).includes(v);
}

/**
 * Enregistre un événement de visite. Ne lève jamais.
 * Les bots et le trafic interne (éditeur Velbaz) sont rejetés : compter les
 * crawlers comme des visiteurs rendrait toutes les décisions fausses.
 */
export async function recordVisit(input: RecordVisitInput): Promise<RecordVisitResult> {
  try {
    if (!input.companyId) return { recorded: false, reason: 'no_company' };
    await ensureRuntimeTables();

    const event: VisitEvent = isEvent(input.event) ? input.event : 'pageview';
    const attr = attribute({ referrer: input.referrer, url: input.url, userAgent: input.userAgent });

    if (attr.bot && !input.allowBot) return { recorded: false, reason: 'bot' };
    let channel = input.channel ?? attr.channel;

    const id = uuidv4();
    const sessionId = (input.sessionId || '').trim().slice(0, 64) || `srv_${id.slice(0, 8)}`;

    // Attribution au niveau SESSION, premier contact : une session a un seul
    // canal d'acquisition, celui de sa première page vue. Tout ce qui suit en
    // hérite. Sans cette règle, trois choses cassaient :
    //  1. Un lead / checkout / achat était crédité à la page où le visiteur a
    //     cliqué : venu d'une pub, il achetait depuis /pricing (sans UTM) et
    //     ressortait en « direct » — la pub semblait ne rien rapporter.
    //  2. La navigation interne (page A → page B) a pour référent le site
    //     lui-même : `attribute()` la classe « internal » et elle était jetée,
    //     donc on ne mesurait que la page d'entrée et jamais le parcours.
    //  3. Le retour de paiement (référent checkout.stripe.com) inventait une
    //     visite « referral » en plein milieu du tunnel.
    const firstTouch = input.channel ? null : await firstTouchChannel(sessionId);
    if (firstTouch) channel = firstTouch;

    // Reste « internal » sans premier contact : ce n'est pas un visiteur mais
    // l'éditeur / le tableau de bord Velbaz qui ouvre le site. Rejeté, sinon le
    // propriétaire gonflerait ses propres chiffres à chaque coup d'œil.
    if (channel === 'internal') return { recorded: false, reason: 'internal' };
    const value = typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : null;

    await client.execute({
      sql: `INSERT INTO site_visits
        (id, company_id, session_id, event, path, channel, referrer_host, utm_source, utm_medium, utm_campaign, device, country, value, meta, stripe_session_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        input.companyId,
        sessionId,
        event,
        normalizePath(input.url),
        channel,
        attr.referrerHost || null,
        attr.utmSource,
        attr.utmMedium,
        attr.utmCampaign,
        attr.device,
        (input.country || '').trim().slice(0, 8) || null,
        value,
        input.meta ? JSON.stringify(input.meta).slice(0, 2000) : null,
        (input.stripeSessionId || '').trim().slice(0, 120) || null,
      ],
    });
    return { recorded: true, id };
  } catch (e: any) {
    console.error('[analytics] recordVisit failed:', e?.message);
    return { recorded: false, reason: 'error' };
  }
}

/** Canal du premier pageview d'une session. Null si la session est inconnue. */
export async function firstTouchChannel(sessionId: string): Promise<Channel | null> {
  try {
    const r = await client.execute({
      sql: `SELECT channel FROM site_visits WHERE session_id = ? AND event = 'pageview'
            ORDER BY created_at ASC LIMIT 1`,
      args: [sessionId],
    });
    const ch = (r.rows as any[])[0]?.channel;
    return ch ? (String(ch) as Channel) : null;
  } catch { return null; }
}

/**
 * Ce qu'on sait de l'intention d'une session : combien de pages vues, si le
 * paiement a été ouvert, et par quel canal la personne est arrivée.
 *
 * Sert à scorer un lead entrant au moment où il laisse son email : un visiteur
 * qui a lu 6 pages et ouvert le checkout n'a pas la même valeur que celui qui
 * remplit le formulaire depuis la page d'accueil. `site_visits` est une table
 * créée au runtime (hors schéma Drizzle), d'où le SQL direct.
 */
export async function sessionIntent(sessionId: string): Promise<{
  pageviews: number;
  checkoutStarted: boolean;
  channel: Channel | null;
}> {
  const empty = { pageviews: 0, checkoutStarted: false, channel: null };
  try {
    if (!sessionId) return empty;
    const r = await client.execute({
      sql: `SELECT
              SUM(CASE WHEN event = 'pageview' THEN 1 ELSE 0 END) AS pv,
              SUM(CASE WHEN event = 'checkout_start' THEN 1 ELSE 0 END) AS co
            FROM site_visits WHERE session_id = ?`,
      args: [sessionId],
    });
    const row = (r.rows as any[])[0] || {};
    return {
      pageviews: Number(row.pv || 0),
      checkoutStarted: Number(row.co || 0) > 0,
      channel: await firstTouchChannel(sessionId),
    };
  } catch { return empty; }
}

/**
 * Retrouve le visiteur derrière un paiement Stripe.
 *
 * La balise enregistre un `checkout_return` sur la page de succès (qui porte
 * `?session_id=...`) : c'est le seul pont fiable entre le navigateur et Stripe,
 * puisque le code du site généré est écrit par l'IA et ne transmet rien. Grâce à
 * ça, le CA encaissé est crédité au vrai canal d'acquisition.
 */
export async function resolveVisitorForStripeSession(
  stripeSessionId: string,
): Promise<{ sessionId: string; channel: Channel } | null> {
  try {
    if (!stripeSessionId) return null;
    await ensureRuntimeTables();
    const r = await client.execute({
      sql: `SELECT session_id, channel FROM site_visits
            WHERE stripe_session_id = ? ORDER BY created_at ASC LIMIT 1`,
      args: [stripeSessionId],
    });
    const row = (r.rows as any[])[0];
    if (!row?.session_id) return null;
    const sessionId = String(row.session_id);
    const channel = (await firstTouchChannel(sessionId)) || (String(row.channel || 'direct') as Channel);
    return { sessionId, channel };
  } catch { return null; }
}

// ─── Lecture / agrégation ────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const EMPTY_ANALYTICS = (windowDays: number): SiteAnalytics => ({
  windowDays,
  pageviews: 0,
  visitors: 0,
  funnel: { pageview: 0, lead: 0, checkout_start: 0, purchase: 0 },
  conversionRate: 0,
  leadRate: 0,
  revenue: 0,
  channels: [],
  topPaths: [],
  daily: [],
  devices: [],
});

/** Lit les métriques réelles d'un site sur `windowDays` jours. Ne lève jamais. */
export async function getSiteAnalytics(companyId: string, windowDays = 30): Promise<SiteAnalytics> {
  const out = EMPTY_ANALYTICS(windowDays);
  try {
    await ensureRuntimeTables();
    const since = Math.floor(Date.now() / 1000) - windowDays * 86400;

    const byEvent = await client.execute({
      sql: `SELECT event, COUNT(*) AS n, COUNT(DISTINCT session_id) AS s, COALESCE(SUM(value),0) AS v
            FROM site_visits WHERE company_id = ? AND created_at >= ? GROUP BY event`,
      args: [companyId, since],
    });
    for (const r of byEvent.rows as any[]) {
      const ev = String(r.event || '');
      if (ev in out.funnel) (out.funnel as any)[ev] = num(r.n);
      if (ev === 'purchase') out.revenue = num(r.v);
      if (ev === 'pageview') { out.pageviews = num(r.n); out.visitors = num(r.s); }
    }
    if (out.visitors > 0) {
      out.conversionRate = out.funnel.purchase / out.visitors;
      out.leadRate = out.funnel.lead / out.visitors;
    }

    const byChannel = await client.execute({
      sql: `SELECT channel,
                   SUM(CASE WHEN event = 'pageview' THEN 1 ELSE 0 END) AS visits,
                   COUNT(DISTINCT session_id) AS sessions,
                   SUM(CASE WHEN event = 'purchase' THEN 1 ELSE 0 END) AS purchases,
                   COALESCE(SUM(CASE WHEN event = 'purchase' THEN value ELSE 0 END),0) AS revenue
            FROM site_visits WHERE company_id = ? AND created_at >= ?
            GROUP BY channel ORDER BY visits DESC`,
      args: [companyId, since],
    });
    out.channels = (byChannel.rows as any[]).map((r) => ({
      channel: String(r.channel || 'direct'),
      visits: num(r.visits),
      sessions: num(r.sessions),
      purchases: num(r.purchases),
      revenue: num(r.revenue),
    }));

    const byPath = await client.execute({
      sql: `SELECT path, COUNT(*) AS n FROM site_visits
            WHERE company_id = ? AND created_at >= ? AND event = 'pageview'
            GROUP BY path ORDER BY n DESC LIMIT 12`,
      args: [companyId, since],
    });
    out.topPaths = (byPath.rows as any[]).map((r) => ({ path: String(r.path || '/'), views: num(r.n) }));

    const byDay = await client.execute({
      sql: `SELECT date(created_at, 'unixepoch') AS day,
                   SUM(CASE WHEN event = 'pageview' THEN 1 ELSE 0 END) AS n,
                   COUNT(DISTINCT session_id) AS s
            FROM site_visits WHERE company_id = ? AND created_at >= ?
            GROUP BY day ORDER BY day ASC`,
      args: [companyId, since],
    });
    out.daily = (byDay.rows as any[]).map((r) => ({ day: String(r.day || ''), visits: num(r.n), sessions: num(r.s) }));

    const byDevice = await client.execute({
      sql: `SELECT COALESCE(device,'unknown') AS device, COUNT(DISTINCT session_id) AS s
            FROM site_visits WHERE company_id = ? AND created_at >= ?
            GROUP BY device ORDER BY s DESC`,
      args: [companyId, since],
    });
    out.devices = (byDevice.rows as any[]).map((r) => ({ device: String(r.device), sessions: num(r.s) }));

    return out;
  } catch (e: any) {
    console.error('[analytics] getSiteAnalytics failed:', e?.message);
    return out;
  }
}
