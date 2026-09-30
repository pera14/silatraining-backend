import { Injectable, Logger } from '@nestjs/common';
import { RULES } from '@sila/contracts';
import { DateTime } from 'luxon';
import type {
  ClientJoinedEvent,
  SessionBookedEvent,
  SessionCancelledEvent,
  SessionMovedEvent,
} from '../../common/events/events';
import { fullName } from '../../common/http/mappers';
import { MailerService } from '../../common/mailer/mailer.service';
import { isConstraintViolation } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { dateOnlyToIso, localDay } from '../../common/time/time';
import { AppConfig } from '../../config/app-config.service';
import { Clock } from '../sessions/clock';
import { type EmailContent, renderEmail } from './email-layout';
import {
  bookingConfirmedEmail,
  cancelledByClientEmail,
  cancelledByTrainerEmail,
  type ExpiringPackageLine,
  movedEmail,
  packagesExpiringEmail,
  reminderEmail,
  type TemplateContext,
  welcomeEmail,
} from './templates';

const HOUR = 3_600_000;
export const REMINDER_LEAD_HOURS = 24;

/** NotificationLog kinds (one email per kind + entity + recipient, ever). */
export const NOTIFICATION_KIND = {
  welcome: 'client.welcome',
  packageExpiring: 'package.expiring',
} as const;

const PERSON = { select: { id: true, email: true, firstName: true, lastName: true } } as const;

