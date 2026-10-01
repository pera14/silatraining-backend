import type { PrismaTx } from '../../common/prisma/prisma.service';

/**
 * Serializes slot writes of one trainer until the transaction ends. The `slot_no_overlap` exclusion only covers
 * non-parallel slots, so every path that inserts slots takes this lock before its overlap / parallel-cap check;
 * otherwise two concurrent inserts could both pass the check.
 */
export async function lockTrainerSlots(tx: PrismaTx, trainerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`slots:${trainerId}`}, 0))`;
}
