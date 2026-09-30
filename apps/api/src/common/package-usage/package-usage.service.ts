import { Injectable } from '@nestjs/common';
import type { PackageUsage } from '@sila/contracts';
import { AppConfig } from '../../config/app-config.service';
import { Prisma } from '../../generated/prisma/client';
import { type PrismaTx, PrismaService } from '../prisma/prisma.service';
import { dateOnlyToIso, localDay } from '../time/time';

interface UsageRow {
  packageId: string;
  available: number;
  used: number;
  left: number;
  effectiveUntil: Date;
  validFrom: Date;
}

/**
 * Reads the `package_usage` SQL view (SPEC §3 derived values). Practices left are NEVER stored; always ask
 * this service. Pass the transaction client when counting inside a booking transaction.
 */
@Injectable()
export class PackageUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async getUsage(
    packageIds: string[],
    tx: PrismaTx = this.prisma,
  ): Promise<Map<string, PackageUsage>> {
    if (packageIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<UsageRow[]>`
      SELECT u."packageId", u.available, u.used, u."left", u."effectiveUntil", p."validFrom"
      FROM package_usage u JOIN "Package" p ON p.id = u."packageId"
      WHERE u."packageId" IN (${Prisma.join(packageIds)})`;
    return new Map(
      rows.map((r) => [
        r.packageId,
        {
          available: r.available,
          used: r.used,
          left: r.left,
          effectiveUntil: dateOnlyToIso(r.effectiveUntil),
        },
      ]),
    );
  }

  /**
   * The active package for a practice on `at` (default now): `validFrom <= day <= effectiveUntil` and
   * `left > 0`, earliest-ending first (SPEC §3). Returns null when none.
   */
  async findActivePackage(
    clientId: string,
    at: Date = new Date(),
    tx: PrismaTx = this.prisma,
  ): Promise<{ packageId: string; usage: PackageUsage } | null> {
    const day = localDay(at, this.config.timezone);
    const rows = await tx.$queryRaw<UsageRow[]>`
      SELECT u."packageId", u.available, u.used, u."left", u."effectiveUntil", p."validFrom"
      FROM package_usage u JOIN "Package" p ON p.id = u."packageId"
      WHERE u."clientId" = ${clientId}
        AND p."validFrom" <= ${day}::date
        AND u."effectiveUntil" >= ${day}::date
        AND u."left" > 0
      ORDER BY u."effectiveUntil" ASC, p."validFrom" ASC
      LIMIT 1`;
    const r = rows[0];
    return r
      ? {
          packageId: r.packageId,
          usage: {
            available: r.available,
            used: r.used,
            left: r.left,
            effectiveUntil: dateOnlyToIso(r.effectiveUntil),
          },
        }
      : null;
  }
}
