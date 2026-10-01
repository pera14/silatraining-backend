import { describe, expect, it } from 'vitest';
import { peakConcurrency } from './slot-overlap';

const t = (hhmm: string) => Date.parse(`2026-10-05T${hhmm}:00Z`);

describe('peakConcurrency', () => {
  it('counts the candidate alone as 1', () => {
    expect(peakConcurrency(t('08:00'), [])).toBe(1);
  });

  it('counts a same-time slot and a half-overlapping slot', () => {
    expect(peakConcurrency(t('08:00'), [t('08:00')])).toBe(2);
    expect(peakConcurrency(t('08:30'), [t('08:00')])).toBe(2);
    expect(peakConcurrency(t('07:30'), [t('08:00')])).toBe(2);
  });

  it('ignores slots that only touch the candidate', () => {
    expect(peakConcurrency(t('08:00'), [t('07:00'), t('09:00')])).toBe(1);
  });

  it('finds the peak, not the total of overlapping slots', () => {
    // 07:30 and 08:30 both overlap 08:00 but never each other.
    expect(peakConcurrency(t('08:00'), [t('07:30'), t('08:30')])).toBe(2);
    expect(peakConcurrency(t('08:30'), [t('08:00'), t('08:30'), t('09:00')])).toBe(3);
  });
});
