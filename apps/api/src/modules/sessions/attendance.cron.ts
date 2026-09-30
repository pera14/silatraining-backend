import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RULES } from '@sila/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config.service';
import { Clock } from './clock';
import { startOfLocalDay } from './local-day';

/**
 * Nightly auto-attendance (SPEC §4): practices still BOOKED once their local day is over become ATTENDED, so the
 * trainer only taps for no-shows. Idempotent; a missed night is caught up by the next run.
 */
@Injectable()
export class AttendanceCron {
  private readonly logger = new Logger(AttendanceCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  // The decorator needs a static zone; the cutoff itself is computed in APP_TIMEZONE.
  @Cron('5 0 * * *', { name: 'sessions.autoAttend', timeZone: RULES.timezone })
  async run(): Promise<void> {
    const marked = await this.autoMarkAttended();
    if (marked > 0) this.logger.log(`Auto-marked ${marked} practice(s) as attended`);
  }

  /** Marks every BOOKED practice that ended by today's local midnight. Returns how many changed. */
  async autoMarkAttended(): Promise<number> {
    const now = this.clock.now();
    const todayStart = startOfLocalDay(now, this.config.timezone);
    const { count } = await this.prisma.$transaction((tx) =>
      tx.session.updateMany({
        where: { status: 'BOOKED', endsAt: { lte: todayStart } },
        data: { status: 'ATTENDED', attendanceMarkedAt: now },
      }),
    );
    return count;
  }
}
