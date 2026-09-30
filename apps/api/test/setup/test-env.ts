/** Deterministic env for e2e runs (CI has no .env). DATABASE_URL is set by global-setup. */
export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3999', // never bound: supertest drives the in-process server
  APP_URL: 'http://localhost:3001',
  API_URL: 'http://localhost:3001/api',
  APP_TIMEZONE: 'Europe/Belgrade',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef012345678',
  JOIN_TOKEN_SECRET: 'test-join-token-secret-0123456789abcdef01234',
  SESSION_HINT_SECRET: 'test-session-hint-secret-0123456789abcdef0123',
  // high by default so suites can log in freely; throttle.e2e-spec lowers it
  AUTH_RATE_LIMIT: '1000',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'sila-documents-test',
  S3_ACCESS_KEY: 'test',
  S3_SECRET_KEY: 'test-secret',
  S3_REGION: 'us-east-1',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'SILA Training <no-reply@sila.test>',
};
