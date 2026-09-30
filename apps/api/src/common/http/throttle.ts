/**
 * Stricter per-route limit for credential endpoints (login, register, accept, forgot, reset): SPEC §5
 * "5/min/IP". Resolved at request time from AUTH_RATE_LIMIT so the e2e suite can raise it.
 */
export const AUTH_THROTTLE = {
  default: { limit: () => Number(process.env.AUTH_RATE_LIMIT ?? 5), ttl: 60_000 },
};

/** Generous global default for everything else. */
export const DEFAULT_THROTTLE = { name: 'default', limit: 300, ttl: 60_000 };
