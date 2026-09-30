import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RULES } from '@sila/contracts';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsCron {
  private readonly logger = new Logger(NotificationsCron.name);
  private remindersRunning = false;

  constructor(private readonly notifications: NotificationsService) {}

  /** Every 15 minutes: 24 h reminders (claimed via Session.reminderSentAt). */
  @Cron('*/15 * * * *', { name: 'notifications.reminders' })
  async reminders(): Promise<void> {
    // A slow SMTP run must not overlap the next tick (the claim makes it safe anyway; this avoids the load).
    if (this.remindersRunning) return;
    this.remindersRunning = true;
    try {
      const sent = await this.notifications.sendDueReminders();
      if (sent > 0) this.logger.log(`Sent ${sent} practice reminder(s)`);
    } catch (err) {
      this.logger.error(`Reminder run failed: ${String(err)}`);
    } finally {
      this.remindersRunning = false;
    }
  }

  /** Daily 08:00 local: "packages expiring within 5 days" digest to each trainer. */
  @Cron('0 8 * * *', { name: 'notifications.packagesExpiring', timeZone: RULES.timezone })
  async packagesExpiring(): Promise<void> {
    try {
      const sent = await this.notifications.sendExpiringPackageDigests();
      if (sent > 0) this.logger.log(`Sent ${sent} expiring-package digest(s)`);
    } catch (err) {
      this.logger.error(`Expiring-package run failed: ${String(err)}`);
    }
  }
}
