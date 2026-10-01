import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { ClientDataController } from './client-data.controller';
import { ClientDataService } from './client-data.service';

/** SPEC §7 privacy: trainer-only "Export client data" (zip) and "Delete client" (hard delete + object removal). */
@Module({
  imports: [StorageModule],
  controllers: [ClientDataController],
  providers: [ClientDataService],
})
export class ClientDataModule {}
