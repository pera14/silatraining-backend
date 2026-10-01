import { peakConcurrency, RULES } from '@sila/contracts';
import { DateTime } from 'luxon';

export const SLOT_MS = RULES.practiceMinutes * 60_000;

/**
 * Local date + local "HH:mm" → UTC start instant of a slot, or `null` when that local time does not exist.
 *
 * On the last Sunday of March 02:00–02:59 is skipped; Luxon silently shifts such times forward (02:30 → 03:30),
 * which would create a slot the trainer never asked for, so the round trip is checked. On the last Sunday of
 * October 02:00–02:59 happens twice; the first occurrence (summer time) is used.
 */
export function localSlotStart(day: string, time: string, zone: string): Date | null {
  const dt = DateTime.fromISO(`${day}T${time}`, { zone });
  if (!dt.isValid || dt.toISODate() !== day || dt.toFormat('HH:mm') !== time) return null;
  return dt.toJSDate();
}

/** A slot starts on :00 or :30 local time with no seconds (SPEC §4). */
export function isValidSlotStart(instant: Date, zone: string): boolean {
  const dt = DateTime.fromJSDate(instant, { zone });
  return (dt.minute === 0 || dt.minute === 30) && dt.second === 0 && dt.millisecond === 0;
}

export function slotEnd(startsAt: Date): Date {
  return new Date(startsAt.getTime() + SLOT_MS);
}

/** Two 60-minute slots overlap when their starts are less than 60 minutes apart. */
export function slotsOverlap(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) < SLOT_MS;
}

/**
 * Starts in `candidates` that overlap an `existing` start or another candidate. Both lists are small (at most a
 * few thousand), so a sort + neighbour scan is plenty.
 */
export function findOverlaps(candidates: Date[], existing: Date[]): Date[] {
  const all = [
    ...candidates.map((d) => ({ t: d.getTime(), candidate: true })),
    ...existing.map((d) => ({ t: d.getTime(), candidate: false })),
  ].sort((x, y) => x.t - y.t);
  const hits = new Set<number>();
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1]!;
    const cur = all[i]!;
    if (cur.t - prev.t < SLOT_MS && (prev.candidate || cur.candidate)) {
      if (prev.candidate) hits.add(prev.t);
      if (cur.candidate) hits.add(cur.t);
    }
  }
  return [...hits].sort((a, b) => a - b).map((t) => new Date(t));
}

/** Peak number of slots running at once within `candidate`'s hour, the candidate included (parallel-slot cap). */
export function maxConcurrency(candidate: Date, existing: Date[]): number {
  return peakConcurrency(
    candidate.getTime(),
    existing.map((d) => d.getTime()),
  );
}
