import { Controller } from '@nestjs/common';
import { PlansService } from './plans.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class PlansController {
  constructor(private readonly service: PlansService) {}
}
