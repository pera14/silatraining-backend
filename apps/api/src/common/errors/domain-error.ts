import { ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@sila/contracts';

/**
 * Throw this from services for every expected failure. The global filter renders it as
 * `{ code, message, details? }` with the HTTP status defined in `@sila/contracts` (ERROR_STATUS).
 *
 *   throw new DomainError('SLOT_TAKEN');
 *   throw new DomainError('NOT_FOUND', 'Client not found');
 */
export class DomainError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'DomainError';
    this.status = ERROR_STATUS[code];
  }
}
