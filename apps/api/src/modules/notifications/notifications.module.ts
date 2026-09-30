import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { NotificationsCron } from './notifications.cron';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

/**
 * Owner: Agent B (feat/content). Registered in AppModule during Phase 0 so nobody edits app.module.ts later.
 * Emails for domain events (A emits, B listens) plus the reminder / expiring-package crons. No HTTP endpoints.
 * SessionsModule is imported only for its Clock, so e2e tests pin "now" for both modules at once.
 */
@Module({
  imports: [SessionsModule],
  providers: [NotificationsService, NotificationsListener, NotificationsCron],
  exports: [NotificationsService],
})
export class NotificationsModule {}
