import type { Package, PackageType, PackageUsage } from '@sila/contracts';
import { dateOnlyToIso } from '../../common/time/time';
import type {
  Package as PackageRow,
  PackageType as PackageTypeRow,
} from '../../generated/prisma/client';
import { isActiveOn, type PackageFacts } from './client-flags';

export function toPackageFacts(
  p: Pick<Package, 'id' | 'validFrom' | 'paymentStatus' | 'usage'>,
): PackageFacts {
  return {
    id: p.id,
    validFrom: p.validFrom,
    effectiveUntil: p.usage.effectiveUntil,
    left: p.usage.left,
    paymentStatus: p.paymentStatus,
  };
}

export function toPackage(p: PackageRow, usage: PackageUsage, today: string): Package {
  const validFrom = dateOnlyToIso(p.validFrom);
  return {
    id: p.id,
    clientId: p.clientId,
    packageTypeId: p.packageTypeId,
    name: p.name,
    totalPractices: p.totalPractices,
    adjustment: p.adjustment,
    validFrom,
    validUntil: dateOnlyToIso(p.validUntil),
    extendedUntil: p.extendedUntil ? dateOnlyToIso(p.extendedUntil) : null,
    extensionNote: p.extensionNote,
    extensionApprovedAt: p.extensionApprovedAt?.toISOString() ?? null,
    priceRsd: p.priceRsd,
    paymentStatus: p.paymentStatus,
    paymentMethod: p.paymentMethod,
    paidAt: p.paidAt?.toISOString() ?? null,
    paymentNote: p.paymentNote,
    createdAt: p.createdAt.toISOString(),
    usage,
    isActive: isActiveOn(
      toPackageFacts({ id: p.id, validFrom, paymentStatus: p.paymentStatus, usage }),
      today,
    ),
  };
}

export function toPackageType(t: PackageTypeRow): PackageType {
  return {
    id: t.id,
    name: t.name,
    practices: t.practices,
    validityMonths: t.validityMonths,
    priceRsd: t.priceRsd,
    archivedAt: t.archivedAt?.toISOString() ?? null,
  };
}
