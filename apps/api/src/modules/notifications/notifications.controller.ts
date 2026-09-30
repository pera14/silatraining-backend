import { Controller } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
}
