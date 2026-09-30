import { Module } from '@nestjs/common';
import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';

/**
 * Owner: Agent B (feat/content). Registered in AppModule during Phase 0 so nobody edits app.module.ts later.
 * Add providers/controllers here freely; see README.md for the endpoints to implement.
 */
@Module({
  controllers: [ExercisesController],
  providers: [ExercisesService],
  exports: [ExercisesService],
})
export class ExercisesModule {}
