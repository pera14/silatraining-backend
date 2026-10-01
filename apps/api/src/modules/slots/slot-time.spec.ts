import { findOverlaps, isValidSlotStart, localSlotStart, maxConcurrency } from './slot-time';

const zone = 'Europe/Belgrade';
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('localSlotStart', () => {
  it('converts local times with the right offset around DST', () => {
    expect(iso(localSlotStart('2027-03-27', '09:00', zone))).toBe('2027-03-27T08:00:00.000Z'); // CET
    expect(iso(localSlotStart('2027-03-28', '09:00', zone))).toBe('2027-03-28T07:00:00.000Z'); // CEST
    expect(iso(localSlotStart('2026-10-24', '09:00', zone))).toBe('2026-10-24T07:00:00.000Z'); // CEST
    expect(iso(localSlotStart('2026-10-25', '09:00', zone))).toBe('2026-10-25T08:00:00.000Z'); // CET
  });

  it('returns null inside the spring-forward gap', () => {
    expect(localSlotStart('2027-03-28', '02:00', zone)).toBeNull();
    expect(localSlotStart('2027-03-28', '02:30', zone)).toBeNull();
    expect(iso(localSlotStart('2027-03-28', '03:00', zone))).toBe('2027-03-28T01:00:00.000Z');
  });

  it('uses the first occurrence of an ambiguous fall-back time', () => {
    expect(iso(localSlotStart('2026-10-25', '02:30', zone))).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('isValidSlotStart', () => {
  it('accepts :00 and :30 only, without seconds', () => {
    expect(isValidSlotStart(new Date('2026-10-05T07:00:00Z'), zone)).toBe(true);
    expect(isValidSlotStart(new Date('2026-10-05T07:30:00Z'), zone)).toBe(true);
    expect(isValidSlotStart(new Date('2026-10-05T07:15:00Z'), zone)).toBe(false);
    expect(isValidSlotStart(new Date('2026-10-05T07:00:30Z'), zone)).toBe(false);
    expect(isValidSlotStart(new Date('2026-10-05T07:00:00.500Z'), zone)).toBe(false);
  });
});

describe('findOverlaps', () => {
  const d = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00Z`);

  it('finds candidates overlapping existing slots or each other', () => {
    expect(findOverlaps([d('09:30')], [d('09:00')])).toEqual([d('09:30')]);
    expect(findOverlaps([d('10:00')], [d('09:00')])).toEqual([]); // back-to-back is fine
    expect(findOverlaps([d('09:00'), d('09:30'), d('12:00')], [])).toEqual([
      d('09:00'),
      d('09:30'),
    ]);
    expect(findOverlaps([d('09:00')], [d('09:00')])).toEqual([d('09:00')]);
  });

  it('ignores overlaps between existing slots only', () => {
    expect(findOverlaps([d('12:00')], [d('09:00'), d('09:30')])).toEqual([]);
  });
});

describe('maxConcurrency', () => {
  // the sweep itself is covered in @sila/contracts (slot-overlap.spec.ts)
  it('counts a same-time and a half-overlapping slot, not touching ones', () => {
    const t = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00Z`);
    expect(maxConcurrency(t('08:00'), [t('08:00')])).toBe(2);
    expect(maxConcurrency(t('08:30'), [t('08:00'), t('08:30'), t('09:00')])).toBe(3);
    expect(maxConcurrency(t('08:00'), [t('07:00'), t('09:00')])).toBe(1);
  });
});
