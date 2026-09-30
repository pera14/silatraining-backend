import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * Owner: Agent A (feat/scheduling). Registered in AppModule during Phase 0 so nobody edits app.module.ts later.
 * Add providers/controllers here freely; see README.md for the endpoints to implement.
 */
@Module({
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
