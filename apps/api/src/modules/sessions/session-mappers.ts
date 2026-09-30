import type { ClientPractice, TrainerPractice } from '@sila/contracts';
import { toPersonSummary } from '../../common/http/mappers';
import type { Prisma } from '../../generated/prisma/client';

/** Prisma include that loads everything `toTrainerPractice` needs. */
export const TRAINER_PRACTICE_INCLUDE = {
  client: { select: { id: true, firstName: true, lastName: true, photoUrl: true } },
  plan: { select: { id: true, name: true } },
} satisfies Prisma.SessionInclude;

export type TrainerPracticeRow = Prisma.SessionGetPayload<{
  include: typeof TRAINER_PRACTICE_INCLUDE;
}>;

export function toTrainerPractice(s: TrainerPracticeRow): TrainerPractice {
  return {
    id: s.id,
    slotId: s.slotId,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    status: s.status,
    client: toPersonSummary(s.client),
    packageId: s.packageId,
    plan: s.plan ? { id: s.plan.id, name: s.plan.name } : null,
    practiceReturned: s.practiceReturned,
    cancelledAt: s.cancelledAt?.toISOString() ?? null,
    attendanceMarkedAt: s.attendanceMarkedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

export const CLIENT_PRACTICE_INCLUDE = {
  package: { select: { name: true } },
} satisfies Prisma.SessionInclude;

export type ClientPracticeRow = Prisma.SessionGetPayload<{
  include: typeof CLIENT_PRACTICE_INCLUDE;
}>;

/** `true` when there are at least `hours` between `now` and `startsAt` (boundary inclusive: exactly 6h is allowed). */
export function isAtLeastHoursBefore(startsAt: Date, now: Date, hours: number): boolean {
  return startsAt.getTime() - now.getTime() >= hours * 3_600_000;
}

export function toClientPractice(
  s: ClientPracticeRow,
  now: Date,
  cancelCutoffHours: number,
): ClientPractice {
  return {
    id: s.id,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    status: s.status,
    canCancel: s.status === 'BOOKED' && isAtLeastHoursBefore(s.startsAt, now, cancelCutoffHours),
    cancelledAt: s.cancelledAt?.toISOString() ?? null,
    packageName: s.package?.name ?? null,
  };
}
