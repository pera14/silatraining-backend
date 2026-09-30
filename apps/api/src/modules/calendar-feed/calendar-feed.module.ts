import { Module } from '@nestjs/common';
import { CalendarFeedController } from './calendar-feed.controller';
import { CalendarFeedService } from './calendar-feed.service';

/**
 * Owner: Agent B (feat/content). Registered in AppModule during Phase 0 so nobody edits app.module.ts later.
 * Add providers/controllers here freely; see README.md for the endpoints to implement.
 */
@Module({
  controllers: [CalendarFeedController],
  providers: [CalendarFeedService],
  exports: [CalendarFeedService],
})
export class CalendarFeedModule {}
