import { z } from 'zod';

/**
 * Every error the API can return. The wire shape is always `{ code, message, details? }`.
 * SPEC §5 codes first; the rest are generic codes shared by all endpoints.
 */
export const ERROR_STATUS = {
  // SPEC §5
  NO_PACKAGE: 402,
  SLOT_TAKEN: 409,
  ALREADY_LINKED: 409,
  BOOKING_CUTOFF: 422,
  CANCEL_CUTOFF: 403,
  LINK_REVOKED: 410,
  SLOT_BOOKED: 422,
  // domain additions (logged in docs/CONTRACT_CHANGES.md)
  SLOT_OVERLAP: 409,
  EMAIL_TAKEN: 409,
  EXTENSION_LIMIT: 422,
  INVALID_STATE: 409,
  UPLOAD_INVALID: 422,
  // generic
  VALIDATION_FAILED: 400,
  RESET_TOKEN_INVALID: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

/** Default human messages (English). UIs may override per screen with friendlier copy. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  NO_PACKAGE: 'You have no active package covering this date. Contact your trainer.',
  SLOT_TAKEN: 'Someone just booked this slot. Please pick another one.',
  ALREADY_LINKED: 'This account is already linked to a trainer.',
  BOOKING_CUTOFF: 'Practices must be booked at least 6 hours in advance.',
  CANCEL_CUTOFF: 'Less than 6 hours left — contact your trainer.',
  LINK_REVOKED: 'This invite link is no longer valid.',
  SLOT_BOOKED: 'This slot has a booked practice. Cancel or move it first.',
  SLOT_OVERLAP: 'This slot overlaps an existing slot.',
  EMAIL_TAKEN: 'An account with this email already exists. Sign in instead.',
  EXTENSION_LIMIT: 'A package can be extended to at most 5 weeks from its start.',
  INVALID_STATE: 'This practice can no longer be changed.',
  UPLOAD_INVALID:
    'The upload is missing or does not match the selected file. Please upload it again.',
  VALIDATION_FAILED: 'Some fields are invalid.',
  RESET_TOKEN_INVALID: 'This reset link is invalid or has expired.',
  UNAUTHORIZED: 'Please sign in.',
  INVALID_CREDENTIALS: 'Wrong email or password.',
  TOKEN_INVALID: 'Your session has expired. Please sign in again.',
  FORBIDDEN: 'You do not have access to this.',
  NOT_FOUND: 'Not found.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL: 'Something went wrong. Please try again.',
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_STATUS;
}
