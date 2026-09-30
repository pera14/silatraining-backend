/**
 * Helpers to recognise database constraint violations, whichever layer surfaces them
 * (Prisma known-request errors or driver-adapter errors carrying the Postgres SQLSTATE).
 *
 *   23505 unique_violation     e.g. session_one_per_slot  -> 409 SLOT_TAKEN
 *   23P01 exclusion_violation  e.g. slot_no_overlap       -> 409 SLOT_OVERLAP
 *   23514 check_violation      e.g. slot_start / slot_len -> 400 VALIDATION_FAILED
 */
export type PgConstraintKind = 'unique' | 'exclusion' | 'check' | 'foreignKey';

const SQLSTATE: Record<PgConstraintKind, string> = {
  unique: '23505',
  exclusion: '23P01',
  check: '23514',
  foreignKey: '23503',
};

function collectText(err: unknown, depth = 0): string {
  if (!err || typeof err !== 'object' || depth > 4) return '';
  const e = err as Record<string, unknown>;
  const parts = [e.code, e.message, e.originalCode, e.originalMessage, e.constraint, e.kind]
    .filter((v) => typeof v === 'string')
    .join(' ');
  return `${parts} ${collectText(e.cause, depth + 1)} ${collectText(e.meta, depth + 1)}`;
}

/** True when `err` is a violation of the given kind (optionally of a specific named constraint/index). */
export function isConstraintViolation(
  err: unknown,
  kind: PgConstraintKind,
  constraint?: string,
): boolean {
  const text = collectText(err);
  const prismaUnique = kind === 'unique' && /\bP2002\b|UniqueConstraintViolation/.test(text);
  const prismaFk = kind === 'foreignKey' && /\bP2003\b|ForeignKeyConstraintViolation/.test(text);
  const matchesKind =
    text.includes(SQLSTATE[kind]) ||
    prismaUnique ||
    prismaFk ||
    (kind === 'exclusion' && /exclusion constraint/i.test(text)) ||
    (kind === 'check' && /check constraint/i.test(text));
  return matchesKind && (!constraint || text.includes(constraint));
}

export function isRecordNotFound(err: unknown): boolean {
  return /\bP2025\b/.test(collectText(err));
}
