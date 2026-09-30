import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RULES } from '@sila/contracts';
import { DocumentsService } from './documents.service';

/** Nightly: storage objects of documents deleted 30+ days ago (and abandoned uploads) are purged. */
@Injectable()
export class DocumentsPurgeCron {
  private readonly logger = new Logger(DocumentsPurgeCron.name);

  constructor(private readonly documents: DocumentsService) {}

  // 03:45 local: after the series materializer (03:30) and clear of the DST-shifted 02:00–03:00 hour.
  @Cron('45 3 * * *', { name: 'documents.purge', timeZone: RULES.timezone })
  async run(now: Date = new Date()): Promise<void> {
    try {
      const r = await this.documents.purge(now);
      if (r.deleted || r.abandoned || r.failed) {
        this.logger.log(
          `Purged ${r.deleted} deleted + ${r.abandoned} abandoned documents (${r.failed} failed)`,
        );
      }
    } catch (err) {
      this.logger.error(`Document purge failed: ${String(err)}`);
    }
  }
}
