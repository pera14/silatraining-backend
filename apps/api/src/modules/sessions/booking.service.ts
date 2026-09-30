import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainError } from '../../common/errors/domain-error';
import {
  EVENTS,
  type SessionBookedEvent,
  type SessionCancelledEvent,
  type SessionMovedEvent,
} from '../../common/events/events';
import { PackageUsageService } from '../../common/package-usage/package-usage.service';
import { isConstraintViolation } from '../../common/prisma/prisma-errors';
import { type PrismaTx, PrismaService } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config.service';
import type { Session, SlotStatus } from '../../generated/prisma/client';
import { Clock } from './clock';
import { nextPlanId } from './plan-rotation';
import { isAtLeastHoursBefore } from './session-mappers';

export type BookedBy = SessionBookedEvent['bookedBy'];

export interface BookRequest {
  slotId: string;
  clientId: string;
  /** The trainer the slot must belong to (the client's trainer, or the calling trainer). */
  trainerId: string;
  /** User recorded as `createdById` (the client, the trainer, or the trainer for SYSTEM bookings). */
  actorId: string;
  bookedBy: BookedBy;
  /** Explicit plan (trainer only); otherwise the rotation picks one. */
  planId?: string;
  /** Trainer only: book without consuming a package. */
  withoutPackage?: boolean;
}

interface LockedSlot {
  id: string;
  trainerId: string;
  startsAt: Date;
  endsAt: Date;
  status: SlotStatus;
  reservedForClientId: string | null;
}

/**
 * The booking core shared by client booking, trainer booking and the autoBook cron (SPEC §4). Every public
 * method runs in ONE transaction and emits its domain event only after the commit.
 *
 * Concurrency: the slot row is locked `FOR UPDATE`, so two bookings of one slot serialize and the second sees the
 * first (409 SLOT_TAKEN); the `session_one_per_slot` unique index is the backstop. The client's package rows are
 * locked too, so two parallel bookings of different slots cannot both spend the last practice.
 */
