import { Module } from '@nestjs/common';
import { AttendanceCron } from './attendance.cron';
import { BookingService } from './booking.service';
import { Clock } from './clock';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * Owner: Agent A (feat/scheduling). Practices: booking (client/trainer/system), move, cancel, attendance,
 * Today, client home and practice lists, nightly auto-attendance.
 */
@Module({
  controllers: [SessionsController],
  providers: [Clock, BookingService, SessionsService, AttendanceCron],
  exports: [Clock, BookingService, SessionsService],
})
export class SessionsModule {}
