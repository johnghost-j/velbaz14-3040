/**
 * AUTOPILOT — calcul des horaires des tâches (module PUR, sans DB ni IA).
 *
 * [2026-10-01] Bug signalé : « quand j'active le mode auto, il met des tâches
 * à une heure déjà passée ». Cause : chaque tâche générée était datée
 * `aujourd'hui à <heure demandée par l'IA>` sans jamais comparer à l'heure
 * actuelle. Activer le mode auto à 18 h créait donc des tâches à 8 h, 9 h,
 * 10 h… qui partaient toutes d'un coup, dans le désordre.
 *
 * Règles appliquées ici, partout où une date de tâche est fixée :
 *  - jamais dans le passé : une heure / un créneau déjà passé est ramené au
 *    plus tôt possible (ou au lendemain si la journée de travail est finie) ;
 *  - les tâches générées sont espacées (30 min) pour s'exécuter une par une ;
 *  - elles restent dans la plage de travail (heures UTC de la config) ;
 *  - le créneau affiché (matin / midi / soir) est TOUJOURS déduit de la date
 *    finale, dans le fuseau de l'utilisateur — plus de tâche « matin » à 18 h.
 */

export type TimeSlot = 'morning' | 'noon' | 'evening';

export const DEFAULT_TIMEZONE = 'Europe/Paris';

// Créneaux en heure LOCALE de l'utilisateur : matin 6-12, midi 12-18, soir 18-24.
export const SLOT_RANGES: Record<TimeSlot, [number, number]> = {
  morning: [6, 12],
  noon: [12, 18],
  evening: [18, 24],
};

const MIN = 60 * 1000;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function safeTimeZone(tz?: unknown): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number }

/** Date → composantes (année, mois 1-12, jour, heure, minute) dans le fuseau donné. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour === 24 ? 0 : p.hour, minute: p.minute };
}

/** Heure murale (dans le fuseau tz) → instant UTC. Gère les changements d'heure. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = target - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function slotFromHour(hour: number): TimeSlot {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'noon';
  return 'evening';
}

/** Créneau (matin / midi / soir) d'une date, dans le fuseau de l'utilisateur. */
export function slotOf(date: Date, tz: string): TimeSlot {
  return slotFromHour(zonedParts(date, tz).hour);
}

/** Même jour local que `ref`, à hh:mm locale. `dayOffset` décale de N jours. */
export function atLocal(ref: Date, hour: number, minute: number, tz: string, dayOffset = 0): Date {
  const p = zonedParts(ref, tz);
  // Passe par midi UTC du jour local pour ajouter des jours sans souci d'heure d'été.
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset, 12));
  if (hour >= 24) { hour -= 24; base.setUTCDate(base.getUTCDate() + 1); }
  return zonedTimeToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, minute, tz);
}

