import { Injectable } from '@nestjs/common';
import { DomainError } from '../errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Ownership checks. Guards only check the role; every service must ALSO verify that the entity belongs to
 * the caller (SPEC §5, §7). Foreign entities surface as 404 NOT_FOUND so their existence is not leaked.
 */
@Injectable()
export class OwnershipService {
  constructor(private readonly prisma: PrismaService) {}

  /** Throws NOT_FOUND unless `clientId` is (or was, when includeArchived) a client of `trainerId`. */
  async assertTrainerOwnsClient(
    trainerId: string,
    clientId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<void> {
    const link = await this.prisma.trainerClient.findUnique({ where: { clientId } });
    if (!link || link.trainerId !== trainerId || (link.archivedAt && !opts.includeArchived)) {
      throw new DomainError('NOT_FOUND', 'Client not found');
    }
  }

  /** Throws NOT_FOUND unless the entity's `trainerId` equals the caller. Use with a pre-loaded row. */
  assertOwnedByTrainer<T extends { trainerId: string } | null | undefined>(
    trainerId: string,
    entity: T,
    what = 'Resource',
  ): asserts entity is NonNullable<T> {
    if (!entity || entity.trainerId !== trainerId)
      throw new DomainError('NOT_FOUND', `${what} not found`);
  }

  /** Throws NOT_FOUND unless the entity's `clientId` equals the caller. */
  assertOwnedByClient<T extends { clientId: string } | null | undefined>(
    clientId: string,
    entity: T,
    what = 'Resource',
  ): asserts entity is NonNullable<T> {
    if (!entity || entity.clientId !== clientId)
      throw new DomainError('NOT_FOUND', `${what} not found`);
  }

  /** The trainer a client belongs to, or null if the client has not joined anyone yet. */
  async getTrainerIdForClient(clientId: string): Promise<string | null> {
    const link = await this.prisma.trainerClient.findUnique({ where: { clientId } });
    return link?.trainerId ?? null;
  }
}
