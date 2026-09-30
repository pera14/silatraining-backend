import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { AutoBookService } from './auto-book.service';
import { SeriesService } from './series.service';
import { SeriesCron } from './series.cron';
import { SlotsController } from './slots.controller';
import { SlotsService } from './slots.service';

/**
 * Owner: Agent A (feat/scheduling). Slots, repeating series (+ nightly materialization and autoBook), the
 * trainer calendar and the client's bookable slots. Depends on SessionsModule for the booking core.
 */
@Module({
  imports: [SessionsModule],
  controllers: [SlotsController],
  providers: [SlotsService, SeriesService, AutoBookService, SeriesCron],
  exports: [SlotsService, SeriesService, AutoBookService],
})
export class SlotsModule {}
