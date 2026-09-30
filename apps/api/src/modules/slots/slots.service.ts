import { Injectable } from '@nestjs/common';
import type {
  CalendarResponse,
  ClientSlot,
  CreateSlotsResponse,
  EndpointBody,
  EndpointQuery,
  LockRangeResponse,
  TrainerSlot,
} from '@sila/contracts';
import { DomainError } from '../../common/errors/domain-error';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { PackageUsageService } from '../../common/package-usage/package-usage.service';
import { isConstraintViolation } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { dateOnlyToIso, localDay } from '../../common/time/time';
import { AppConfig } from '../../config/app-config.service';
import { BookingService } from '../sessions/booking.service';
import { Clock } from '../sessions/clock';
import { TRAINER_PRACTICE_INCLUDE, toTrainerPractice } from '../sessions/session-mappers';
import { findOverlaps, isValidSlotStart, localSlotStart, SLOT_MS, slotEnd } from './slot-time';
import { LIVE_SESSION, TRAINER_SLOT_INCLUDE, toTrainerSlot } from './slot-mappers';

/** Longest range the calendar / client slot endpoints serve in one call (a month view plus padding). */
const MAX_RANGE_DAYS = 62;

@Injectable()
export class SlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly booking: BookingService,
    private readonly usage: PackageUsageService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * A single slot `{startsAt}` or a bulk set of local dates × local times. All-or-nothing: if any requested slot
   * overlaps an existing slot or another requested one, nothing is created and 409 SLOT_OVERLAP lists them.
   * Bulk times that do not exist locally (the spring-forward hour) are skipped.
   */
  async create(
    trainerId: string,
    body: EndpointBody<'trainer.slots.create'>,
  ): Promise<CreateSlotsResponse> {
    const zone = this.config.timezone;
    let starts: Date[];
    if ('startsAt' in body) {
      const startsAt = new Date(body.startsAt);
      if (!isValidSlotStart(startsAt, zone)) {
        throw new DomainError('VALIDATION_FAILED', 'Slots start on the hour or half hour.', [
          { path: 'startsAt', message: 'Start time must be HH:00 or HH:30 local time' },
        ]);
      }
      starts = [startsAt];
    } else {
      const unique = new Map<number, Date>();
      for (const day of body.dates) {
        for (const time of body.times) {
          const s = localSlotStart(day, time, zone);
          if (s) unique.set(s.getTime(), s);
        }
      }
      starts = [...unique.values()].sort((a, b) => a.getTime() - b.getTime());
      if (starts.length === 0) {
        throw new DomainError('VALIDATION_FAILED', 'None of these local times exist.');
      }
    }

    const existing = await this.existingStarts(trainerId, starts[0]!, starts[starts.length - 1]!);
    this.assertNoOverlap(findOverlaps(starts, existing));

    try {
      const created = await this.prisma.slot.createManyAndReturn({
        data: starts.map((s) => ({ trainerId, startsAt: s, endsAt: slotEnd(s) })),
      });
      return {
        created: created
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .map((s) => toTrainerSlot({ ...s, reservedForClient: null, sessions: [] })),
      };
    } catch (err) {
      // Lost a race with another write: the exclusion constraint is the source of truth.
      if (isConstraintViolation(err, 'exclusion', 'slot_no_overlap'))
        throw new DomainError('SLOT_OVERLAP');
      throw err;
    }
  }

  /** Lock/unlock, lock reason, reserve for a client. A booked slot cannot be locked or reserved for someone else. */
  async update(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.slots.update'>,
  ): Promise<TrainerSlot> {
    if (body.reservedForClientId) {
      await this.ownership.assertTrainerOwnsClient(trainerId, body.reservedForClientId);
    }
    await this.prisma.$transaction(async (tx) => {
      const slot = await this.booking.lockSlot(tx, id);
      this.ownership.assertOwnedByTrainer(trainerId, slot, 'Slot');
      const live = await tx.session.findFirst({ where: { slotId: id, ...LIVE_SESSION } });
      if (live) {
        const locking = body.status === 'LOCKED';
        const reservingOther =
          !!body.reservedForClientId && body.reservedForClientId !== live.clientId;
        if (locking || reservingOther) throw new DomainError('SLOT_BOOKED');
      }
      const status = body.status ?? slot.status;
      await tx.slot.update({
        where: { id },
        data: {
          status: body.status,
          // Reopening clears the reason unless a new one is given.
          lockReason: status === 'OPEN' ? null : body.lockReason,
          reservedForClientId: body.reservedForClientId,
        },
      });
    });
    return this.getSlot(id);
  }

  /** Deletes an unbooked slot. Cancelled practices keep their history (their slotId becomes null). */
  async delete(trainerId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const slot = await this.booking.lockSlot(tx, id);
      this.ownership.assertOwnedByTrainer(trainerId, slot, 'Slot');
      const live = await tx.session.findFirst({ where: { slotId: id, ...LIVE_SESSION } });
      if (live) throw new DomainError('SLOT_BOOKED');
      await tx.slot.delete({ where: { id } });
    });
  }

  /** "Block time": locks every OPEN, unbooked slot overlapping [from, to). Booked slots are left as they are. */
  async lockRange(
    trainerId: string,
    body: EndpointBody<'trainer.slots.lockRange'>,
  ): Promise<LockRangeResponse> {
    const from = new Date(body.from);
    const to = new Date(body.to);
    return this.prisma.$transaction(async (tx) => {
      const inRange = {
        trainerId,
        status: 'OPEN' as const,
        startsAt: { lt: to },
        endsAt: { gt: from },
      };
      const skippedBooked = await tx.slot.count({
        where: { ...inRange, sessions: { some: LIVE_SESSION } },
      });
      const { count } = await tx.slot.updateMany({
        where: { ...inRange, sessions: { none: LIVE_SESSION } },
        data: { status: 'LOCKED', lockReason: body.reason },
      });
      return { locked: count, skippedBooked };
    });
  }

  /** Slots overlapping the range plus every practice (cancelled included) starting in it. */
  async calendar(
    trainerId: string,
    query: EndpointQuery<'trainer.calendar'>,
  ): Promise<CalendarResponse> {
    const { from, to } = this.range(query);
    const [slots, practices] = await Promise.all([
      this.prisma.slot.findMany({
        where: { trainerId, startsAt: { lt: to }, endsAt: { gt: from } },
        include: TRAINER_SLOT_INCLUDE,
        orderBy: { startsAt: 'asc' },
      }),
      this.prisma.session.findMany({
        where: { trainerId, startsAt: { gte: from, lt: to } },
        include: TRAINER_PRACTICE_INCLUDE,
        orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return { slots: slots.map(toTrainerSlot), practices: practices.map(toTrainerPractice) };
  }

  /**
   * Bookable slots for a client: their trainer's OPEN, unbooked slots (free or reserved for them) starting at
   * least BOOKING_CUTOFF_HOURS from now. `withinPackage` is false when no package with practices left covers
   * the slot's local day ("outside your package").
   */
  async clientSlots(clientId: string, query: EndpointQuery<'client.slots'>): Promise<ClientSlot[]> {
    const { from, to } = this.range(query);
    const link = await this.prisma.trainerClient.findUnique({ where: { clientId } });
    if (!link || link.archivedAt) return [];

    const earliest = new Date(
      this.clock.now().getTime() + this.config.get('BOOKING_CUTOFF_HOURS') * 3_600_000,
    );
    const start = from > earliest ? from : earliest;
    if (start >= to) return [];

    const [slots, packages] = await Promise.all([
      this.prisma.slot.findMany({
        where: {
          trainerId: link.trainerId,
          status: 'OPEN',
          startsAt: { gte: start, lt: to },
          OR: [{ reservedForClientId: null }, { reservedForClientId: clientId }],
          sessions: { none: LIVE_SESSION },
        },
        orderBy: { startsAt: 'asc' },
      }),
      this.prisma.package.findMany({
        where: { clientId },
        select: { id: true, validFrom: true },
      }),
    ]);
    const usage = await this.usage.getUsage(packages.map((p) => p.id));
    const windows = packages.flatMap((p) => {
      const u = usage.get(p.id);
      return u && u.left > 0 ? [{ from: dateOnlyToIso(p.validFrom), until: u.effectiveUntil }] : [];
    });
    const zone = this.config.timezone;
    return slots.map((s) => {
      const day = localDay(s.startsAt, zone);
      return {
        id: s.id,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        withinPackage: windows.some((w) => w.from <= day && day <= w.until),
        reservedForMe: s.reservedForClientId === clientId,
      };
    });
  }

  // ------------------------------------------------------------------ helpers

  async getSlot(id: string): Promise<TrainerSlot> {
    const slot = await this.prisma.slot.findUniqueOrThrow({
      where: { id },
      include: TRAINER_SLOT_INCLUDE,
    });
    return toTrainerSlot(slot);
  }

  /** Starts of the trainer's slots that could overlap anything in [first, last + 60 min). */
  private async existingStarts(trainerId: string, first: Date, last: Date): Promise<Date[]> {
    const rows = await this.prisma.slot.findMany({
      where: {
        trainerId,
        startsAt: {
          gt: new Date(first.getTime() - SLOT_MS),
          lt: new Date(last.getTime() + SLOT_MS),
        },
      },
      select: { startsAt: true },
    });
    return rows.map((r) => r.startsAt);
  }

  private assertNoOverlap(conflicts: Date[]): void {
    if (conflicts.length > 0) {
      throw new DomainError('SLOT_OVERLAP', undefined, {
        conflicts: conflicts.map((d) => d.toISOString()),
      });
    }
  }

  private range(query: { from: string; to: string }): { from: Date; to: Date } {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `The range can span at most ${MAX_RANGE_DAYS} days.`,
      );
    }
    return { from, to };
  }
}
