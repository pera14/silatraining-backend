import { Controller } from '@nestjs/common';
import { DocumentsService } from './documents.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}
}
