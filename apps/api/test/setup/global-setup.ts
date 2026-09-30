import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { TEST_ENV } from './test-env';

declare global {
  var __SILA_PG__: StartedPostgreSqlContainer | undefined;
}

/** One Postgres 16 container per e2e run, migrated with the real migrations (incl. raw SQL). */
export default async function globalSetup(): Promise<void> {
  Object.assign(process.env, TEST_ENV);
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sila_test')
    .withUsername('sila')
    .withPassword('sila')
    .start();
  globalThis.__SILA_PG__ = container;
  process.env.DATABASE_URL = container.getConnectionUri();

  execSync('pnpm exec prisma migrate deploy', {
    cwd: join(__dirname, '..', '..'),
    env: process.env,
    stdio: 'pipe',
  });
}
