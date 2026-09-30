import { DateTime } from 'luxon';

/**
 * Local-day arithmetic in APP_TIMEZONE. A local day is not always 24h (23h on the last Sunday of March, 25h on
 * the last Sunday of October), so windows are built with Luxon, never with `+ 86_400_000`.
 */

/** [start, end) of the local calendar day `day` (`YYYY-MM-DD`) as UTC instants. */
export function localDayWindow(day: string, zone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(day, { zone }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/** Local midnight at the start of the day containing `instant`. */
export function startOfLocalDay(instant: Date, zone: string): Date {
  return DateTime.fromJSDate(instant, { zone }).startOf('day').toJSDate();
}

/** Calendar arithmetic on `YYYY-MM-DD` strings (zone-independent). */
export function addDays(day: string, days: number): string {
  return DateTime.fromISO(day, { zone: 'utc' }).plus({ days }).toISODate()!;
}

/** Whole days from `from` to `to` (`YYYY-MM-DD`), negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days')
      .days,
  );
}

/** ISO weekday of a calendar day, 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: string): number {
  return DateTime.fromISO(day, { zone: 'utc' }).weekday;
}
