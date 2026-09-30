import { Injectable, Logger } from '@nestjs/common';
import type { EndpointBody, SlotSeries } from '@sila/contracts';
import { DomainError } from '../../common/errors/domain-error';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { type PrismaTx, PrismaService } from '../../common/prisma/prisma.service';
import { dateOnlyToIso, isoToDateOnly, localDay } from '../../common/time/time';
import { AppConfig } from '../../config/app-config.service';
import { Prisma, type SlotSeries as SeriesModel } from '../../generated/prisma/client';
import { Clock } from '../sessions/clock';
import { addDays, isoWeekday } from '../sessions/local-day';
import { AutoBookService } from './auto-book.service';
import { LIVE_SESSION, SERIES_INCLUDE, toSlotSeries } from './slot-mappers';
import { findOverlaps, localSlotStart, SLOT_MS, slotEnd } from './slot-time';

const INSERT_CHUNK = 500;

interface MaterializeOptions {
  /**
   * Ignore the watermark and (re)build the whole window from today. Used on create/update, right after the
   * series' future unbooked slots were removed. The nightly run only extends past the last materialized day, so
   * a slot the trainer deleted by hand is not recreated.
   */
  rebuild?: boolean;
  /** Reject with 409 SLOT_OVERLAP when a new slot would overlap a slot outside this series. */
  strict?: boolean;
}

/**
 * Repeating slots (SPEC §4). A series is materialized into Slot rows SLOT_HORIZON_WEEKS ahead: immediately on
 * create/update and nightly by `SeriesCron`. Editing or ending a series only touches future unbooked slots.
 */
@Injectable()
export class SeriesService {
  private readonly logger = new Logger(SeriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly autoBook: AutoBookService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async list(trainerId: string): Promise<SlotSeries[]> {
    const rows = await this.prisma.slotSeries.findMany({
      where: { trainerId },
      include: SERIES_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toSlotSeries);
  }

  async create(
    trainerId: string,
    body: EndpointBody<'trainer.slotSeries.create'>,
  ): Promise<SlotSeries> {
    if (body.reservedForClientId) {
      await this.ownership.assertTrainerOwnsClient(trainerId, body.reservedForClientId);
    }
    const series = await this.prisma.$transaction(async (tx) => {
      const created = await tx.slotSeries.create({
        data: {
          trainerId,
          weekdays: [...new Set(body.weekdays)].sort((a, b) => a - b),
          startTime: body.startTime,
          validFrom: isoToDateOnly(body.validFrom),
          validUntil: body.validUntil ? isoToDateOnly(body.validUntil) : null,
          reservedForClientId: body.reservedForClientId ?? null,
          autoBook: body.autoBook ?? false,
        },
      });
      await this.materialize(tx, created, { rebuild: true, strict: true });
      return created;
    });
    if (series.autoBook) await this.autoBook.run({ seriesId: series.id });
    return this.get(series.id);
  }

  async update(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.slotSeries.update'>,
  ): Promise<SlotSeries> {
    if (body.reservedForClientId) {
      await this.ownership.assertTrainerOwnsClient(trainerId, body.reservedForClientId);
    }
    const series = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SlotSeries" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.slotSeries.findUnique({ where: { id } });
      this.ownership.assertOwnedByTrainer(trainerId, current, 'Series');

      const weekdays = body.weekdays
        ? [...new Set(body.weekdays)].sort((a, b) => a - b)
        : undefined;
      const validUntil =
        body.validUntil === undefined
          ? undefined
          : body.validUntil === null
            ? null
            : isoToDateOnly(body.validUntil);
      if (validUntil && validUntil < current.validFrom) {
        throw new DomainError('VALIDATION_FAILED', '`validUntil` must not be before `validFrom`.');
      }
      const reservedForClientId =
        body.reservedForClientId === undefined
          ? current.reservedForClientId
          : body.reservedForClientId;
      const autoBook = body.autoBook ?? current.autoBook;
      if (autoBook && !reservedForClientId) {
        throw new DomainError('VALIDATION_FAILED', 'autoBook requires reservedForClientId.');
      }

      const updated = await tx.slotSeries.update({
        where: { id },
        data: { weekdays, startTime: body.startTime, validUntil, reservedForClientId, autoBook },
      });

      const scheduleChanged =
        (weekdays !== undefined && weekdays.join() !== current.weekdays.join()) ||
        (body.startTime !== undefined && body.startTime !== current.startTime) ||
        (validUntil !== undefined && validUntil?.getTime() !== current.validUntil?.getTime());
      const futureUnbooked = this.futureUnbooked(id);
      if (scheduleChanged) {
        await tx.slot.deleteMany({ where: futureUnbooked });
        await this.materialize(tx, updated, { rebuild: true, strict: true });
      } else if (reservedForClientId !== current.reservedForClientId) {
        await tx.slot.updateMany({ where: futureUnbooked, data: { reservedForClientId } });
      }
      return updated;
    });
    if (series.autoBook) await this.autoBook.run({ seriesId: series.id });
    return this.get(series.id);
  }

