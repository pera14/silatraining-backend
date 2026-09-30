import type { Role } from '@sila/contracts';

/** What the access token carries; available as `@CurrentUser()` on authenticated routes. */
export interface AuthUser {
  id: string;
  role: Role;
}

export interface AccessTokenPayload {
  sub: string;
  role: Role;
}
