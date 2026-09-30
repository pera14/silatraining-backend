import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RULES } from '@sila/contracts';
import { AutoBookService } from './auto-book.service';
import { SeriesService } from './series.service';

/** Nightly: extend every series to SLOT_HORIZON_WEEKS ahead, then autoBook reserved series. */
@Injectable()
export class SeriesCron {
  private readonly logger = new Logger(SeriesCron.name);

  constructor(
    private readonly series: SeriesService,
    private readonly autoBook: AutoBookService,
  ) {}

  // 03:30 local: clear of the 02:00–03:00 hour that is skipped/repeated on DST change days.
  @Cron('30 3 * * *', { name: 'slots.materializeSeries', timeZone: RULES.timezone })
  async run(): Promise<void> {
    const created = await this.series.materializeAll();
    const booked = await this.autoBook.run();
    if (created > 0 || booked > 0) {
      this.logger.log(`Series: ${created} slot(s) materialized, ${booked} practice(s) auto-booked`);
    }
  }
}