  /** Ends the series: future unbooked slots are removed; past and booked slots stay as standalone slots. */
  async delete(trainerId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.slotSeries.findUnique({ where: { id } });
      this.ownership.assertOwnedByTrainer(trainerId, current, 'Series');
      await tx.slot.deleteMany({ where: this.futureUnbooked(id) });
      await tx.slotSeries.delete({ where: { id } });
    });
  }

  /** Nightly: extends every running series up to the horizon. One failing series never blocks the others. */
  async materializeAll(): Promise<number> {
    const today = localDay(this.clock.now(), this.config.timezone);
    const series = await this.prisma.slotSeries.findMany({
      where: { OR: [{ validUntil: null }, { validUntil: { gte: isoToDateOnly(today) } }] },
    });
    let created = 0;
    for (const s of series) {
      try {
        created += await this.prisma.$transaction((tx) => this.materialize(tx, s));
      } catch (err) {
        this.logger.error(`Materializing series ${s.id} failed: ${(err as Error).message}`);
      }
    }
    return created;
  }

  /**
   * Inserts the series' missing slots from max(validFrom, today, watermark) to today + SLOT_HORIZON_WEEKS
   * (bounded by validUntil). `INSERT … ON CONFLICT DO NOTHING` skips anything overlapping an existing slot, so
   * the operation is idempotent. Returns the number of slots created.
   */
  async materialize(
    tx: PrismaTx,
    series: SeriesModel,
    opts: MaterializeOptions = {},
  ): Promise<number> {
    const zone = this.config.timezone;
    const now = this.clock.now();
    const today = localDay(now, zone);
    const horizon = addDays(today, this.config.get('SLOT_HORIZON_WEEKS') * 7);

    let from = [dateOnlyToIso(series.validFrom), today].sort().at(-1)!;
    if (!opts.rebuild) {
      const last = await tx.slot.findFirst({
        where: { seriesId: series.id },
        orderBy: { startsAt: 'desc' },
        select: { startsAt: true },
      });
      const next = last ? addDays(localDay(last.startsAt, zone), 1) : null;
      if (next && next > from) from = next;
    }
    const until = series.validUntil
      ? [dateOnlyToIso(series.validUntil), horizon].sort()[0]!
      : horizon;

    const weekdays = new Set(series.weekdays);
    const starts: Date[] = [];
    for (let day = from; day <= until; day = addDays(day, 1)) {
      if (!weekdays.has(isoWeekday(day))) continue;
      const s = localSlotStart(day, series.startTime, zone);
      if (s && s > now) starts.push(s);
    }
    if (starts.length === 0) return 0;

    if (opts.strict) {
      const foreign = await tx.slot.findMany({
        where: {
          trainerId: series.trainerId,
          OR: [{ seriesId: null }, { seriesId: { not: series.id } }],
          startsAt: {
            gt: new Date(starts[0]!.getTime() - SLOT_MS),
            lt: new Date(starts.at(-1)!.getTime() + SLOT_MS),
          },
        },
        select: { startsAt: true },
      });
      const conflicts = findOverlaps(
        starts,
        foreign.map((f) => f.startsAt),
      );
      if (conflicts.length > 0) {
        throw new DomainError('SLOT_OVERLAP', undefined, {
          conflicts: conflicts.map((d) => d.toISOString()),
        });
      }
    }

    let inserted = 0;
    for (let i = 0; i < starts.length; i += INSERT_CHUNK) {
      const rows = starts.slice(i, i + INSERT_CHUNK).map(
        (s) => Prisma.sql`(gen_random_uuid()::text, ${series.trainerId}, ${s}, ${slotEnd(s)},
          'OPEN'::"SlotStatus", ${series.reservedForClientId}, ${series.id})`,
      );
      inserted += await tx.$executeRaw`
        INSERT INTO "Slot" (id, "trainerId", "startsAt", "endsAt", status, "reservedForClientId", "seriesId")
        VALUES ${Prisma.join(rows)}
        ON CONFLICT DO NOTHING`;
    }
    return inserted;
  }

  private futureUnbooked(seriesId: string): Prisma.SlotWhereInput {
    return { seriesId, startsAt: { gt: this.clock.now() }, sessions: { none: LIVE_SESSION } };
  }

  private async get(id: string): Promise<SlotSeries> {
    return toSlotSeries(
      await this.prisma.slotSeries.findUniqueOrThrow({ where: { id }, include: SERIES_INCLUDE }),
    );
  }
}