/** Arrondit à la minute multiple de `step` supérieure. */
export function ceilToMinutes(d: Date, step = 5): Date {
  const ms = step * MIN;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

export interface WorkWindow { workStartHour: number; workEndHour: number }

/**
 * Ramène une date dans la plage de travail (heures UTC, fin INCLUSE comme le
 * tick historique : workEndHour=22 → on travaille jusqu'à 22:59 UTC).
 */
export function clampToWorkWindow(d: Date, w: WorkWindow): Date {
  const start = Math.max(0, Math.min(23, w.workStartHour | 0));
  const end = Math.max(start, Math.min(23, w.workEndHour | 0));
  const h = d.getUTCHours();
  if (h < start) {
    const r = new Date(d); r.setUTCHours(start, 0, 0, 0); return r;
  }
  if (h > end) {
    const r = new Date(d); r.setUTCDate(r.getUTCDate() + 1); r.setUTCHours(start, 0, 0, 0); return r;
  }
  return d;
}

export interface PlanInput {
  /** Créneau souhaité par l'IA / l'utilisateur. */
  slot?: TimeSlot | string | null;
  /** Heure LOCALE souhaitée (0-23), optionnelle. */
  hour?: number | null;
}

export interface PlannedTime { scheduledFor: Date; timeSlot: TimeSlot; hasExactTime: boolean }

export interface PlanOptions extends WorkWindow {
  now: Date;
  tz: string;
  /** Écart minimum entre deux tâches générées (min). Défaut 30. */
  gapMinutes?: number;
  /** Délai avant la toute première exécution possible (min). Défaut 5. */
  leadMinutes?: number;
  /** Dates déjà occupées par des tâches en attente (pour ne pas les empiler). */
  taken?: Date[];
}

function normSlot(s: unknown): TimeSlot | undefined {
  return s === 'morning' || s === 'noon' || s === 'evening' ? s : undefined;
}

/**
 * Date « voulue » d'une tâche générée, AVANT espacement : jamais dans le passé.
 * - heure précise encore à venir → cette heure aujourd'hui ;
 * - créneau à venir → début du créneau aujourd'hui ;
 * - créneau en cours → maintenant (+ délai) ;
 * - heure / créneau déjà passé → au plus tôt (la tâche n'est pas perdue :
 *   la planification la fait simplement passer après les autres).
 */
export function desiredTime(input: PlanInput, now: Date, tz: string, leadMinutes = 5): Date {
  const earliest = ceilToMinutes(new Date(now.getTime() + leadMinutes * MIN), 5);
  const hour = typeof input.hour === 'number' && Number.isFinite(input.hour)
    ? Math.max(0, Math.min(23, Math.floor(input.hour)))
    : null;
  const slot = normSlot(input.slot);
  let want: Date;
  if (hour !== null) want = atLocal(now, hour, 0, tz);
  else if (slot) {
    const [s, e] = SLOT_RANGES[slot];
    const start = atLocal(now, s, 0, tz);
    const end = atLocal(now, e, 0, tz);
    want = now.getTime() < end.getTime() ? start : earliest;
  } else want = earliest;
  return want.getTime() < earliest.getTime() ? earliest : want;
}

/**
 * Planifie un LOT de tâches générées : jamais dans le passé, dans la plage de
 * travail, espacées de `gapMinutes`, sans chevaucher les tâches déjà prévues.
 * Le résultat garde l'ordre d'entrée.
 */
export function planTaskTimes(inputs: PlanInput[], opts: PlanOptions): PlannedTime[] {
  const gap = (opts.gapMinutes ?? 30) * MIN;
  const lead = opts.leadMinutes ?? 5;
  const occupied: number[] = (opts.taken || []).map(d => d.getTime()).filter(Number.isFinite);
  const wanted = inputs.map((inp, i) => ({ i, t: clampToWorkWindow(desiredTime(inp, opts.now, opts.tz, lead), opts).getTime() }));
  // Les plus tôt d'abord, pour que l'espacement pousse vers l'avant sans trou.
  const order = [...wanted].sort((a, b) => a.t - b.t || a.i - b.i);
  const out: PlannedTime[] = new Array(inputs.length);
  for (const w of order) {
    let t = w.t;
    for (let guard = 0; guard < 200; guard++) {
      const clash = occupied.find(o => Math.abs(o - t) < gap);
      if (clash === undefined) break;
      t = clampToWorkWindow(new Date(clash + gap), opts).getTime();
    }
    occupied.push(t);
    const d = new Date(t);
    out[w.i] = { scheduledFor: d, timeSlot: slotOf(d, opts.tz), hasExactTime: true };
  }
  return out;
}

/**
 * Tâche ajoutée à la main dans un créneau (bouton « + ») ou déplacée par
 * glisser-déposer : créneau en cours → dans quelques minutes ; créneau à
 * venir aujourd'hui → son début ; créneau déjà fini → son début demain.
 */
export function timeForSlot(slot: TimeSlot, now: Date, tz: string, leadMinutes = 2): Date {
  const [s, e] = SLOT_RANGES[slot];
  const start = atLocal(now, s, 0, tz);
  const end = atLocal(now, e, 0, tz);
  if (now.getTime() >= end.getTime()) return atLocal(now, s, 0, tz, 1);
  if (now.getTime() >= start.getTime()) return ceilToMinutes(new Date(now.getTime() + leadMinutes * MIN), 1);
  return start;
}

/**
 * Date choisie dans le menu « Choisir une date ».
 * - avec heure : telle quelle, mais jamais dans le passé (→ dans 1 min) ;
 * - sans heure : ce jour-là à 9 h locale ; si c'est aujourd'hui et que 9 h
 *   est passée → dans quelques minutes.
 * `localDate` = « AAAA-MM-JJ » dans le fuseau de l'utilisateur.
 */
export function timeForChosenDate(
  input: { iso?: string | null; localDate?: string | null; time?: string | null; hasExactTime: boolean },
  now: Date,
  tz: string,
): Date {
  const soon = ceilToMinutes(new Date(now.getTime() + MIN), 1);
  let d: Date | null = null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.localDate || '');
  if (m) {
    const [hh, mm] = input.hasExactTime && /^\d{1,2}:\d{2}$/.test(input.time || '')
      ? (input.time as string).split(':').map(Number)
      : [9, 0];
    d = zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), hh, mm, tz);
  } else if (input.iso) {
    const parsed = new Date(input.iso);
    if (!isNaN(parsed.getTime())) {
      d = parsed;
      if (!input.hasExactTime) {
        const p = zonedParts(parsed, tz);
        d = zonedTimeToUtc(p.year, p.month, p.day, 9, 0, tz);
      }
    }
  }
  if (!d || isNaN(d.getTime())) return soon;
  return d.getTime() < soon.getTime() ? soon : d;
}

