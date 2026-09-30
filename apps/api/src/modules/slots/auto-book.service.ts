import { Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BookingService } from '../sessions/booking.service';
import { Clock } from '../sessions/clock';
import { LIVE_SESSION } from './slot-mappers';

/** Booking outcomes that just mean "not this slot": skip it and keep going. */
const SKIPPABLE = new Set(['NO_PACKAGE', 'SLOT_TAKEN', 'NOT_FOUND', 'BOOKING_CUTOFF']);

/**
 * autoBook (SPEC §4): a series reserved for a client with `autoBook` books its future slots for that client
 * whenever an active package with practices left covers the date. Otherwise the slot just stays reserved.
 *
 * A slot where the client already cancelled a practice is never re-booked, so a cancellation sticks.
 * Runs nightly after materialization, and right after a series or a package changes.
 */
@Injectable()
export class AutoBookService {
  private readonly logger = new Logger(AutoBookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly booking: BookingService,
    private readonly clock: Clock,
  ) {}

  /** Returns the number of practices booked. */
  async run(filter: { seriesId?: string; clientId?: string } = {}): Promise<number> {
    const series = await this.prisma.slotSeries.findMany({
      where: {
        autoBook: true,
        id: filter.seriesId,
        reservedForClientId: filter.clientId ?? { not: null },
      },
      select: { id: true, trainerId: true, reservedForClientId: true },
    });

    let booked = 0;
    for (const s of series) {
      const clientId = s.reservedForClientId!;
      const link = await this.prisma.trainerClient.findUnique({ where: { clientId } });
      if (!link || link.trainerId !== s.trainerId || link.archivedAt) continue;

      const slots = await this.prisma.slot.findMany({
        where: {
          seriesId: s.id,
          status: 'OPEN',
          reservedForClientId: clientId,
          startsAt: { gt: this.clock.now() },
          sessions: { none: { OR: [LIVE_SESSION, { clientId }] } },
        },
        orderBy: { startsAt: 'asc' },
        select: { id: true },
      });
      for (const slot of slots) {
        try {
          await this.booking.book({
            slotId: slot.id,
            clientId,
            trainerId: s.trainerId,
            actorId: s.trainerId,
            bookedBy: 'SYSTEM',
          });
          booked++;
        } catch (err) {
          if (err instanceof DomainError && SKIPPABLE.has(err.code)) continue;
          this.logger.error(`autoBook of slot ${slot.id} failed: ${(err as Error).message}`);
        }
      }
    }
    return booked;
  }
}
