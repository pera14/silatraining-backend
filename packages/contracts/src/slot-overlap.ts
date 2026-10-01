import { RULES } from './rules';

const SLOT_MS = RULES.practiceMinutes * 60_000;

/**
 * Peak number of slots running at the same moment within a candidate slot, the candidate included. Starts are
 * epoch milliseconds; every slot lasts RULES.practiceMinutes. Slots that only touch (one ends as the other
 * starts) do not overlap. The API uses this to enforce MAX_PARALLEL_SLOTS; the web uses it as a hint.
 */
export function peakConcurrency(candidateStart: number, existingStarts: readonly number[]): number {
  const end = candidateStart + SLOT_MS;
  // +1 at each start, −1 at each end; at equal instants ends sort first so touching slots don't count.
  const events: Array<[t: number, delta: 1 | -1]> = [
    [candidateStart, 1],
    [end, -1],
  ];
  for (const s of existingStarts) {
    if (s < end && s + SLOT_MS > candidateStart) events.push([s, 1], [s + SLOT_MS, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  let peak = 0;
  for (const [t, delta] of events) {
    running += delta;
    if (t >= candidateStart && t < end) peak = Math.max(peak, running);
  }
  return peak;
}