/** « 18:30 » (ou « demain 09:00 ») dans le fuseau de l'utilisateur, pour le chat. */
export function formatLocalWhen(d: Date, now: Date, tz: string): string {
  const p = zonedParts(d, tz);
  const n = zonedParts(now, tz);
  const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  if (p.year === n.year && p.month === n.month && p.day === n.day) return hm;
  const tomorrow = zonedParts(new Date(now.getTime() + 24 * 60 * MIN), tz);
  if (p.year === tomorrow.year && p.month === tomorrow.month && p.day === tomorrow.day) return `demain ${hm}`;
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')} ${hm}`;
}

/**
 * [2026-10-01] « Pas logique : des tâches avec des heures, pas dans l'ordre. »
 * Règle : l'ordre affiché = l'ordre des heures = l'ordre d'exécution.
 * Tri d'affichage : date prévue croissante (sans date en dernier), puis ordre manuel.
 */
export function compareTasksByTime(
  a: { scheduledFor?: Date | string | number | null; slotOrder?: number | null; createdAt?: Date | string | number | null },
  b: { scheduledFor?: Date | string | number | null; slotOrder?: number | null; createdAt?: Date | string | number | null },
): number {
  const ta = a.scheduledFor != null ? new Date(a.scheduledFor).getTime() : Infinity;
  const tb = b.scheduledFor != null ? new Date(b.scheduledFor).getTime() : Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  const oa = a.slotOrder ?? 0, ob = b.slotOrder ?? 0;
  if (oa !== ob) return oa - ob;
  const ca = a.createdAt != null ? new Date(a.createdAt).getTime() : 0;
  const cb = b.createdAt != null ? new Date(b.createdAt).getTime() : 0;
  return ca - cb;
}

/**
 * Après un glisser-déposer, les heures suivent le NOUVEL ordre du créneau :
 * on redistribue les heures existantes (triées) dans l'ordre choisi, avec un
 * écart minimal et jamais dans le passé. `times[i]` = heure actuelle de la
 * i-ème tâche dans le nouvel ordre (null → `fallback`).
 */
export function resequenceTimes(times: (Date | null)[], opts: { now: Date; fallback: Date; gapMinutes?: number }): Date[] {
  const gap = (opts.gapMinutes ?? 15) * MIN;
  const floor = ceilToMinutes(new Date(opts.now.getTime() + MIN), 1).getTime();
  const pool = times.map(t => (t && !isNaN(t.getTime()) ? t : opts.fallback).getTime()).sort((x, y) => x - y);
  const out: Date[] = [];
  let prev = -Infinity;
  for (const t0 of pool) {
    let t = Math.max(t0, floor);
    if (t < prev + gap) t = prev + gap;
    out.push(new Date(t));
    prev = t;
  }
  return out;
}
