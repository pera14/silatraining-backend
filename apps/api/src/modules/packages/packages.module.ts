import { Module } from '@nestjs/common';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';

/**
 * Owner: Agent A (feat/scheduling). Registered in AppModule during Phase 0 so nobody edits app.module.ts later.
 * Add providers/controllers here freely; see README.md for the endpoints to implement.
 */
@Module({
  controllers: [PackagesController],
  providers: [PackagesService],
  exports: [PackagesService],
})
export class PackagesModule {}
