import { DateTime } from 'luxon';
import type { EmailContent } from './email-layout';

/**
 * Email copy (Serbian Latin first, English fallback). Pure functions: data in, content out, so every template is
 * unit-tested without Nest. Serbian uses passive constructions ("trening je otkazan") so no verb has to guess anyone's gender.
 */

export interface TemplateContext {
  appUrl: string;
  zone: string;
}

/** "utorak, 6. oktobar u 18:00" */
export function whenSr(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone })
    .setLocale('sr-Latn-RS')
    .toFormat("cccc, d. LLLL 'u' HH:mm");
}

/** "Tuesday 6 October at 18:00" */
export function whenEn(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).setLocale('en-GB').toFormat("cccc d LLLL 'at' HH:mm");
}

/** "6. oktobar 2026." for a `YYYY-MM-DD` day */
export function daySr(day: string): string {
  return DateTime.fromISO(day, { zone: 'utc' }).setLocale('sr-Latn-RS').toFormat('d. LLLL yyyy.');
}

/** "6 October 2026" for a `YYYY-MM-DD` day */
export function dayEn(day: string): string {
  return DateTime.fromISO(day, { zone: 'utc' }).setLocale('en-GB').toFormat('d LLLL yyyy');
}

// ------------------------------------------------------------------ client.joined → client

export function welcomeEmail(
  ctx: TemplateContext,
  d: { clientFirstName: string; trainerName: string },
): EmailContent {
  const url = `${ctx.appUrl}/client`;
  return {
    subject: 'Dobro došli u SILA Training · Welcome to SILA Training',
    sr: {
      title: `Dobro došli, ${d.clientFirstName}!`,
      paragraphs: [
        `Povezani ste sa trenerom ${d.trainerName}.`,
        'U aplikaciji zakazujete treninge, vidite koliko vam je treninga preostalo i do kada važi vaš paket.',
      ],
      cta: { label: 'Otvori aplikaciju', url },
    },
    en: {
      title: `Welcome, ${d.clientFirstName}!`,
      paragraphs: [
        `You are now connected with your trainer ${d.trainerName}.`,
        'In the app you can book practices, see how many practices you have left and when your package expires.',
      ],
      cta: { label: 'Open the app', url },
    },
  };
}

// ------------------------------------------------------------------ session.booked → client

export function bookingConfirmedEmail(
  ctx: TemplateContext,
  d: {
    startsAt: Date;
    trainerName: string;
    bookedBy: 'CLIENT' | 'TRAINER' | 'SYSTEM';
    cancelCutoffHours: number;
  },
): EmailContent {
  const url = `${ctx.appUrl}/client/practices`;
  const sr = whenSr(d.startsAt, ctx.zone);
  const en = whenEn(d.startsAt, ctx.zone);
  const byTrainer = d.bookedBy !== 'CLIENT';
  return {
    subject: `Trening je zakazan: ${sr} · Practice booked`,
    sr: {
      title: 'Trening je zakazan',
      paragraphs: [
        byTrainer
          ? `Zakazan vam je trening: ${sr} (trener: ${d.trainerName}).`
          : `Vaš trening kod trenera ${d.trainerName}: ${sr}.`,
        `Ako ne možete da dođete, otkažite u aplikaciji najkasnije ${d.cancelCutoffHours} sati pre početka.`,
      ],
      cta: { label: 'Moji treninzi', url },
    },
    en: {
      title: 'Your practice is booked',
      paragraphs: [
        byTrainer
          ? `Your trainer ${d.trainerName} booked a practice for you: ${en}.`
          : `Your practice with ${d.trainerName}: ${en}.`,
        `If you cannot make it, cancel in the app at least ${d.cancelCutoffHours} hours before it starts.`,
      ],
      cta: { label: 'My practices', url },
    },
  };
}

// ------------------------------------------------------------------ session.cancelled

/** Cancelled by the client → email the trainer. */
export function cancelledByClientEmail(
  ctx: TemplateContext,
  d: { startsAt: Date; clientName: string; clientId: string; practiceReturned: boolean },
): EmailContent {
  const url = `${ctx.appUrl}/trainer/clients/${d.clientId}`;
  const sr = whenSr(d.startsAt, ctx.zone);
  const en = whenEn(d.startsAt, ctx.zone);
  return {
    subject: `Otkazan trening: ${d.clientName}, ${sr} · Practice cancelled`,
    sr: {
      title: 'Otkazan trening',
      paragraphs: [
        `${d.clientName} — trening ${sr} je otkazan. Termin je ponovo slobodan.`,
        ...(d.practiceReturned ? ['Trening je vraćen u paket.'] : []),
      ],
      cta: { label: 'Otvori klijenta', url },
    },
    en: {
      title: 'A client cancelled a practice',
      paragraphs: [
        `${d.clientName} cancelled the practice on ${en}. The slot is open again.`,
        ...(d.practiceReturned ? ['The practice was returned to the package.'] : []),
      ],
      cta: { label: 'Open client', url },
    },
  };
}

