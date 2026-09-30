import { z } from 'zod';
import { Id, IsoDate, IsoDateTime, PaymentMethod, PaymentStatus } from './common';

/** Derived numbers (SPEC §3): never stored, always computed from sessions. */
export const PackageUsage = z.object({
  /** totalPractices + adjustment */
  available: z.int(),
  used: z.int(),
  left: z.int(),
  /** extendedUntil ?? validUntil */
  effectiveUntil: IsoDate,
});
export type PackageUsage = z.infer<typeof PackageUsage>;

export const Package = z.object({
  id: Id,
  clientId: Id,
  packageTypeId: Id.nullable(),
  name: z.string(),
  totalPractices: z.int().positive(),
  adjustment: z.int(),
  validFrom: IsoDate,
  validUntil: IsoDate,
  extendedUntil: IsoDate.nullable(),
  extensionNote: z.string().nullable(),
  extensionApprovedAt: IsoDateTime.nullable(),
  priceRsd: z.int().nonnegative().nullable(),
  paymentStatus: PaymentStatus,
  paymentMethod: PaymentMethod.nullable(),
  paidAt: IsoDateTime.nullable(),
  paymentNote: z.string().nullable(),
  createdAt: IsoDateTime,
  usage: PackageUsage,
  /** Today falls within validFrom..effectiveUntil and left > 0. */
  isActive: z.boolean(),
});
export type Package = z.infer<typeof Package>;

export const CreatePackageRequest = z
  .object({
    /** Copies name / practices / validity / price from the type unless overridden. */
    packageTypeId: Id.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    totalPractices: z.int().positive().max(200).optional(),
    validFrom: IsoDate,
    priceRsd: z.int().nonnegative().nullable().optional(),
    paymentStatus: PaymentStatus.default('UNPAID'),
    paymentMethod: PaymentMethod.nullable().optional(),
    paidAt: IsoDateTime.nullable().optional(),
  })
  .refine((v) => !!v.packageTypeId || (!!v.name && !!v.totalPractices), {
    message: 'Provide packageTypeId, or name and totalPractices',
  });
export type CreatePackageRequest = z.input<typeof CreatePackageRequest>;

/** Mark paid is one tap: `{ paymentStatus: 'PAID', paymentMethod, paidAt }`. */
export const UpdatePackageRequest = z
  .object({
    paymentStatus: PaymentStatus.optional(),
    paymentMethod: PaymentMethod.nullable().optional(),
    paidAt: IsoDateTime.nullable().optional(),
    paymentNote: z.string().trim().max(500).nullable().optional(),
    priceRsd: z.int().nonnegative().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePackageRequest = z.infer<typeof UpdatePackageRequest>;

export const ExtendPackageRequest = z.object({
  /** At most validFrom + 5 weeks − 1 day, otherwise 422 EXTENSION_LIMIT. */
  extendedUntil: IsoDate,
  note: z.string().trim().min(1, 'A note is required').max(500),
});
export type ExtendPackageRequest = z.infer<typeof ExtendPackageRequest>;

export const AdjustPackageRequest = z.object({
  delta: z
    .int()
    .min(-50)
    .max(50)
    .refine((d) => d !== 0, 'Delta must not be 0'),
  note: z.string().trim().min(1, 'A note is required').max(500),
});
export type AdjustPackageRequest = z.infer<typeof AdjustPackageRequest>;

export const PackageType = z.object({
  id: Id,
  name: z.string(),
  practices: z.int().positive(),
  validityMonths: z.int().positive(),
  priceRsd: z.int().nonnegative().nullable(),
  archivedAt: IsoDateTime.nullable(),
});
export type PackageType = z.infer<typeof PackageType>;

export const CreatePackageTypeRequest = z.object({
  name: z.string().trim().min(1).max(80),
  practices: z.int().positive().max(200),
  validityMonths: z.int().positive().max(12).default(1),
  priceRsd: z.int().nonnegative().nullable().optional(),
});
export type CreatePackageTypeRequest = z.input<typeof CreatePackageTypeRequest>;

export const UpdatePackageTypeRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    practices: z.int().positive().max(200).optional(),
    validityMonths: z.int().positive().max(12).optional(),
    priceRsd: z.int().nonnegative().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePackageTypeRequest = z.infer<typeof UpdatePackageTypeRequest>;

export const PackageTypesQuery = z.object({ includeArchived: z.stringbool().optional() });
