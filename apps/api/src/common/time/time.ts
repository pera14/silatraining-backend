import { DateTime } from 'luxon';

/**
 * Time helpers. All instants are stored UTC (timestamptz); slot times are entered and shown in
 * APP_TIMEZONE (Europe/Belgrade). Use Luxon for every local-time computation so DST is handled.
 * Calendar days (`@db.Date` columns) are represented as `YYYY-MM-DD` strings in the API and as
 * UTC-midnight `Date`s in Prisma.
 */

/** Local calendar day (`YYYY-MM-DD`) of an instant in `zone`. */
export function localDay(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

/** Prisma `@db.Date` value → `YYYY-MM-DD`. */
export function dateOnlyToIso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → Prisma `@db.Date` value (UTC midnight). */
export function isoToDateOnly(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Local date + local "HH:mm" in `zone` → UTC instant. Throws for non-existent local times (DST gap). */
export function localToInstant(day: string, time: string, zone: string): Date {
  const dt = DateTime.fromISO(`${day}T${time}`, { zone });
  if (!dt.isValid)
    throw new Error(`Invalid local time ${day} ${time} in ${zone}: ${dt.invalidExplanation}`);
  return dt.toJSDate();
}

/** Adds calendar months then subtracts a day: package validity `validFrom + N months − 1 day`. */
export function addMonthsMinusDay(day: string, months: number): string {
  return DateTime.fromISO(day, { zone: 'utc' }).plus({ months }).minus({ days: 1 }).toISODate()!;
}

/** `validFrom + N weeks − 1 day` (extension limit). */
export function addWeeksMinusDay(day: string, weeks: number): string {
  return DateTime.fromISO(day, { zone: 'utc' }).plus({ weeks }).minus({ days: 1 }).toISODate()!;
}
