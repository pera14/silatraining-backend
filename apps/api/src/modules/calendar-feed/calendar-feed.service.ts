import { Injectable } from '@nestjs/common';
import type { CalendarFeedResponse } from '@sila/contracts';
import ical, { ICalCalendarMethod, ICalEventStatus } from 'ical-generator';
import { randomUUID } from 'node:crypto';
import { deriveToken, sha256 } from '../../common/crypto/tokens';
import { DomainError } from '../../common/errors/domain-error';
import { fullName } from '../../common/http/mappers';
import { isConstraintViolation } from '../../common/prisma/prisma-errors';
import { type PrismaTx, PrismaService } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config.service';
import type { CalendarFeedToken } from '../../generated/prisma/client';

const DAY = 86_400_000;
/** How much history and future the feed carries (calendar apps re-sync it periodically). */
export const FEED_PAST_DAYS = 60;
export const FEED_FUTURE_DAYS = 180;

/**
 * Per-trainer iCal feed of practices (SPEC §5 `GET /calendar/:token.ics`). Same token scheme as join links:
 * token = HMAC(JOIN_TOKEN_SECRET, "calendar:<rowId>"), only sha256(token) is stored, at most one active row per
 * trainer (`calendar_feed_one_active`). Regenerating revokes the old URL immediately.
 *
 * The URL is a bearer secret that ends up in third-party calendar apps, so events carry the minimum a trainer
 * needs (client name + plan), never notes, packages or documents.
 */
@Injectable()
export class CalendarFeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /** The active feed URL, created on first use. */
  async get(trainerId: string): Promise<CalendarFeedResponse> {
    const existing = await this.prisma.calendarFeedToken.findFirst({
      where: { trainerId, revokedAt: null },
    });
    return this.present(existing ?? (await this.create(trainerId)));
  }

  async regenerate(trainerId: string): Promise<CalendarFeedResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.calendarFeedToken.updateMany({
        where: { trainerId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return this.insert(tx, trainerId);
    });
    return this.present(row);
  }

  /** Renders the feed for a raw token; unknown or revoked tokens are 404. */
  async render(token: string, now: Date = new Date()): Promise<string> {
    const row = await this.prisma.calendarFeedToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { trainer: { select: { id: true, role: true, firstName: true, lastName: true } } },
    });
    if (!row || row.revokedAt || row.trainer.role !== 'TRAINER') {
      throw new DomainError('NOT_FOUND', 'Calendar feed not found');
    }

    const sessions = await this.prisma.session.findMany({
      where: {
        trainerId: row.trainerId,
        status: { not: 'CANCELLED' },
        startsAt: {
          gte: new Date(now.getTime() - FEED_PAST_DAYS * DAY),
          lt: new Date(now.getTime() + FEED_FUTURE_DAYS * DAY),
        },
      },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        createdAt: true,
        client: { select: { id: true, firstName: true, lastName: true } },
        plan: { select: { name: true } },
      },
    });

    const calendar = ical({
      name: `SILA · ${fullName(row.trainer)}`,
      prodId: { company: 'SILA Training', product: 'practices', language: 'SR' },
      method: ICalCalendarMethod.PUBLISH,
      // No calendar timezone on purpose: without a VTIMEZONE block ical-generator would write *floating* local
      // times, which some apps show in the device's zone. UTC instants (`…Z`) are unambiguous everywhere.
      ttl: 15 * 60,
    });
    const appUrl = this.config.appUrl;
    for (const s of sessions) {
      const name = fullName(s.client);
      calendar.createEvent({
        id: `${s.id}@sila-training`,
        start: s.startsAt,
        end: s.endsAt,
        stamp: s.createdAt,
        summary: s.plan ? `${name} · ${s.plan.name}` : name,
        status: ICalEventStatus.CONFIRMED,
        url: `${appUrl}/trainer/clients/${s.client.id}`,
      });
    }
    return calendar.toString();
  }

  // ------------------------------------------------------------------ internals

  private async create(trainerId: string): Promise<CalendarFeedToken> {
    try {
      return await this.insert(this.prisma, trainerId);
    } catch (err) {
      // Lost a race with a concurrent first call: the partial unique index keeps one active feed.
      if (isConstraintViolation(err, 'unique')) {
        return this.prisma.calendarFeedToken.findFirstOrThrow({
          where: { trainerId, revokedAt: null },
        });
      }
      throw err;
    }
  }

  private insert(tx: PrismaTx, trainerId: string): Promise<CalendarFeedToken> {
    const id = randomUUID();
    return tx.calendarFeedToken.create({
      data: { id, trainerId, tokenHash: sha256(this.tokenFor(id)) },
    });
  }

  private tokenFor(rowId: string): string {
    return deriveToken(this.config.get('JOIN_TOKEN_SECRET'), 'calendar', rowId);
  }

  private present(row: CalendarFeedToken): CalendarFeedResponse {
    const apiUrl = this.config.get('API_URL').replace(/\/$/, '');
    return { url: `${apiUrl}/calendar/${this.tokenFor(row.id)}.ics` };
  }
}
