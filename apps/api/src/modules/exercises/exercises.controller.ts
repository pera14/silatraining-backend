import { Controller } from '@nestjs/common';
import { ExercisesService } from './exercises.service';

/** Empty shell (Phase 0). Implement the endpoints listed in README.md, from @sila/contracts. */
@Controller()
export class ExercisesController {
  constructor(private readonly service: ExercisesService) {}
}
