import { Controller } from '@nestjs/common';
import { CalendarFeedService } from './calendar-feed.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class CalendarFeedController {
  constructor(private readonly service: CalendarFeedService) {}
}
