import { addMonthsMinusDay, addWeeksMinusDay, localDay, localToInstant } from './time';

const ZONE = 'Europe/Belgrade';

describe('time helpers', () => {
  it('package validity: start + 1 month − 1 day', () => {
    expect(addMonthsMinusDay('2026-10-01', 1)).toBe('2026-10-31');
    expect(addMonthsMinusDay('2026-01-31', 1)).toBe('2026-02-27'); // Luxon clamps Jan 31 + 1 month to Feb 28
    expect(addMonthsMinusDay('2026-02-15', 1)).toBe('2026-03-14');
  });

  it('extension limit: start + 5 weeks − 1 day', () => {
    expect(addWeeksMinusDay('2026-10-01', 5)).toBe('2026-11-04');
  });

  it('converts local slot times to UTC across DST', () => {
    expect(localToInstant('2026-03-28', '18:00', ZONE).toISOString()).toBe(
      '2026-03-28T17:00:00.000Z',
    ); // CET
    expect(localToInstant('2026-03-30', '18:00', ZONE).toISOString()).toBe(
      '2026-03-30T16:00:00.000Z',
    ); // CEST
    expect(localToInstant('2026-10-26', '18:30', ZONE).toISOString()).toBe(
      '2026-10-26T17:30:00.000Z',
    ); // back to CET
  });

  it('local day of an instant', () => {
    expect(localDay(new Date('2026-10-04T22:30:00Z'), ZONE)).toBe('2026-10-05');
    expect(localDay(new Date('2026-10-04T21:30:00Z'), ZONE)).toBe('2026-10-04');
  });
});
