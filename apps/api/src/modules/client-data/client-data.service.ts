import { Injectable, Logger } from '@nestjs/common';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { DomainError } from '../../common/errors/domain-error';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { PackageUsageService } from '../../common/package-usage/package-usage.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';

/** Bumped when the layout of `data.json` changes, so a reader can tell exports apart. */
export const EXPORT_FORMAT_VERSION = 1;

export interface ClientExport {
  /** `sila-client-<last name>-<YYYY-MM-DD>.zip` */
  fileName: string;
  /** The zip, streamed as it is built (documents are read from storage one by one). */
  stream: NodeJS.ReadableStream;
}

/**
 * SPEC §7 privacy: a trainer can export everything stored about one of their clients, and delete the client for
 * good. Both are trainer-only, ownership-checked (a foreign client is 404) and audit-logged.
 */
@Injectable()
export class ClientDataService {
  private readonly logger = new Logger(ClientDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly usage: PackageUsageService,
    private readonly storage: StorageService,
  ) {}

  /**
   * A zip with `data.json` (profile, packages with usage, practices, notes, plans, document list) and the client's
   * documents under `documents/`. Soft-deleted documents are left out: they are no longer part of the record.
   */
  async export(trainerId: string, clientId: string): Promise<ClientExport> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const [user, link, packages, practices, notes, plans, documents] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: clientId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          photoUrl: true,
          consentAt: true,
          createdAt: true,
        },
      }),
      this.prisma.trainerClient.findUniqueOrThrow({
        where: { clientId },
        select: { joinedAt: true, archivedAt: true },
      }),
      this.prisma.package.findMany({ where: { clientId }, orderBy: { validFrom: 'asc' } }),
      this.prisma.session.findMany({
        where: { clientId },
        orderBy: { startsAt: 'asc' },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          packageId: true,
          plan: { select: { name: true } },
          practiceReturned: true,
          cancelledAt: true,
          attendanceMarkedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.clientNote.findMany({
        where: { clientId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, pinned: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.plan.findMany({
        where: { clientId },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          name: true,
          notes: true,
          sortOrder: true,
          archivedAt: true,
          exercises: {
            orderBy: { sortOrder: 'asc' },
            select: {
              exercise: { select: { name: true } },
              sets: true,
              reps: true,
              weight: true,
              restSec: true,
              notes: true,
            },
          },
        },
      }),
      this.prisma.document.findMany({
        where: { clientId, deletedAt: null, confirmedAt: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          s3Key: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
      }),
    ]);
    const usage = await this.usage.getUsage(packages.map((p) => p.id));

    const files = documents.map((d) => ({ ...d, path: `documents/${d.id}-${d.fileName}` }));
    const data = {
      format: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      client: { ...user, joinedAt: link.joinedAt, archivedAt: link.archivedAt },
      packages: packages.map(({ clientId: _c, trainerId: _t, ...p }) => ({
        ...p,
        usage: usage.get(p.id) ?? null,
      })),
      practices: practices.map(({ plan, ...p }) => ({ ...p, plan: plan?.name ?? null })),
      notes,
      plans: plans.map((p) => ({
        ...p,
        exercises: p.exercises.map(({ exercise, ...e }) => ({ exercise: exercise.name, ...e })),
      })),
      documents: files.map(({ s3Key: _k, ...d }) => d),
    };

    await this.prisma.auditLog.create({
      data: {
        actorId: trainerId,
        action: 'client.export',
        entity: 'User',
        entityId: clientId,
        meta: { documents: documents.length },
      },
    });

    const zip = archiver('zip', { zlib: { level: 6 } });
    const out = new PassThrough();
    zip.on('warning', (err) => this.logger.warn(`export ${clientId}: ${err.message}`));
    zip.on('error', (err) => out.destroy(err));
    zip.pipe(out);
    zip.append(JSON.stringify(data, null, 2), { name: 'data.json' });
    // documents are appended one at a time so only one storage stream is open at once
    void (async () => {
      try {
        for (const f of files) {
          const body = await this.storage.read(f.s3Key);
          if (!body) {
            this.logger.warn(`export ${clientId}: document ${f.id} is missing from storage`);
            continue;
          }
          await new Promise<void>((resolve, reject) => {
            body.once('end', resolve).once('error', reject);
            zip.append(body, { name: f.path, date: f.createdAt });
          });
        }
        await zip.finalize();
      } catch (err) {
        this.logger.error(`export ${clientId} failed: ${(err as Error).message}`);
        zip.abort();
        out.destroy(err as Error);
      }
    })();

    const day = new Date().toISOString().slice(0, 10);
    return { fileName: `sila-client-${slug(user.lastName)}-${day}.zip`, stream: out };
  }

  /**
   * Hard delete (SPEC §7 "Delete client"): removes every stored document object, then the user row; the schema
   * cascades the rest (link, packages, practices, notes, plans, document rows, tokens). Objects go first: if the
   * database step then fails, a retry finds the same rows and finishes the job, instead of leaving files behind with
   * no row pointing at them. The audit entry keeps only ids and counts, no personal data.
   */
  async delete(trainerId: string, clientId: string): Promise<void> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const documents = await this.prisma.document.findMany({
      where: { clientId },
      select: { s3Key: true },
    });
    for (const d of documents) await this.storage.delete(d.s3Key);

    await this.prisma.$transaction(async (tx) => {
      const counts = {
        documents: documents.length,
        practices: await tx.session.count({ where: { clientId } }),
        packages: await tx.package.count({ where: { clientId } }),
      };
      const deleted = await tx.user.deleteMany({ where: { id: clientId, role: 'CLIENT' } });
      if (deleted.count === 0) throw new DomainError('NOT_FOUND', 'Client not found');
      await tx.auditLog.create({
        data: {
          actorId: trainerId,
          action: 'client.delete',
          entity: 'User',
          entityId: clientId,
          meta: counts,
        },
      });
    });
  }
}

/** ASCII-only, file-name-safe version of a name ("Đorđević" → "dordevic"). */
function slug(s: string): string {
  return (
    s
      .replace(/[đĐ]/g, 'd')
      .normalize('NFKD')
      .replace(/[^\w-]+/g, '')
      .toLowerCase()
      .slice(0, 40) || 'client'
  );
}
