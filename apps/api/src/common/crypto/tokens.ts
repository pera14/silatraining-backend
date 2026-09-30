import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, base64url (43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hex sha256, used for every token stored in the DB (join links, resets, feeds). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hex HMAC-SHA256 keyed hash (refresh tokens: a DB leak alone cannot be replayed). */
export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Deterministic, unguessable token for a DB row: base64url(HMAC-SHA256(secret, `${purpose}:${rowId}`)).
 *
 * Lets us store only sha256(token) (SPEC §4) yet still show the trainer their current link/QR: the raw
 * token is re-derived from the row id. Revoking = marking the row revoked and creating a new row.
 */
export function deriveToken(secret: string, purpose: 'join' | 'calendar', rowId: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${rowId}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
