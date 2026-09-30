import { Controller } from '@nestjs/common';
import { SessionsService } from './sessions.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class SessionsController {
  constructor(private readonly service: SessionsService) {}
}
