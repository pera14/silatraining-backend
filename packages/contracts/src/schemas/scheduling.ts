import { z } from 'zod';
import {
  Id,
  IsoDate,
  IsoDateTime,
  PaymentStatus,
  PersonSummary,
  PlanRef,
  SessionStatus,
  SlotStartTime,
  SlotStatus,
  Weekday,
} from './common';

// ---------------------------------------------------------------- practices (sessions)

/** A practice as the trainer sees it. */
export const TrainerPractice = z.object({
  id: Id,
  /** null only if the slot was deleted after the practice was cancelled. */
  slotId: Id.nullable(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  status: SessionStatus,
  client: PersonSummary,
  /** null = booked by the trainer without a package ("no package"). */
  packageId: Id.nullable(),
  plan: PlanRef.nullable(),
  practiceReturned: z.boolean(),
  cancelledAt: IsoDateTime.nullable(),
  attendanceMarkedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type TrainerPractice = z.infer<typeof TrainerPractice>;

/** Package numbers shown next to a practice or client. */
export const PackageBadge = z.object({
  packageId: Id,
  name: z.string(),
  left: z.int(),
  total: z.int(),
  paymentStatus: PaymentStatus,
});
export type PackageBadge = z.infer<typeof PackageBadge>;

/** One card on the trainer's Today screen. */
export const TodayPractice = TrainerPractice.extend({
  pinnedNote: z.object({ id: Id, body: z.string() }).nullable(),
  package: PackageBadge.nullable(),
  /** The client's plans (Plan A, Plan B…) in rotation order, for the plan chip switcher. */
  clientPlans: z.array(PlanRef),
});
export type TodayPractice = z.infer<typeof TodayPractice>;

export const TodayQuery = z.object({ date: IsoDate.optional() });
export const TodayResponse = z.object({
  date: IsoDate,
  practices: z.array(TodayPractice),
});
export type TodayResponse = z.infer<typeof TodayResponse>;

export const CreateTrainerSessionRequest = z.object({
  slotId: Id,
  clientId: Id,
  planId: Id.optional(),
  /** Book without consuming a package. */
  withoutPackage: z.boolean().optional(),
});
export type CreateTrainerSessionRequest = z.infer<typeof CreateTrainerSessionRequest>;

export const UpdateTrainerSessionRequest = z
  .object({
    status: z.enum(['ATTENDED', 'NO_SHOW']).optional(),
    planId: Id.nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.planId !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateTrainerSessionRequest = z.infer<typeof UpdateTrainerSessionRequest>;

export const MoveSessionRequest = z.object({ slotId: Id });
export type MoveSessionRequest = z.infer<typeof MoveSessionRequest>;

export const TrainerCancelSessionRequest = z.object({
  /** Default: true if ≥ CANCEL_CUTOFF_HOURS before start, else false. */
  returnPractice: z.boolean().optional(),
});
export type TrainerCancelSessionRequest = z.infer<typeof TrainerCancelSessionRequest>;

// ---------------------------------------------------------------- slots

export const TrainerSlot = z.object({
  id: Id,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  status: SlotStatus,
  lockReason: z.string().nullable(),
  reservedFor: PersonSummary.nullable(),
  seriesId: Id.nullable(),
  /** The live (non-cancelled) practice on this slot, if booked. */
  practice: z.object({ id: Id, status: SessionStatus, client: PersonSummary }).nullable(),
});
export type TrainerSlot = z.infer<typeof TrainerSlot>;

export const RangeQuery = z
  .object({ from: IsoDateTime, to: IsoDateTime })
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), { message: '`from` must be before `to`' });
export type RangeQuery = z.infer<typeof RangeQuery>;

export const CalendarResponse = z.object({
  slots: z.array(TrainerSlot),
  /** All practices in range, including cancelled ones (the UI decides what to draw). */
  practices: z.array(TrainerPractice),
});
export type CalendarResponse = z.infer<typeof CalendarResponse>;

/** `POST /trainer/slots`: a single slot, or a bulk set of local dates × local start times. */
export const CreateSlotsRequest = z.union([
  z.object({ startsAt: IsoDateTime }),
  z.object({
    dates: z.array(IsoDate).min(1).max(62),
    times: z.array(SlotStartTime).min(1).max(48),
  }),
]);
export type CreateSlotsRequest = z.infer<typeof CreateSlotsRequest>;
export const CreateSlotsResponse = z.object({ created: z.array(TrainerSlot) });
export type CreateSlotsResponse = z.infer<typeof CreateSlotsResponse>;

export const UpdateSlotRequest = z
  .object({
    status: SlotStatus.optional(),
    lockReason: z.string().trim().max(80).nullable().optional(),
    reservedForClientId: Id.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateSlotRequest = z.infer<typeof UpdateSlotRequest>;

export const LockRangeRequest = z
  .object({ from: IsoDateTime, to: IsoDateTime, reason: z.string().trim().min(1).max(80) })
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), { message: '`from` must be before `to`' });
export type LockRangeRequest = z.infer<typeof LockRangeRequest>;
export const LockRangeResponse = z.object({
  locked: z.int().nonnegative(),
  /** Booked slots in range are left untouched. */
  skippedBooked: z.int().nonnegative(),
});
export type LockRangeResponse = z.infer<typeof LockRangeResponse>;

// ---------------------------------------------------------------- series

export const SlotSeries = z.object({
  id: Id,
  weekdays: z.array(Weekday),
  startTime: SlotStartTime,
  validFrom: IsoDate,
  validUntil: IsoDate.nullable(),
  reservedFor: PersonSummary.nullable(),
  autoBook: z.boolean(),
  createdAt: IsoDateTime,
});
export type SlotSeries = z.infer<typeof SlotSeries>;

export const CreateSlotSeriesRequest = z
  .object({
    weekdays: z.array(Weekday).min(1).max(7),
    startTime: SlotStartTime,
    validFrom: IsoDate,
    validUntil: IsoDate.nullable().optional(),
    reservedForClientId: Id.nullable().optional(),
    autoBook: z.boolean().default(false),
  })
  .refine((v) => !v.validUntil || v.validUntil >= v.validFrom, {
    message: '`validUntil` must not be before `validFrom`',
  })
  .refine((v) => !v.autoBook || !!v.reservedForClientId, {
    message: 'autoBook requires reservedForClientId',
  });
export type CreateSlotSeriesRequest = z.input<typeof CreateSlotSeriesRequest>;

/** Applies to future unbooked slots only. */
export const UpdateSlotSeriesRequest = z
  .object({
    weekdays: z.array(Weekday).min(1).max(7).optional(),
    startTime: SlotStartTime.optional(),
    validUntil: IsoDate.nullable().optional(),
    reservedForClientId: Id.nullable().optional(),
    autoBook: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateSlotSeriesRequest = z.infer<typeof UpdateSlotSeriesRequest>;