/**
 * Every transactional email (SPEC §9 Prompt B). Event handlers run after the producer's transaction committed
 * and never throw (a mail problem must not surface anywhere). Practices already in the past produce no email:
 * the trainer may record or fix history retroactively.
 *
 * Reminders: `Session.reminderSentAt` is claimed atomically before sending, so overlapping cron runs (or two API
 * instances) cannot double-send. A booking or move that lands inside the 24 h window gets no separate reminder:
 * its own email already carries the time.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ events

  async onClientJoined(e: ClientJoinedEvent): Promise<void> {
    const [client, trainer] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: e.clientId }, ...PERSON }),
      this.prisma.user.findUnique({ where: { id: e.trainerId }, ...PERSON }),
    ]);
    if (!client || !trainer) return;
    await this.sendOnce(
      { kind: NOTIFICATION_KIND.welcome, entityId: e.trainerId, recipientId: client.id },
      client.email,
      welcomeEmail(this.ctx, { clientFirstName: client.firstName, trainerName: fullName(trainer) }),
    );
  }

  async onSessionBooked(e: SessionBookedEvent): Promise<void> {
    const now = this.clock.now();
    if (e.startsAt <= now) return;
    const session = await this.prisma.session.findUnique({
      where: { id: e.sessionId },
      select: { status: true, client: PERSON, trainer: PERSON },
    });
    if (!isLive(session) || session.status !== 'BOOKED') return;
    await this.suppressReminderIfDue(e.sessionId, e.startsAt, now);
    await this.send(
      session.client.email,
      bookingConfirmedEmail(this.ctx, {
        startsAt: e.startsAt,
        trainerName: fullName(session.trainer),
        bookedBy: e.bookedBy,
        cancelCutoffHours: this.config.get('CANCEL_CUTOFF_HOURS'),
      }),
    );
  }

  /** By client → the trainer is told; by trainer → the client is told. */
  async onSessionCancelled(e: SessionCancelledEvent): Promise<void> {
    if (e.startsAt <= this.clock.now()) return;
    const session = await this.prisma.session.findUnique({
      where: { id: e.sessionId },
      select: { packageId: true, client: PERSON, trainer: PERSON },
    });
    if (!isLive(session)) return;
    if (e.cancelledBy === 'CLIENT') {
      await this.send(
        session.trainer.email,
        cancelledByClientEmail(this.ctx, {
          startsAt: e.startsAt,
          clientName: fullName(session.client),
          clientId: session.client.id,
          practiceReturned: session.packageId !== null && e.practiceReturned,
        }),
      );
    } else {
      await this.send(
        session.client.email,
        cancelledByTrainerEmail(this.ctx, {
          startsAt: e.startsAt,
          trainerName: fullName(session.trainer),
          practiceReturned: session.packageId === null ? null : e.practiceReturned,
        }),
      );
    }
  }

  /** Only trainers move practices: tell the client, and re-arm the reminder for the new time. */
  async onSessionMoved(e: SessionMovedEvent): Promise<void> {
    const now = this.clock.now();
    if (e.toStartsAt <= now) return;
    const session = await this.prisma.session.findUnique({
      where: { id: e.sessionId },
      select: { status: true, client: PERSON, trainer: PERSON },
    });
    if (!isLive(session) || session.status !== 'BOOKED') return;
    const withinWindow = e.toStartsAt.getTime() - now.getTime() <= REMINDER_LEAD_HOURS * HOUR;
    // Guarded by startsAt: a later move of the same practice owns the flag.
    await this.prisma.session.updateMany({
      where: { id: e.sessionId, startsAt: e.toStartsAt },
      data: { reminderSentAt: withinWindow ? now : null },
    });
    await this.send(
      session.client.email,
      movedEmail(this.ctx, {
        from: e.fromStartsAt,
        to: e.toStartsAt,
        trainerName: fullName(session.trainer),
      }),
    );
  }

  // ------------------------------------------------------------------ crons

  /**
   * Sends the reminder for every BOOKED practice starting within the next 24 h that has none yet. Returns the
   * number of emails sent. A failed send releases the claim so the next run retries.
   */
  async sendDueReminders(now: Date = this.clock.now()): Promise<number> {
    const until = new Date(now.getTime() + REMINDER_LEAD_HOURS * HOUR);
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "Session" SET "reminderSentAt" = ${now}
      WHERE status = 'BOOKED' AND "reminderSentAt" IS NULL
        AND "startsAt" > ${now} AND "startsAt" <= ${until}
      RETURNING id`;
    if (claimed.length === 0) return 0;

    const sessions = (
      await this.prisma.session.findMany({
        where: { id: { in: claimed.map((c) => c.id) } },
        select: { id: true, startsAt: true, client: PERSON, trainer: PERSON },
        orderBy: { startsAt: 'asc' },
      })
    ).filter(isLive);
    const cutoffHours = this.config.get('CANCEL_CUTOFF_HOURS');
    let sent = 0;
    for (const s of sessions) {
      const ok = await this.send(
        s.client.email,
        reminderEmail(this.ctx, {
          startsAt: s.startsAt,
          trainerName: fullName(s.trainer),
          cancelCutoffHours: cutoffHours,
          canStillCancel: s.startsAt.getTime() - now.getTime() >= cutoffHours * HOUR,
        }),
      );
      if (ok) sent++;
      else {
        await this.prisma.session.updateMany({
          where: { id: s.id, reminderSentAt: now },
          data: { reminderSentAt: null },
        });
      }
    }
    return sent;
  }

  /**
   * One digest per trainer listing their active clients' packages that end within 5 days with practices left.
   * Each package is announced once per end date (an extension that is about to run out again is announced again).
   */
  async sendExpiringPackageDigests(now: Date = this.clock.now()): Promise<number> {
    const zone = this.config.timezone;
    const today = localDay(now, zone);
    const horizon = DateTime.fromISO(today, { zone: 'utc' })
      .plus({ days: RULES.expiringWithinDays })
      .toISODate()!;
    const rows = await this.prisma.$queryRaw<
      Array<{
        packageId: string;
        trainerId: string;
        name: string;
        left: number;
        effectiveUntil: Date;
        firstName: string;
        lastName: string;
      }>
    >`
      SELECT u."packageId", u."trainerId", p.name, u."left", u."effectiveUntil", c."firstName", c."lastName"
      FROM package_usage u
      JOIN "Package" p ON p.id = u."packageId"
      JOIN "TrainerClient" tc ON tc."clientId" = u."clientId" AND tc."trainerId" = u."trainerId"
      JOIN "User" c ON c.id = u."clientId"
      WHERE tc."archivedAt" IS NULL
        AND u."left" > 0
        AND p."validFrom" <= ${today}::date
        AND u."effectiveUntil" >= ${today}::date
        AND u."effectiveUntil" <= ${horizon}::date
      ORDER BY u."effectiveUntil" ASC, c."firstName" ASC`;

    const byTrainer = new Map<string, Array<{ logEntityId: string; line: ExpiringPackageLine }>>();
    for (const r of rows) {
      const effectiveUntil = dateOnlyToIso(r.effectiveUntil);
      const list = byTrainer.get(r.trainerId) ?? [];
      list.push({
        logEntityId: `${r.packageId}:${effectiveUntil}`,
        line: {
          clientName: fullName(r),
          packageName: r.name,
          left: r.left,
          effectiveUntil,
        },
      });
      byTrainer.set(r.trainerId, list);
    }

    let sent = 0;
    for (const [trainerId, entries] of byTrainer) {
      const claimed: typeof entries = [];
      for (const entry of entries) {
        const log = { kind: NOTIFICATION_KIND.packageExpiring, entityId: entry.logEntityId };
        if (await this.claim({ ...log, recipientId: trainerId })) claimed.push(entry);
      }
      if (claimed.length === 0) continue;

      const trainer = await this.prisma.user.findUnique({ where: { id: trainerId }, ...PERSON });
      const ok =
        !!trainer &&
        (await this.send(
          trainer.email,
          packagesExpiringEmail(this.ctx, {
            packages: claimed.map((c) => c.line),
            withinDays: RULES.expiringWithinDays,
          }),
        ));
      if (ok) sent++;
      else {
        await this.prisma.notificationLog.deleteMany({
          where: {
            kind: NOTIFICATION_KIND.packageExpiring,
            recipientId: trainerId,
            entityId: { in: claimed.map((c) => c.logEntityId) },
          },
        });
      }
    }
    return sent;
  }

  // ------------------------------------------------------------------ internals

  private get ctx(): TemplateContext {
    return { appUrl: this.config.appUrl, zone: this.config.timezone };
  }

  private send(to: string, content: EmailContent): Promise<boolean> {
    const email = renderEmail(content, this.config.appUrl);
    return this.mailer.send({ to, subject: email.subject, text: email.text, html: email.html });
  }

  /** Sends at most once per (kind, entity, recipient); a failed send releases the claim. */
  private async sendOnce(
    log: { kind: string; entityId: string; recipientId: string },
    to: string,
    content: EmailContent,
  ): Promise<boolean> {
    if (!(await this.claim(log))) return false;
    const ok = await this.send(to, content);
    if (!ok) await this.prisma.notificationLog.deleteMany({ where: log });
    return ok;
  }

  /** Inserts the NotificationLog row; false when it already exists (someone sent or is sending it). */
  private async claim(log: { kind: string; entityId: string; recipientId: string }) {
    try {
      await this.prisma.notificationLog.create({ data: log });
      return true;
    } catch (err) {
      if (isConstraintViolation(err, 'unique')) return false;
      throw err;
    }
  }

  /** The booking email already tells the time; a practice inside the reminder window gets no second email. */
  private async suppressReminderIfDue(sessionId: string, startsAt: Date, now: Date) {
    if (startsAt.getTime() - now.getTime() > REMINDER_LEAD_HOURS * HOUR) return;
    await this.prisma.session.updateMany({
      where: { id: sessionId, reminderSentAt: null },
      data: { reminderSentAt: now },
    });
  }

  /** Wraps an event handler: log, never throw into the emitter. */
  async safely(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`${what} failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }
}

/**
 * Relations are loaded in separate queries, so a user deleted in between ("Delete client") comes back as null
 * despite the non-null type. Such a practice no longer needs an email.
 */
function isLive<T extends { client: unknown; trainer: unknown }>(session: T | null): session is T {
  return !!session && session.client != null && session.trainer != null;
}
