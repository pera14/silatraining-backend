import { renderEmail } from './email-layout';
import {
  bookingConfirmedEmail,
  cancelledByTrainerEmail,
  daySr,
  packagesExpiringEmail,
  reminderEmail,
  welcomeEmail,
  whenEn,
  whenSr,
} from './templates';

const ctx = { appUrl: 'https://app.sila.rs', zone: 'Europe/Belgrade' };

describe('email templates', () => {
  it('formats local times in Serbian (Latin) and English, across DST', () => {
    // summer time (UTC+2)
    expect(whenSr(new Date('2026-10-06T16:00:00Z'), ctx.zone)).toBe('utorak, 6. oktobar u 18:00');
    expect(whenEn(new Date('2026-10-06T16:00:00Z'), ctx.zone)).toBe('Tuesday 6 October at 18:00');
    // after the last Sunday of October (UTC+1)
    expect(whenSr(new Date('2026-10-26T17:00:00Z'), ctx.zone)).toBe(
      'ponedeljak, 26. oktobar u 18:00',
    );
    expect(daySr('2026-12-01')).toBe('1. decembar 2026.');
  });

  it('renders Serbian first, English second, in both text and HTML', () => {
    const email = renderEmail(
      welcomeEmail(ctx, { clientFirstName: 'Mila', trainerName: 'Jelena Ilić' }),
      ctx.appUrl,
    );
    expect(email.text.indexOf('Dobro došli, Mila!')).toBeLessThan(
      email.text.indexOf('Welcome, Mila!'),
    );
    expect(email.html.indexOf('Dobro došli, Mila!')).toBeLessThan(
      email.html.indexOf('Welcome, Mila!'),
    );
    expect(email.html).toContain('<html lang="sr">');
    expect(email.html).toContain('<div lang="en"');
    expect(email.html).toContain('src="https://app.sila.rs/brand/sila-mark.png"');
    expect(email.text).toContain('Otvori aplikaciju: https://app.sila.rs/client');
  });

  it('escapes user-controlled text in HTML', () => {
    const email = renderEmail(
      welcomeEmail(ctx, {
        clientFirstName: '<img src=x onerror=alert(1)>',
        trainerName: 'A & "B"',
      }),
      ctx.appUrl,
    );
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&#60;img src=x onerror=alert(1)&#62;');
    expect(email.html).toContain('A &#38; &#34;B&#34;');
  });

  it('wording depends on who booked', () => {
    const at = new Date('2026-10-06T16:00:00Z');
    const base = { startsAt: at, trainerName: 'Marko Ilić', cancelCutoffHours: 6 };
    expect(bookingConfirmedEmail(ctx, { ...base, bookedBy: 'CLIENT' }).sr.paragraphs[0]).toBe(
      'Vaš trening kod trenera Marko Ilić: utorak, 6. oktobar u 18:00.',
    );
    expect(bookingConfirmedEmail(ctx, { ...base, bookedBy: 'SYSTEM' }).en.paragraphs[0]).toBe(
      'Your trainer Marko Ilić booked a practice for you: Tuesday 6 October at 18:00.',
    );
  });

  it('trainer cancellation says nothing about a package when there was none', () => {
    const e = cancelledByTrainerEmail(ctx, {
      startsAt: new Date('2026-10-06T16:00:00Z'),
      trainerName: 'Marko Ilić',
      practiceReturned: null,
    });
    expect(e.sr.paragraphs).toHaveLength(1);
    expect(e.en.paragraphs).toHaveLength(1);
  });

  it('reminder shows the cancel deadline only while cancelling is still possible', () => {
    const base = {
      startsAt: new Date('2026-10-07T16:00:00Z'),
      trainerName: 'M',
      cancelCutoffHours: 6,
    };
    expect(reminderEmail(ctx, { ...base, canStillCancel: true }).sr.paragraphs[1]).toBe(
      'Ako ne možete da dođete, otkažite u aplikaciji do sreda, 7. oktobar u 12:00.',
    );
    expect(reminderEmail(ctx, { ...base, canStillCancel: false }).en.paragraphs[1]).toBe(
      'If you cannot make it, contact your trainer.',
    );
  });

  it('expiring digest: singular/plural subject and English practice(s)', () => {
    const line = {
      clientName: 'Ana',
      packageName: '10 / month',
      left: 1,
      effectiveUntil: '2026-10-10',
    };
    const one = packagesExpiringEmail(ctx, { packages: [line], withinDays: 5 });
    expect(one.subject).toBe('Paket ističe: Ana · Package expiring soon');
    expect(one.en.items).toEqual([
      'Ana — 10 / month: 1 practice left, valid until 10 October 2026',
    ]);
    const two = packagesExpiringEmail(ctx, {
      packages: [line, { ...line, left: 3 }],
      withinDays: 5,
    });
    expect(two.subject).toBe('Paketi ističu uskoro (2) · Packages expiring soon');
    expect(two.en.items?.[1]).toContain('3 practices left');
  });
});
