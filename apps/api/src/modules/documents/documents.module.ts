import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { DocumentsPurgeCron } from './documents-purge.cron';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

/**
 * Owner: Agent B (feat/content). Registered in AppModule during Phase 0 so nobody edits app.module.ts later.
 * Trainer-only client documents on private object storage, plus the nightly purge.
 */
@Module({
  imports: [StorageModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentsPurgeCron],
  exports: [DocumentsService],
})
export class DocumentsModule {}
