import { addDays, daysBetween, isoWeekday, localDayWindow, startOfLocalDay } from './local-day';

const zone = 'Europe/Belgrade';
const hours = (w: { start: Date; end: Date }) => (w.end.getTime() - w.start.getTime()) / 3_600_000;

describe('local-day helpers (Europe/Belgrade)', () => {
  it('builds 24h windows on normal days', () => {
    const w = localDayWindow('2026-10-05', zone);
    expect(w.start.toISOString()).toBe('2026-10-04T22:00:00.000Z');
    expect(hours(w)).toBe(24);
  });

  it('builds a 23h window on the last Sunday of March and 25h on the last Sunday of October', () => {
    expect(hours(localDayWindow('2027-03-28', zone))).toBe(23);
    expect(hours(localDayWindow('2026-10-25', zone))).toBe(25);
    expect(localDayWindow('2026-10-25', zone).end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('finds local midnight', () => {
    expect(startOfLocalDay(new Date('2026-10-05T21:59:00Z'), zone).toISOString()).toBe(
      '2026-10-04T22:00:00.000Z',
    );
    expect(startOfLocalDay(new Date('2026-10-05T22:00:00Z'), zone).toISOString()).toBe(
      '2026-10-05T22:00:00.000Z',
    );
  });

  it('does calendar arithmetic', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-03-27', 2)).toBe('2027-03-29');
    expect(daysBetween('2026-10-01', '2026-10-06')).toBe(5);
    expect(daysBetween('2026-10-06', '2026-10-01')).toBe(-5);
    expect(isoWeekday('2026-10-05')).toBe(1);
    expect(isoWeekday('2026-10-25')).toBe(7);
  });
});
