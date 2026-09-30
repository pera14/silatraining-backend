import { Injectable } from '@nestjs/common';
import type {
  ClientPackage,
  EndpointBody,
  EndpointQuery,
  Package,
  PackageType,
} from '@sila/contracts';
import { RULES } from '@sila/contracts';
import { DomainError } from '../../common/errors/domain-error';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { PackageUsageService } from '../../common/package-usage/package-usage.service';
import { type PrismaTx, PrismaService } from '../../common/prisma/prisma.service';
import {
  addMonthsMinusDay,
  addWeeksMinusDay,
  dateOnlyToIso,
  isoToDateOnly,
  localDay,
} from '../../common/time/time';
import { AppConfig } from '../../config/app-config.service';
import type { Package as PackageRow } from '../../generated/prisma/client';
import { Clock } from '../sessions/clock';
import { AutoBookService } from '../slots/auto-book.service';
import { toPackage, toPackageType } from './package-mappers';

@Injectable()
export class PackagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly usage: PackageUsageService,
    private readonly autoBook: AutoBookService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ packages (trainer)

  /** Package history of one client, newest first (archived clients included). */
  async listForClient(trainerId: string, clientId: string): Promise<Package[]> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const rows = await this.prisma.package.findMany({
      where: { clientId, trainerId },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return this.present(rows);
  }

  /**
   * Adds a package. From a type, name/practices/validity/price are copied unless overridden;
   * `validUntil = validFrom + validityMonths − 1 day`. A reserved autoBook series of this client is booked
   * right away if the new package covers its dates.
   */
  async create(
    trainerId: string,
    clientId: string,
    body: EndpointBody<'trainer.packages.create'>,
  ): Promise<Package> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId);
    const type = body.packageTypeId
      ? await this.prisma.packageType.findFirst({
          where: { id: body.packageTypeId, trainerId, archivedAt: null },
        })
      : null;
    if (body.packageTypeId && !type) throw new DomainError('NOT_FOUND', 'Package type not found');

    const name = body.name ?? type?.name;
    const totalPractices = body.totalPractices ?? type?.practices;
    // Guaranteed by the contract refinement; re-checked so the types are honest.
    if (!name || !totalPractices) throw new DomainError('VALIDATION_FAILED');
    const paid = body.paymentStatus === 'PAID';

    const created = await this.prisma.package.create({
      data: {
        clientId,
        trainerId,
        packageTypeId: type?.id ?? null,
        name,
        totalPractices,
        validFrom: isoToDateOnly(body.validFrom),
        validUntil: isoToDateOnly(addMonthsMinusDay(body.validFrom, type?.validityMonths ?? 1)),
        priceRsd: body.priceRsd !== undefined ? body.priceRsd : (type?.priceRsd ?? null),
        paymentStatus: body.paymentStatus ?? 'UNPAID',
        paymentMethod: paid ? (body.paymentMethod ?? null) : null,
        paidAt: paid ? (body.paidAt ? new Date(body.paidAt) : this.clock.now()) : null,
      },
    });
    await this.autoBook.run({ clientId });
    return this.getPackage(created.id);
  }

  /** Payment fields. "Mark paid" is `{paymentStatus: 'PAID', paymentMethod}`; paidAt defaults to now. */
  async update(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.packages.update'>,
  ): Promise<Package> {
    const current = await this.ownedPackage(trainerId, id);
    const status = body.paymentStatus ?? current.paymentStatus;
    const paidAt =
      status === 'UNPAID'
        ? null
        : body.paidAt !== undefined && body.paidAt !== null
          ? new Date(body.paidAt)
          : (current.paidAt ?? this.clock.now());
    await this.prisma.package.update({
      where: { id },
      data: {
        paymentStatus: status,
        paymentMethod: status === 'UNPAID' ? null : body.paymentMethod,
        paidAt,
        paymentNote: body.paymentNote,
        priceRsd: body.priceRsd,
      },
    });
    return this.getPackage(id);
  }

  /** Approves an extension up to validFrom + 5 weeks − 1 day (422 EXTENSION_LIMIT beyond). */
  async extend(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.packages.extend'>,
  ): Promise<Package> {
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.lockPackage(tx, trainerId, id);
      const max = addWeeksMinusDay(dateOnlyToIso(pkg.validFrom), RULES.maxExtensionWeeks);
      if (body.extendedUntil > max) {
        throw new DomainError('EXTENSION_LIMIT', undefined, { maxExtendedUntil: max });
      }
      if (body.extendedUntil < dateOnlyToIso(pkg.validUntil)) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'An extension cannot end before the package does.',
        );
      }
      await tx.package.update({
        where: { id },
        data: {
          extendedUntil: isoToDateOnly(body.extendedUntil),
          extensionNote: body.note,
          extensionApprovedAt: this.clock.now(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: trainerId,
          action: 'package.extend',
          entity: 'Package',
          entityId: id,
          meta: { extendedUntil: body.extendedUntil, note: body.note },
        },
      });
    });
    await this.autoBook.run({ clientId: (await this.ownedPackage(trainerId, id)).clientId });
    return this.getPackage(id);
  }

  /** Manual ±N practices with a required note, audit-logged. Practices left can never go below zero. */
  async adjust(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.packages.adjust'>,
  ): Promise<Package> {
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.lockPackage(tx, trainerId, id);
      const usage = (await this.usage.getUsage([id], tx)).get(id)!;
      if (usage.left + body.delta < 0) {
        throw new DomainError(
          'VALIDATION_FAILED',
          `Only ${usage.left} practice(s) left; cannot remove ${-body.delta}.`,
        );
      }
      const adjustment = pkg.adjustment + body.delta;
      await tx.package.update({ where: { id }, data: { adjustment } });
      await tx.auditLog.create({
        data: {
          actorId: trainerId,
          action: 'package.adjust',
          entity: 'Package',
          entityId: id,
          meta: { delta: body.delta, note: body.note, adjustment },
        },
      });
    });
    return this.getPackage(id);
  }

  // ------------------------------------------------------------------ packages (client)

  async clientPackages(clientId: string): Promise<ClientPackage[]> {
    const rows = await this.prisma.package.findMany({
      where: { clientId },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return (await this.present(rows)).map(({ paymentNote: _omit, ...rest }) => rest);
  }

  // ------------------------------------------------------------------ package types

  async listTypes(
    trainerId: string,
    query: EndpointQuery<'trainer.packageTypes.list'>,
  ): Promise<PackageType[]> {
    const rows = await this.prisma.packageType.findMany({
      where: { trainerId, ...(query.includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
    return rows.map(toPackageType);
  }

  async createType(
    trainerId: string,
    body: EndpointBody<'trainer.packageTypes.create'>,
  ): Promise<PackageType> {
    const row = await this.prisma.packageType.create({
      data: {
        trainerId,
        name: body.name,
        practices: body.practices,
        validityMonths: body.validityMonths ?? 1,
        priceRsd: body.priceRsd ?? null,
      },
    });
    return toPackageType(row);
  }

  async getType(trainerId: string, id: string): Promise<PackageType> {
    return toPackageType(await this.ownedType(trainerId, id));
  }

  async updateType(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.packageTypes.update'>,
  ): Promise<PackageType> {
    const current = await this.ownedType(trainerId, id);
    const row = await this.prisma.packageType.update({
      where: { id },
      data: {
        name: body.name,
        practices: body.practices,
        validityMonths: body.validityMonths,
        priceRsd: body.priceRsd,
        archivedAt:
          body.archived === undefined
            ? undefined
            : body.archived
              ? (current.archivedAt ?? this.clock.now())
              : null,
      },
    });
    return toPackageType(row);
  }

  /** Types are archived, never deleted: existing packages keep their reference. */
  async archiveType(trainerId: string, id: string): Promise<void> {
    const current = await this.ownedType(trainerId, id);
    if (!current.archivedAt) {
      await this.prisma.packageType.update({
        where: { id },
        data: { archivedAt: this.clock.now() },
      });
    }
  }

  // ------------------------------------------------------------------ helpers

  async present(rows: PackageRow[]): Promise<Package[]> {
    const usage = await this.usage.getUsage(rows.map((r) => r.id));
    const today = localDay(this.clock.now(), this.config.timezone);
    return rows.map((r) => toPackage(r, usage.get(r.id)!, today));
  }

  private async getPackage(id: string): Promise<Package> {
    const row = await this.prisma.package.findUniqueOrThrow({ where: { id } });
    return (await this.present([row]))[0]!;
  }

  private async ownedPackage(trainerId: string, id: string): Promise<PackageRow> {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    this.ownership.assertOwnedByTrainer(trainerId, pkg, 'Package');
    return pkg;
  }

  private async lockPackage(tx: PrismaTx, trainerId: string, id: string): Promise<PackageRow> {
    await tx.$queryRaw`SELECT id FROM "Package" WHERE id = ${id} FOR UPDATE`;
    const pkg = await tx.package.findUnique({ where: { id } });
    this.ownership.assertOwnedByTrainer(trainerId, pkg, 'Package');
    return pkg;
  }

  private async ownedType(trainerId: string, id: string) {
    const type = await this.prisma.packageType.findUnique({ where: { id } });
    this.ownership.assertOwnedByTrainer(trainerId, type, 'Package type');
    return type;
  }
}
