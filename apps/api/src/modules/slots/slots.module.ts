import { Module } from '@nestjs/common';
import { SlotsController } from './slots.controller';
import { SlotsService } from './slots.service';

/**
 * Owner: Agent A (feat/scheduling). Registered in AppModule during Phase 0 so nobody edits app.module.ts later.
 * Add providers/controllers here freely; see README.md for the endpoints to implement.
 */
@Module({
  controllers: [SlotsController],
  providers: [SlotsService],
  exports: [SlotsService],
})
export class SlotsModule {}