@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: PackageUsageService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly events: EventEmitter2,
  ) {}

  async book(req: BookRequest): Promise<Session> {
    const session = await this.prisma.$transaction((tx) => this.bookInTx(tx, req));
    this.events.emit(EVENTS.sessionBooked, {
      sessionId: session.id,
      trainerId: session.trainerId,
      clientId: session.clientId,
      startsAt: session.startsAt,
      bookedBy: req.bookedBy,
    } satisfies SessionBookedEvent);
    return session;
  }

  /**
   * Cancels a BOOKED practice. `returnPractice` decides whether it goes back to the package; the slot reopens
   * either way (a CANCELLED session no longer occupies it).
   */
  async cancel(opts: {
    sessionId: string;
    actorId: string;
    cancelledBy: SessionCancelledEvent['cancelledBy'];
    /** Ownership check on the locked row (throw NOT_FOUND). Runs before the state check so nothing leaks. */
    authorize: (session: Session) => void;
    /** Runs on a BOOKED session: enforce cutoffs (throw) and return whether the practice goes back to the package. */
    decide: (session: Session, now: Date) => boolean;
    audit?: boolean;
  }): Promise<Session> {
    const session = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockSession(tx, opts.sessionId);
      opts.authorize(current);
      if (current.status !== 'BOOKED') throw new DomainError('INVALID_STATE');
      const now = this.clock.now();
      const returnPractice = opts.decide(current, now);
      const updated = await tx.session.update({
        where: { id: current.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledById: opts.actorId,
          practiceReturned: returnPractice,
        },
      });
      if (opts.audit) {
        await tx.auditLog.create({
          data: {
            actorId: opts.actorId,
            action: 'session.cancel',
            entity: 'Session',
            entityId: current.id,
            meta: { startsAt: current.startsAt.toISOString(), returnPractice },
          },
        });
      }
      return updated;
    });
    this.events.emit(EVENTS.sessionCancelled, {
      sessionId: session.id,
      trainerId: session.trainerId,
      clientId: session.clientId,
      startsAt: session.startsAt,
      cancelledBy: opts.cancelledBy,
      practiceReturned: session.practiceReturned,
    } satisfies SessionCancelledEvent);
    return session;
  }

  /** Moves a BOOKED practice of `trainerId` to another free slot of the same trainer, keeping package and plan. */
  async move(opts: { sessionId: string; trainerId: string; slotId: string }): Promise<Session> {
    const { before, after } = await this.prisma.$transaction(async (tx) => {
      const session = await this.lockSession(tx, opts.sessionId);
      if (session.trainerId !== opts.trainerId)
        throw new DomainError('NOT_FOUND', 'Practice not found');
      if (session.status !== 'BOOKED') throw new DomainError('INVALID_STATE');
      if (session.slotId === opts.slotId) return { before: session, after: session };

      const slot = await this.lockSlot(tx, opts.slotId);
      if (!slot || slot.trainerId !== opts.trainerId)
        throw new DomainError('NOT_FOUND', 'Slot not found');
      await this.assertSlotFree(tx, slot.id);
      const moved = await this.translateTaken(() =>
        tx.session.update({
          where: { id: session.id },
          data: { slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt },
        }),
      );
      return { before: session, after: moved };
    });
    if (before.slotId !== after.slotId) {
      this.events.emit(EVENTS.sessionMoved, {
        sessionId: after.id,
        trainerId: after.trainerId,
        clientId: after.clientId,
        fromStartsAt: before.startsAt,
        toStartsAt: after.startsAt,
      } satisfies SessionMovedEvent);
    }
    return after;
  }

  // ------------------------------------------------------------------ internals

  private async bookInTx(tx: PrismaTx, req: BookRequest): Promise<Session> {
    const slot = await this.lockSlot(tx, req.slotId);
    if (!slot || slot.trainerId !== req.trainerId)
      throw new DomainError('NOT_FOUND', 'Slot not found');

    const now = this.clock.now();
    if (req.bookedBy !== 'TRAINER') {
      // Clients (and the autoBook cron on their behalf) only see open slots that are free or reserved for them.
      const visible =
        slot.status === 'OPEN' &&
        (slot.reservedForClientId === null || slot.reservedForClientId === req.clientId);
      if (!visible) throw new DomainError('NOT_FOUND', 'Slot not found');
    }
    await this.assertSlotFree(tx, slot.id);
    if (
      req.bookedBy === 'CLIENT' &&
      !isAtLeastHoursBefore(slot.startsAt, now, this.config.get('BOOKING_CUTOFF_HOURS'))
    ) {
      throw new DomainError('BOOKING_CUTOFF');
    }
    if (req.bookedBy === 'SYSTEM' && slot.startsAt <= now) {
      throw new DomainError('BOOKING_CUTOFF');
    }

    let packageId: string | null = null;
    if (!req.withoutPackage) {
      // Serialize bookings of the same client so `left` is re-read after any concurrent booking commits.
      await tx.$queryRaw`SELECT id FROM "Package" WHERE "clientId" = ${req.clientId} ORDER BY id FOR UPDATE`;
      const active = await this.usage.findActivePackage(req.clientId, slot.startsAt, tx);
      if (!active) throw new DomainError('NO_PACKAGE');
      packageId = active.packageId;
    }

    const planId = req.planId
      ? await this.assertClientPlan(tx, req.trainerId, req.clientId, req.planId)
      : await this.rotatePlan(tx, req.clientId, slot.startsAt);

    return this.translateTaken(() =>
      tx.session.create({
        data: {
          slotId: slot.id,
          trainerId: slot.trainerId,
          clientId: req.clientId,
          packageId,
          planId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          createdById: req.actorId,
        },
      }),
    );
  }

  /** Plan after the plan of the client's previous non-cancelled practice (attendance is irrelevant). */
  async rotatePlan(tx: PrismaTx, clientId: string, startsAt: Date): Promise<string | null> {
    const [plans, previous] = await Promise.all([
      tx.plan.findMany({
        where: { clientId, archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
      tx.session.findFirst({
        where: {
          clientId,
          status: { not: 'CANCELLED' },
          planId: { not: null },
          startsAt: { lt: startsAt },
        },
        orderBy: { startsAt: 'desc' },
        select: { planId: true },
      }),
    ]);
    return nextPlanId(plans, previous?.planId ?? null);
  }

  /** The plan must be one of this client's active plans (a template or a foreign plan is NOT_FOUND). */
  async assertClientPlan(
    tx: PrismaTx,
    trainerId: string,
    clientId: string,
    planId: string,
  ): Promise<string> {
    const plan = await tx.plan.findFirst({
      where: { id: planId, trainerId, clientId, archivedAt: null },
      select: { id: true },
    });
    if (!plan) throw new DomainError('NOT_FOUND', 'Plan not found');
    return plan.id;
  }

  async lockSlot(tx: PrismaTx, slotId: string): Promise<LockedSlot | null> {
    const rows = await tx.$queryRaw<LockedSlot[]>`
      SELECT id, "trainerId", "startsAt", "endsAt", status, "reservedForClientId"
      FROM "Slot" WHERE id = ${slotId} FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Locks the session row and returns it; NOT_FOUND when missing (callers check ownership). */
  async lockSession(tx: PrismaTx, sessionId: string): Promise<Session> {
    await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new DomainError('NOT_FOUND', 'Practice not found');
    return session;
  }

  private async assertSlotFree(tx: PrismaTx, slotId: string): Promise<void> {
    const live = await tx.session.findFirst({
      where: { slotId, status: { not: 'CANCELLED' } },
      select: { id: true },
    });
    if (live) throw new DomainError('SLOT_TAKEN');
  }

  private async translateTaken<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isConstraintViolation(err, 'unique', 'session_one_per_slot'))
        throw new DomainError('SLOT_TAKEN');
      throw err;
    }
  }
}