/** Cancelled by the trainer → email the client. */
export function cancelledByTrainerEmail(
  ctx: TemplateContext,
  d: {
    startsAt: Date;
    trainerName: string;
    /** null = the practice was booked without a package: say nothing about it. */
    practiceReturned: boolean | null;
  },
): EmailContent {
  const url = `${ctx.appUrl}/client/book`;
  const sr = whenSr(d.startsAt, ctx.zone);
  const en = whenEn(d.startsAt, ctx.zone);
  const pkgSr =
    d.practiceReturned === null
      ? []
      : [
          d.practiceReturned
            ? 'Trening je vraćen u vaš paket.'
            : 'Ovaj trening se računa kao iskorišćen.',
        ];
  const pkgEn =
    d.practiceReturned === null
      ? []
      : [
          d.practiceReturned
            ? 'The practice was returned to your package.'
            : 'This practice still counts as used.',
        ];
  return {
    subject: `Trening je otkazan: ${sr} · Practice cancelled`,
    sr: {
      title: 'Trening je otkazan',
      paragraphs: [`Vaš trening ${sr} je otkazan (trener: ${d.trainerName}).`, ...pkgSr],
      cta: { label: 'Zakaži novi termin', url },
    },
    en: {
      title: 'Your practice was cancelled',
      paragraphs: [`Your trainer ${d.trainerName} cancelled your practice on ${en}.`, ...pkgEn],
      cta: { label: 'Book another time', url },
    },
  };
}

// ------------------------------------------------------------------ session.moved → client

export function movedEmail(
  ctx: TemplateContext,
  d: { from: Date; to: Date; trainerName: string },
): EmailContent {
  const url = `${ctx.appUrl}/client/practices`;
  const toSr = whenSr(d.to, ctx.zone);
  return {
    subject: `Trening je pomeren: ${toSr} · Practice moved`,
    sr: {
      title: 'Trening je pomeren',
      paragraphs: [
        `Vaš trening je pomeren (trener: ${d.trainerName}).`,
        `Novi termin: ${toSr} (umesto: ${whenSr(d.from, ctx.zone)}).`,
      ],
      cta: { label: 'Moji treninzi', url },
    },
    en: {
      title: 'Your practice was moved',
      paragraphs: [
        `Your trainer ${d.trainerName} moved your practice.`,
        `New time: ${whenEn(d.to, ctx.zone)} (was: ${whenEn(d.from, ctx.zone)}).`,
      ],
      cta: { label: 'My practices', url },
    },
  };
}

// ------------------------------------------------------------------ reminder → client

export function reminderEmail(
  ctx: TemplateContext,
  d: { startsAt: Date; trainerName: string; cancelCutoffHours: number; canStillCancel: boolean },
): EmailContent {
  const url = `${ctx.appUrl}/client/practices`;
  const sr = whenSr(d.startsAt, ctx.zone);
  const en = whenEn(d.startsAt, ctx.zone);
  const cutoff = new Date(d.startsAt.getTime() - d.cancelCutoffHours * 3_600_000);
  return {
    subject: `Podsetnik: trening ${sr} · Practice reminder`,
    sr: {
      title: 'Podsetnik za trening',
      paragraphs: [
        `Vaš trening kod trenera ${d.trainerName}: ${sr}.`,
        d.canStillCancel
          ? `Ako ne možete da dođete, otkažite u aplikaciji do ${whenSr(cutoff, ctx.zone)}.`
          : 'Ako ne možete da dođete, javite se treneru.',
      ],
      cta: { label: 'Moji treninzi', url },
    },
    en: {
      title: 'Practice reminder',
      paragraphs: [
        `Your practice with ${d.trainerName}: ${en}.`,
        d.canStillCancel
          ? `If you cannot make it, cancel in the app by ${whenEn(cutoff, ctx.zone)}.`
          : 'If you cannot make it, contact your trainer.',
      ],
      cta: { label: 'My practices', url },
    },
  };
}

// ------------------------------------------------------------------ packages expiring → trainer

export interface ExpiringPackageLine {
  clientName: string;
  packageName: string;
  left: number;
  /** `YYYY-MM-DD` */
  effectiveUntil: string;
}

export function packagesExpiringEmail(
  ctx: TemplateContext,
  d: { packages: ExpiringPackageLine[]; withinDays: number },
): EmailContent {
  const url = `${ctx.appUrl}/trainer/clients?flag=EXPIRING`;
  const one = d.packages.length === 1;
  return {
    subject: one
      ? `Paket ističe: ${d.packages[0]!.clientName} · Package expiring soon`
      : `Paketi ističu uskoro (${d.packages.length}) · Packages expiring soon`,
    sr: {
      title: one ? 'Paket uskoro ističe' : 'Paketi uskoro ističu',
      paragraphs: [
        `Ovi paketi ističu za ${d.withinDays} dana ili manje, a treninzi koji nisu iskorišćeni tada propadaju:`,
      ],
      items: d.packages.map(
        (p) =>
          `${p.clientName} — ${p.packageName}: preostalo treninga ${p.left}, važi do ${daySr(p.effectiveUntil)}`,
      ),
      cta: { label: 'Otvori klijente', url },
    },
    en: {
      title: one ? 'A package expires soon' : 'Packages expire soon',
      paragraphs: [
        `These packages expire within ${d.withinDays} days; practices not used by then are lost:`,
      ],
      items: d.packages.map(
        (p) =>
          `${p.clientName} — ${p.packageName}: ${p.left} ${p.left === 1 ? 'practice' : 'practices'} left, valid until ${dayEn(p.effectiveUntil)}`,
      ),
      cta: { label: 'Open clients', url },
    },
  };
}
