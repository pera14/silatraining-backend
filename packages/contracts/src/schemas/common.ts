import { z } from 'zod';

export const Id = z.uuid();
/** An instant, serialized as ISO-8601 with offset (the API always sends UTC `Z`). */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** A calendar day in APP_TIMEZONE, `YYYY-MM-DD`. */
export const IsoDate = z.iso.date();
/** Local start time of a slot: on the hour or half hour. */
export const SlotStartTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):(00|30)$/, 'Start time must be HH:00 or HH:30');
/** ISO weekday, 1 = Monday … 7 = Sunday. */
export const Weekday = z.int().min(1).max(7);

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const Password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters');
export const PersonName = z.string().trim().min(1, 'Required').max(80);
export const Phone = z
  .string()
  .trim()
  .max(32)
  .regex(/^\+?[0-9 ()/-]{6,}$/, 'Enter a valid phone number');

export const IdParams = z.object({ id: Id });
export const TokenParams = z.object({ token: z.string().min(16).max(128) });

/** Body/response of endpoints that return 204 No Content. */
export const NoContent = z.undefined();

export const Role = z.enum(['TRAINER', 'CLIENT']);
export type Role = z.infer<typeof Role>;
export const SlotStatus = z.enum(['OPEN', 'LOCKED']);
export type SlotStatus = z.infer<typeof SlotStatus>;
export const SessionStatus = z.enum(['BOOKED', 'ATTENDED', 'NO_SHOW', 'CANCELLED']);
export type SessionStatus = z.infer<typeof SessionStatus>;
export const PaymentStatus = z.enum(['UNPAID', 'PAID']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;
export const PaymentMethod = z.enum(['CASH', 'TRANSFER', 'CARD', 'OTHER']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

/** Minimal public view of a person (trainer or client). */
export const PersonSummary = z.object({
  id: Id,
  firstName: z.string(),
  lastName: z.string(),
  photoUrl: z.string().nullable(),
});
export type PersonSummary = z.infer<typeof PersonSummary>;

export const PlanRef = z.object({ id: Id, name: z.string() });
export type PlanRef = z.infer<typeof PlanRef>;
