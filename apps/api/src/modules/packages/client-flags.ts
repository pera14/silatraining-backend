import { type ClientFlag, type PaymentStatus, RULES } from '@sila/contracts';
import { daysBetween } from '../sessions/local-day';

/** What the flag rules need to know about one package. Days are `YYYY-MM-DD`. */
export interface PackageFacts {
  id: string;
  validFrom: string;
  effectiveUntil: string;
  left: number;
  paymentStatus: PaymentStatus;
}

/** `today` falls within validFrom..effectiveUntil and practices are left (SPEC §3). */
export function isActiveOn(p: PackageFacts, day: string): boolean {
  return p.validFrom <= day && day <= p.effectiveUntil && p.left > 0;
}

/** The active package on `day`: earliest ending first (same rule as PackageUsageService.findActivePackage). */
export function pickActivePackage<T extends PackageFacts>(packages: T[], day: string): T | null {
  return (
    packages
      .filter((p) => isActiveOn(p, day))
      .sort(
        (a, b) =>
          a.effectiveUntil.localeCompare(b.effectiveUntil) ||
          a.validFrom.localeCompare(b.validFrom),
      )[0] ?? null
  );
}

/**
 * Client list flags (SPEC §4):
 * - UNPAID: any package still unpaid, expired ones included (money is still owed)
 * - LOW: the active package has ≤ 2 practices left
 * - EXPIRING: the active package ends within ≤ 5 days
 * - NO_PACKAGE: no active package
 */
export function clientFlags(packages: PackageFacts[], today: string): ClientFlag[] {
  const flags: ClientFlag[] = [];
  if (packages.some((p) => p.paymentStatus === 'UNPAID')) flags.push('UNPAID');
  const active = pickActivePackage(packages, today);
  if (!active) {
    flags.push('NO_PACKAGE');
    return flags;
  }
  if (active.left <= RULES.lowPracticesThreshold) flags.push('LOW');
  if (daysBetween(today, active.effectiveUntil) <= RULES.expiringWithinDays) flags.push('EXPIRING');
  return flags;
}
