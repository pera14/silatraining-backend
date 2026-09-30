import { Controller } from '@nestjs/common';
import { SlotsService } from './slots.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class SlotsController {
  constructor(private readonly service: SlotsService) {}
}
