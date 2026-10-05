import { describe, expect, test } from 'bun:test';
import {
  atLocal, clampToWorkWindow, desiredTime, formatLocalWhen, planTaskTimes, safeTimeZone,
  slotOf, timeForChosenDate, timeForSlot, zonedParts, zonedTimeToUtc,
  compareTasksByTime, resequenceTimes,
} from './autopilot-schedule';

const TZ = 'Europe/Paris'; // UTC+2 le 1er octobre 2026
const W = { workStartHour: 7, workEndHour: 22 };
// 1er oct. 2026, 16:10 UTC = 18:10 à Paris (le cas réel AtelierRue).
const NOW = new Date('2026-10-01T16:10:56Z');

describe('fuseaux', () => {
  test('zonedParts / zonedTimeToUtc aller-retour', () => {
    const p = zonedParts(NOW, TZ);
    expect(p).toMatchObject({ year: 2026, month: 10, day: 1, hour: 18, minute: 10 });
    expect(zonedTimeToUtc(2026, 10, 1, 18, 10, TZ).toISOString()).toBe('2026-10-01T16:10:00.000Z');
  });
  test('changement d\'heure (hiver) géré', () => {
    // 25 oct. 2026 : Paris repasse en UTC+1.
    expect(zonedTimeToUtc(2026, 10, 26, 9, 0, TZ).toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(atLocal(new Date('2026-10-24T10:00:00Z'), 9, 0, TZ, 2).toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });
  test('fuseau invalide → défaut', () => {
    expect(safeTimeZone('Not/AZone')).toBe('Europe/Paris');
    expect(safeTimeZone('America/New_York')).toBe('America/New_York');
    expect(safeTimeZone(undefined)).toBe('Europe/Paris');
  });
  test('créneau calculé en heure locale, pas en UTC', () => {
    // 16:10 UTC = 18:10 Paris → soir (en UTC ce serait « midi »).
    expect(slotOf(NOW, TZ)).toBe('evening');
    // 10:30 UTC = 12:30 Paris → midi (en UTC ce serait « matin »).
    expect(slotOf(new Date('2026-10-01T10:30:00Z'), TZ)).toBe('noon');
  });
});

describe('jamais dans le passé', () => {
  test('heure déjà passée → au plus tôt, pas à 8 h', () => {
    const d = desiredTime({ hour: 8 }, NOW, TZ);
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
    expect(d.getTime() - NOW.getTime()).toBeLessThanOrEqual(10 * 60 * 1000);
  });
  test('heure à venir conservée', () => {
    expect(desiredTime({ hour: 21 }, NOW, TZ).toISOString()).toBe('2026-10-01T19:00:00.000Z');
  });
  test('créneau à venir → son début ; en cours / passé → bientôt', () => {
    const morningNow = new Date('2026-10-01T05:00:00Z'); // 7 h Paris
    expect(desiredTime({ slot: 'noon' }, morningNow, TZ).toISOString()).toBe('2026-10-01T10:00:00.000Z');
    const soon = desiredTime({ slot: 'morning' }, NOW, TZ);
    expect(soon.getTime()).toBeGreaterThan(NOW.getTime());
    expect(soon.getTime() - NOW.getTime()).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe('planTaskTimes', () => {
  test('le lot AtelierRue (8h→21h demandé à 18h10) : tout dans le futur, espacé, ordre respecté', () => {
    const inputs = [
      { hour: 8, slot: 'morning' }, { hour: 9, slot: 'morning' }, { hour: 10, slot: 'morning' },
      { hour: 12, slot: 'noon' }, { hour: 13, slot: 'noon' }, { hour: 21, slot: 'evening' },
    ];
    const out = planTaskTimes(inputs, { now: NOW, tz: TZ, ...W });
    const ts = out.map(o => o.scheduledFor.getTime());
    for (const t of ts) expect(t).toBeGreaterThan(NOW.getTime());
    const sorted = [...ts].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(30 * 60 * 1000);
    // Les tâches « en retard » passent dans l'ordre demandé (8h avant 9h avant 10h…).
    expect(ts[0]).toBeLessThan(ts[1]);
    expect(ts[1]).toBeLessThan(ts[2]);
    // Créneau = déduit de la date finale (soir), plus jamais « matin » à 18 h.
    for (const o of out) {
      expect(o.timeSlot).toBe(slotOf(o.scheduledFor, TZ));
      expect(o.hasExactTime).toBe(true);
    }
    // Aucune tâche hors plage de travail (7-22 h UTC).
    for (const o of out) {
      const h = o.scheduledFor.getUTCHours();
      expect(h >= 7 && h <= 22).toBe(true);
    }
  });
  test('ne s\'empile pas sur les tâches déjà prévues', () => {
    const taken = [new Date('2026-10-01T16:20:00Z')];
    const [o] = planTaskTimes([{}], { now: NOW, tz: TZ, ...W, taken });
    expect(Math.abs(o.scheduledFor.getTime() - taken[0].getTime())).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
  test('fin de journée de travail dépassée → lendemain au début de la plage', () => {
    const late = new Date('2026-10-01T22:50:00Z');
    const out = planTaskTimes([{}, {}], { now: late, tz: TZ, ...W });
    expect(out[0].scheduledFor.getTime()).toBeGreaterThan(late.getTime());
    const hours = out.map(o => o.scheduledFor.getUTCHours());
    for (const h of hours) expect(h >= 7 && h <= 22).toBe(true);
  });
});

describe('clampToWorkWindow', () => {
  test('avant / après la plage', () => {
    expect(clampToWorkWindow(new Date('2026-10-01T05:00:00Z'), W).toISOString()).toBe('2026-10-01T07:00:00.000Z');
    expect(clampToWorkWindow(new Date('2026-10-01T23:10:00Z'), W).toISOString()).toBe('2026-10-02T07:00:00.000Z');
    expect(clampToWorkWindow(new Date('2026-10-01T22:40:00Z'), W).toISOString()).toBe('2026-10-01T22:40:00.000Z');
  });
});

describe('ajout manuel / date choisie', () => {
  test('« + » dans le créneau en cours → dans 2 min', () => {
    const d = timeForSlot('evening', NOW, TZ);
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
    expect(d.getTime() - NOW.getTime()).toBeLessThanOrEqual(3 * 60 * 1000);
  });
  test('« + » dans un créneau passé → demain', () => {
    expect(timeForSlot('morning', NOW, TZ).toISOString()).toBe('2026-10-02T04:00:00.000Z'); // 6 h Paris
  });
  test('« + » dans un créneau à venir → son début', () => {
    const am = new Date('2026-10-01T06:00:00Z'); // 8 h Paris
    expect(timeForSlot('noon', am, TZ).toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });
  test('date + heure dans le passé → dans 1 min', () => {
    const d = timeForChosenDate({ localDate: '2026-10-01', time: '10:00', hasExactTime: true }, NOW, TZ);
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
    expect(d.getTime() - NOW.getTime()).toBeLessThanOrEqual(2 * 60 * 1000);
  });
  test('date + heure future en heure locale', () => {
    expect(timeForChosenDate({ localDate: '2026-10-03', time: '14:30', hasExactTime: true }, NOW, TZ).toISOString())
      .toBe('2026-10-03T12:30:00.000Z');
  });
  test('date seule → 9 h locale ce jour-là (plus minuit)', () => {
    expect(timeForChosenDate({ localDate: '2026-10-05', hasExactTime: false }, NOW, TZ).toISOString())
      .toBe('2026-10-05T07:00:00.000Z');
    // Ancien client : ISO de minuit local → 9 h ce jour-là.
    expect(timeForChosenDate({ iso: '2026-10-04T22:00:00.000Z', hasExactTime: false }, NOW, TZ).toISOString())
      .toBe('2026-10-05T07:00:00.000Z');
  });
  test('formatLocalWhen', () => {
    expect(formatLocalWhen(new Date('2026-10-01T16:30:00Z'), NOW, TZ)).toBe('18:30');
    expect(formatLocalWhen(new Date('2026-10-02T07:00:00Z'), NOW, TZ)).toBe('demain 09:00');
  });
});

describe('ordre = heures (2026-10-01)', () => {
  test('tri par heure, puis ordre manuel, sans date en dernier', () => {
    const rows = [
      { id: 'a', scheduledFor: '2026-10-01T19:00:00Z', slotOrder: 0 },
      { id: 'b', scheduledFor: '2026-10-01T18:00:00Z', slotOrder: 3 },
      { id: 'c', scheduledFor: null, slotOrder: 0 },
      { id: 'd', scheduledFor: '2026-10-01T19:30:00Z', slotOrder: 1 },
      { id: 'e', scheduledFor: '2026-10-01T18:30:00Z', slotOrder: 2 },
    ];
    expect(rows.sort(compareTasksByTime).map(r => r.id).join('')).toBe('beadc');
  });
  test('glisser une tâche en tête lui donne la première heure', () => {
    const now = new Date('2026-10-01T16:00:00Z');
    const t = (h: string) => new Date(`2026-10-01T${h}:00Z`);
    // nouvel ordre : la tâche de 20:00 glissée devant celles de 18:00 et 19:00
    const out = resequenceTimes([t('20:00'), t('18:00'), t('19:00')], { now, fallback: now });
    expect(out.map(d => d.toISOString().slice(11, 16))).toEqual(['18:00', '19:00', '20:00']);
  });
  test('heures identiques → écartées, jamais dans le passé', () => {
    const now = new Date('2026-10-01T18:10:00Z');
    const t = new Date('2026-10-01T18:00:00Z');
    const out = resequenceTimes([t, t, null], { now, fallback: t });
    expect(out.map(d => d.toISOString().slice(11, 16))).toEqual(['18:11', '18:26', '18:41']);
  });
});
