import { z } from 'zod';
import { Id, IsoDate, IsoDateTime, PersonSummary, SessionStatus } from './common';

/** A practice as the client sees it. */
export const ClientPractice = z.object({
  id: Id,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  status: SessionStatus,
  /** startsAt − now ≥ CANCEL_CUTOFF_HOURS and still BOOKED. */
  canCancel: z.boolean(),
  cancelledAt: IsoDateTime.nullable(),
  packageName: z.string().nullable(),
});
export type ClientPractice = z.infer<typeof ClientPractice>;

/** `GET /client/home`. Package fields are null when there is no active package. */
export const ClientHome = z.object({
  hasActivePackage: z.boolean(),
  left: z.int().nullable(),
  total: z.int().nullable(),
  validUntil: IsoDate.nullable(),
  extended: z.boolean(),
  packageName: z.string().nullable(),
  nextPractice: ClientPractice.nullable(),
  trainer: PersonSummary.nullable(),
});
export type ClientHome = z.infer<typeof ClientHome>;

/** A bookable slot (OPEN, unbooked, ≥ BOOKING_CUTOFF_HOURS ahead, visible to this client). */
export const ClientSlot = z.object({
  id: Id,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  /** false when the slot falls outside every active package's validity ("outside your package"). */
  withinPackage: z.boolean(),
  reservedForMe: z.boolean(),
});
export type ClientSlot = z.infer<typeof ClientSlot>;

export const ClientSessionsQuery = z.object({
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
});
export type ClientSessionsQuery = z.input<typeof ClientSessionsQuery>;

export const ClientBookRequest = z.object({ slotId: Id });
export type ClientBookRequest = z.infer<typeof ClientBookRequest>;
