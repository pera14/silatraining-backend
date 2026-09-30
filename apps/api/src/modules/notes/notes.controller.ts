import { Controller } from '@nestjs/common';
import { NotesService } from './notes.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class NotesController {
  constructor(private readonly service: NotesService) {}
}
