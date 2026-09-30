import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { SlotsModule } from '../slots/slots.module';
import { ClientsService } from './clients.service';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';

/**
 * Owner: Agent A (feat/scheduling). Package types, packages (add, mark paid, extend, adjust), the trainer's
 * client list/detail/archive with flags, the client's package history. Imports: packages → slots → sessions.
 */
@Module({
  imports: [SessionsModule, SlotsModule],
  controllers: [PackagesController],
  providers: [PackagesService, ClientsService],
  exports: [PackagesService, ClientsService],
})
export class PackagesModule {}
