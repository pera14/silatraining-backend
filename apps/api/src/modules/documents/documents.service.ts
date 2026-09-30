import { Injectable, Logger } from '@nestjs/common';
import type {
  CreateDocumentResponse,
  Document,
  DocumentDownloadResponse,
  EndpointBody,
} from '@sila/contracts';
import { DOCUMENT_MAX_BYTES } from '@sila/contracts';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../common/errors/domain-error';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type { Document as DocumentRow } from '../../generated/prisma/client';

/** Actor recorded in the AuditLog for automated actions (AuditLog has no FK on actorId). */
export const SYSTEM_ACTOR = 'system';

/**
 * Trainer-only private client documents (SPEC §4 "Documents", §7). The browser uploads straight to storage with a
 * presigned PUT and then confirms; downloads are presigned GETs valid 60 s. Every download and delete is written
 * to the AuditLog (with ids only: file names may themselves be health data and the log outlives the client).
 *
 * Ownership: a document is reachable only through its client, and the client must be (or have been, when
 * archived) the caller's; anything else is 404.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly storage: StorageService,
  ) {}

  /** Confirmed, non-deleted documents, newest first. */
  async list(trainerId: string, clientId: string): Promise<Document[]> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const rows = await this.prisma.document.findMany({
      where: { clientId, confirmedAt: { not: null }, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toDocument);
  }

  /**
   * Starts an upload: a pending row plus a presigned PUT (5 min) bound to the declared type and exact size.
   * The object key is built from UUIDs only, never from the file name.
   */
  async create(
    trainerId: string,
    clientId: string,
    body: EndpointBody<'trainer.documents.create'>,
  ): Promise<CreateDocumentResponse> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const id = randomUUID();
    const s3Key = objectKey(clientId, id);
    const upload = await this.storage.presignPut({
      key: s3Key,
      contentType: body.mimeType,
      contentLength: body.sizeBytes,
    });
    await this.prisma.document.create({
      data: {
        id,
        clientId,
        uploadedById: trainerId,
        s3Key,
        fileName: sanitizeFileName(body.fileName),
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
      },
    });
    return { documentId: id, uploadUrl: upload.url, expiresAt: upload.expiresAt.toISOString() };
  }

  /**
   * Marks the upload done after checking the stored object really matches what was declared (the signed URL
   * already enforces this; the HEAD is defence in depth). Idempotent. A mismatching object is removed.
   */
  async confirm(trainerId: string, documentId: string): Promise<Document> {
    const doc = await this.findOwned(trainerId, documentId);
    if (doc.confirmedAt) return toDocument(doc);

    const info = await this.storage.head(doc.s3Key);
    if (!info) throw new DomainError('UPLOAD_INVALID', 'The file has not been uploaded yet.');
    if (
      info.sizeBytes !== doc.sizeBytes ||
      info.sizeBytes > DOCUMENT_MAX_BYTES ||
      baseType(info.contentType) !== doc.mimeType
    ) {
      await this.storage.delete(doc.s3Key);
      throw new DomainError('UPLOAD_INVALID', undefined, {
        expected: { sizeBytes: doc.sizeBytes, mimeType: doc.mimeType },
        actual: info,
      });
    }

    await this.prisma.document.updateMany({
      where: { id: doc.id, confirmedAt: null },
      data: { confirmedAt: new Date() },
    });
    return toDocument(await this.prisma.document.findUniqueOrThrow({ where: { id: doc.id } }));
  }

  /** Presigned GET (60 s). The audit entry is written first: no log, no link. */
  async download(trainerId: string, documentId: string): Promise<DocumentDownloadResponse> {
    const doc = await this.findOwned(trainerId, documentId);
    if (!doc.confirmedAt) throw new DomainError('NOT_FOUND', 'Document not found');
    await this.audit(trainerId, 'document.download', doc);
    const link = await this.storage.presignGet({
      key: doc.s3Key,
      fileName: doc.fileName,
      contentType: doc.mimeType,
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  /** Soft delete; the nightly purge removes the object (and the row) 30 days later. */
  async softDelete(trainerId: string, documentId: string): Promise<void> {
    const doc = await this.findOwned(trainerId, documentId);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.document.updateMany({
        where: { id: doc.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      // A concurrent delete won: nothing to log twice.
      if (count === 0) throw new DomainError('NOT_FOUND', 'Document not found');
      await tx.auditLog.create({ data: auditData(trainerId, 'document.delete', doc) });
    });
  }

  // ------------------------------------------------------------------ purge (cron)

  /**
   * Removes objects soft-deleted more than `retentionDays` ago, and abandoned uploads (never confirmed) older than
   * `pendingHours`. The row goes only after its object is gone, so a storage outage just retries next night.
   */
  async purge(
    now: Date,
    opts: { retentionDays?: number; pendingHours?: number; batch?: number } = {},
  ): Promise<{ deleted: number; abandoned: number; failed: number }> {
    const deletedBefore = new Date(now.getTime() - (opts.retentionDays ?? 30) * 86_400_000);
    const pendingBefore = new Date(now.getTime() - (opts.pendingHours ?? 24) * 3_600_000);
    const rows = await this.prisma.document.findMany({
      where: {
        OR: [
          { deletedAt: { lte: deletedBefore } },
          { confirmedAt: null, deletedAt: null, createdAt: { lte: pendingBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: opts.batch ?? 500,
    });

    const result = { deleted: 0, abandoned: 0, failed: 0 };
    for (const doc of rows) {
      try {
        await this.storage.delete(doc.s3Key);
        await this.prisma.$transaction([
          this.prisma.document.deleteMany({ where: { id: doc.id } }),
          this.prisma.auditLog.create({ data: auditData(SYSTEM_ACTOR, 'document.purge', doc) }),
        ]);
        if (doc.deletedAt) result.deleted++;
        else result.abandoned++;
      } catch (err) {
        result.failed++;
        this.logger.error(`Purging document ${doc.id} failed: ${String(err)}`);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------ internals

  /** Live (not soft-deleted) document whose client belongs to the trainer; otherwise 404. */
  private async findOwned(trainerId: string, documentId: string): Promise<DocumentRow> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.deletedAt) throw new DomainError('NOT_FOUND', 'Document not found');
    await this.ownership.assertTrainerOwnsClient(trainerId, doc.clientId, {
      includeArchived: true,
    });
    return doc;
  }

  private async audit(actorId: string, action: string, doc: DocumentRow): Promise<void> {
    await this.prisma.auditLog.create({ data: auditData(actorId, action, doc) });
  }
}

function auditData(actorId: string, action: string, doc: DocumentRow) {
  return {
    actorId,
    action,
    entity: 'Document',
    entityId: doc.id,
    meta: { clientId: doc.clientId },
  };
}

/** `documents/<clientId>/<documentId>`: UUIDs only (SPEC §7). */
export function objectKey(clientId: string, documentId: string): string {
  return `documents/${clientId}/${documentId}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Keeps a display name only: no directories, control characters or leading dots. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(CONTROL_CHARS, '').replace(/^\.+/, '').trim();
  return (clean || 'document').slice(0, 200);
}

/** `image/png; charset=binary` → `image/png`. */
function baseType(contentType: string | null): string | null {
  return contentType?.split(';')[0]?.trim().toLowerCase() ?? null;
}

export function toDocument(d: DocumentRow): Document {
  return {
    id: d.id,
    clientId: d.clientId,
    fileName: d.fileName,
    mimeType: d.mimeType as Document['mimeType'],
    sizeBytes: d.sizeBytes,
    confirmedAt: d.confirmedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}
