import { Controller } from '@nestjs/common';
import { PackagesService } from './packages.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class PackagesController {
  constructor(private readonly service: PackagesService) {}
}
