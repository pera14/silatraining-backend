import { Injectable } from '@nestjs/common';
import type {
  ClientHome,
  ClientPractice,
  EndpointBody,
  EndpointQuery,
  TodayPractice,
  TodayResponse,
  TrainerPractice,
} from '@sila/contracts';
import { DomainError } from '../../common/errors/domain-error';
import { toPersonSummary } from '../../common/http/mappers';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { PackageUsageService } from '../../common/package-usage/package-usage.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { localDay } from '../../common/time/time';
import { AppConfig } from '../../config/app-config.service';
import { BookingService } from './booking.service';
import { Clock } from './clock';
import { localDayWindow } from './local-day';
import {
  CLIENT_PRACTICE_INCLUDE,
  isAtLeastHoursBefore,
  toClientPractice,
  toTrainerPractice,
  TRAINER_PRACTICE_INCLUDE,
} from './session-mappers';

/** Past practices returned by `GET /client/sessions?scope=past` and the trainer's per-client list (newest first). */
const PAST_LIMIT = 100;

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly booking: BookingService,
    private readonly ownership: OwnershipService,
    private readonly usage: PackageUsageService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ trainer

  async trainerBook(
    trainerId: string,
    body: EndpointBody<'trainer.sessions.create'>,
  ): Promise<TrainerPractice> {
    await this.ownership.assertTrainerOwnsClient(trainerId, body.clientId);
    const session = await this.booking.book({
      slotId: body.slotId,
      clientId: body.clientId,
      trainerId,
      actorId: trainerId,
      bookedBy: 'TRAINER',
      planId: body.planId,
      withoutPackage: body.withoutPackage,
    });
    return this.trainerPractice(session.id);
  }

  /** Attendance (Came / Didn't come) and/or plan. The trainer can change attendance any time after the day starts. */
  async trainerUpdate(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.sessions.update'>,
  ): Promise<TrainerPractice> {
    await this.prisma.$transaction(async (tx) => {
      const session = await this.booking.lockSession(tx, id);
      this.ownership.assertOwnedByTrainer(trainerId, session, 'Practice');
      if (session.status === 'CANCELLED') throw new DomainError('INVALID_STATE');

      const now = this.clock.now();
      const zone = this.config.timezone;
      if (body.status && localDay(session.startsAt, zone) > localDay(now, zone)) {
        throw new DomainError(
          'INVALID_STATE',
          'Attendance can be marked from the day of the practice.',
        );
      }
      const planId =
        body.planId === undefined || body.planId === null
          ? body.planId
          : await this.booking.assertClientPlan(tx, trainerId, session.clientId, body.planId);

      await tx.session.update({
        where: { id },
        data: {
          ...(body.status ? { status: body.status, attendanceMarkedAt: now } : {}),
          ...(planId !== undefined ? { planId } : {}),
        },
      });
    });
    return this.trainerPractice(id);
  }

  async trainerMove(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.sessions.move'>,
  ): Promise<TrainerPractice> {
    await this.booking.move({ sessionId: id, trainerId, slotId: body.slotId });
    return this.trainerPractice(id);
  }

  /** The trainer cancels any time; default: practice returned if ≥ CANCEL_CUTOFF_HOURS before start. */
  async trainerCancel(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.sessions.cancel'>,
  ): Promise<TrainerPractice> {
    await this.booking.cancel({
      sessionId: id,
      actorId: trainerId,
      cancelledBy: 'TRAINER',
      audit: true,
      authorize: (s) => this.ownership.assertOwnedByTrainer(trainerId, s, 'Practice'),
      decide: (s, now) =>
        body.returnPractice ??
        isAtLeastHoursBefore(s.startsAt, now, this.config.get('CANCEL_CUTOFF_HOURS')),
    });
    return this.trainerPractice(id);
  }

  /** Practices of one local day (default today), time order, cancelled ones excluded. */
  async today(trainerId: string, query: EndpointQuery<'trainer.today'>): Promise<TodayResponse> {
    const zone = this.config.timezone;
    const date = query.date ?? localDay(this.clock.now(), zone);
    const { start, end } = localDayWindow(date, zone);

    const sessions = await this.prisma.session.findMany({
      where: { trainerId, startsAt: { gte: start, lt: end }, status: { not: 'CANCELLED' } },
      include: {
        ...TRAINER_PRACTICE_INCLUDE,
        package: { select: { id: true, name: true, paymentStatus: true } },
      },
      orderBy: { startsAt: 'asc' },
    });
    const clientIds = [...new Set(sessions.map((s) => s.clientId))];
    const packageIds = [...new Set(sessions.flatMap((s) => (s.packageId ? [s.packageId] : [])))];

    const [notes, plans, usage] = await Promise.all([
      this.prisma.clientNote.findMany({
        where: { clientId: { in: clientIds }, trainerId, pinned: true },
        select: { id: true, body: true, clientId: true },
      }),
      this.prisma.plan.findMany({
        where: { clientId: { in: clientIds }, trainerId, archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, clientId: true },
      }),
      this.usage.getUsage(packageIds),
    ]);
    const noteByClient = new Map(notes.map((n) => [n.clientId, { id: n.id, body: n.body }]));

    const practices = sessions.map((s): TodayPractice => {
      const pkgUsage = s.packageId ? usage.get(s.packageId) : undefined;
      return {
        ...toTrainerPractice(s),
        pinnedNote: noteByClient.get(s.clientId) ?? null,
        package:
          s.package && pkgUsage
            ? {
                packageId: s.package.id,
                name: s.package.name,
                left: pkgUsage.left,
                total: pkgUsage.available,
                paymentStatus: s.package.paymentStatus,
              }
            : null,
        clientPlans: plans
          .filter((p) => p.clientId === s.clientId)
          .map((p) => ({ id: p.id, name: p.name })),
      };
    });
    return { date, practices };
  }

  // ------------------------------------------------------------------ client

  async clientBook(
    clientId: string,
    body: EndpointBody<'client.sessions.create'>,
  ): Promise<ClientPractice> {
    const trainerId = await this.activeTrainerOf(clientId);
    if (!trainerId) throw new DomainError('NOT_FOUND', 'Slot not found');
    const session = await this.booking.book({
      slotId: body.slotId,
      clientId,
      trainerId,
      actorId: clientId,
      bookedBy: 'CLIENT',
    });
    return this.clientPractice(session.id);
  }

  /** Client cancellation: only ≥ CANCEL_CUTOFF_HOURS before start, and the practice always goes back. */
  async clientCancel(clientId: string, id: string): Promise<ClientPractice> {
    await this.booking.cancel({
      sessionId: id,
      actorId: clientId,
      cancelledBy: 'CLIENT',
      authorize: (s) => this.ownership.assertOwnedByClient(clientId, s, 'Practice'),
      decide: (s, now) => {
        if (!isAtLeastHoursBefore(s.startsAt, now, this.config.get('CANCEL_CUTOFF_HOURS'))) {
          throw new DomainError('CANCEL_CUTOFF');
        }
        return true;
      },
    });
    return this.clientPractice(id);
  }

  /**
   * `upcoming`: non-cancelled practices that have not ended, soonest first.
   * `past`: practices that have ended (any status), newest first. Cancelled future practices appear in neither.
   */
  /**
   * A client's practices for the trainer's client detail: `upcoming` = live practices that have not ended (soonest
   * first); `past` = ended or cancelled ones (newest first, capped like the client's own history).
   */
  async trainerClientSessions(
    trainerId: string,
    clientId: string,
    query: EndpointQuery<'trainer.clients.sessions'>,
  ): Promise<TrainerPractice[]> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const now = this.clock.now();
    const upcoming = (query.scope ?? 'upcoming') === 'upcoming';
    const rows = await this.prisma.session.findMany({
      where: upcoming
        ? { trainerId, clientId, endsAt: { gt: now }, status: { not: 'CANCELLED' } }
        : { trainerId, clientId, OR: [{ endsAt: { lte: now } }, { status: 'CANCELLED' }] },
      include: TRAINER_PRACTICE_INCLUDE,
      orderBy: [{ startsAt: upcoming ? 'asc' : 'desc' }, { createdAt: 'asc' }],
      take: upcoming ? undefined : PAST_LIMIT,
    });
    return rows.map(toTrainerPractice);
  }

  async clientList(
    clientId: string,
    query: EndpointQuery<'client.sessions.list'>,
  ): Promise<ClientPractice[]> {
    const now = this.clock.now();
    const upcoming = (query.scope ?? 'upcoming') === 'upcoming';
    const rows = await this.prisma.session.findMany({
      where: upcoming
        ? { clientId, endsAt: { gt: now }, status: { not: 'CANCELLED' } }
        : { clientId, endsAt: { lte: now } },
      include: CLIENT_PRACTICE_INCLUDE,
      orderBy: { startsAt: upcoming ? 'asc' : 'desc' },
      take: upcoming ? undefined : PAST_LIMIT,
    });
    const cutoff = this.config.get('CANCEL_CUTOFF_HOURS');
    return rows.map((s) => toClientPractice(s, now, cutoff));
  }

  async clientHome(clientId: string): Promise<ClientHome> {
    const now = this.clock.now();
    const link = await this.prisma.trainerClient.findUnique({
      where: { clientId },
      include: {
        trainer: { select: { id: true, firstName: true, lastName: true, photoUrl: true } },
      },
    });
    const [active, next] = await Promise.all([
      this.usage.findActivePackage(clientId, now),
      this.prisma.session.findFirst({
        where: { clientId, status: 'BOOKED', endsAt: { gt: now } },
        include: CLIENT_PRACTICE_INCLUDE,
        orderBy: { startsAt: 'asc' },
      }),
    ]);
    const pkg = active
      ? await this.prisma.package.findUnique({
          where: { id: active.packageId },
          select: { name: true, extendedUntil: true },
        })
      : null;
    return {
      hasActivePackage: !!(active && pkg),
      left: active?.usage.left ?? null,
      total: active?.usage.available ?? null,
      validUntil: active?.usage.effectiveUntil ?? null,
      extended: !!pkg?.extendedUntil,
      packageName: pkg?.name ?? null,
      nextPractice: next
        ? toClientPractice(next, now, this.config.get('CANCEL_CUTOFF_HOURS'))
        : null,
      trainer: link && !link.archivedAt ? toPersonSummary(link.trainer) : null,
    };
  }

  // ------------------------------------------------------------------ helpers

  /** The client's trainer, or null when not linked or archived (archived clients cannot book). */
  async activeTrainerOf(clientId: string): Promise<string | null> {
    const link = await this.prisma.trainerClient.findUnique({ where: { clientId } });
    return link && !link.archivedAt ? link.trainerId : null;
  }

  private async trainerPractice(id: string): Promise<TrainerPractice> {
    const s = await this.prisma.session.findUniqueOrThrow({
      where: { id },
      include: TRAINER_PRACTICE_INCLUDE,
    });
    return toTrainerPractice(s);
  }

  private async clientPractice(id: string): Promise<ClientPractice> {
    const s = await this.prisma.session.findUniqueOrThrow({
      where: { id },
      include: CLIENT_PRACTICE_INCLUDE,
    });
    return toClientPractice(s, this.clock.now(), this.config.get('CANCEL_CUTOFF_HOURS'));
  }
}
