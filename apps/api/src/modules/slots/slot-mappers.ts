import type { SlotSeries, TrainerSlot } from '@sila/contracts';
import { toPersonSummary } from '../../common/http/mappers';
import { dateOnlyToIso } from '../../common/time/time';
import type { Prisma } from '../../generated/prisma/client';

const PERSON = { select: { id: true, firstName: true, lastName: true, photoUrl: true } } as const;

/** A session that occupies its slot (cancelled ones free it). */
export const LIVE_SESSION = { status: { not: 'CANCELLED' } } satisfies Prisma.SessionWhereInput;

export const TRAINER_SLOT_INCLUDE = {
  reservedForClient: PERSON,
  sessions: {
    where: LIVE_SESSION,
    take: 1,
    select: { id: true, status: true, client: PERSON },
  },
} satisfies Prisma.SlotInclude;

export type TrainerSlotRow = Prisma.SlotGetPayload<{ include: typeof TRAINER_SLOT_INCLUDE }>;

export function toTrainerSlot(s: TrainerSlotRow): TrainerSlot {
  const live = s.sessions[0];
  return {
    id: s.id,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    status: s.status,
    lockReason: s.lockReason,
    reservedFor: s.reservedForClient ? toPersonSummary(s.reservedForClient) : null,
    seriesId: s.seriesId,
    parallel: s.parallel,
    practice: live
      ? { id: live.id, status: live.status, client: toPersonSummary(live.client) }
      : null,
  };
}

export const SERIES_INCLUDE = { reservedForClient: PERSON } satisfies Prisma.SlotSeriesInclude;
export type SeriesRow = Prisma.SlotSeriesGetPayload<{ include: typeof SERIES_INCLUDE }>;

export function toSlotSeries(s: SeriesRow): SlotSeries {
  return {
    id: s.id,
    weekdays: [...s.weekdays].sort((a, b) => a - b),
    startTime: s.startTime,
    validFrom: dateOnlyToIso(s.validFrom),
    validUntil: s.validUntil ? dateOnlyToIso(s.validUntil) : null,
    reservedFor: s.reservedForClient ? toPersonSummary(s.reservedForClient) : null,
    autoBook: s.autoBook,
    createdAt: s.createdAt.toISOString(),
  };
}
