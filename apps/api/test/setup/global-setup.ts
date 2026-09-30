import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { parse } from 'dotenv';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { startObjectStorage } from './minio';
import { TEST_ENV } from './test-env';

declare global {
  var __SILA_PG__: StartedPostgreSqlContainer | undefined;
}

const apiRoot = join(__dirname, '..', '..');

/** TEST_DATABASE_URL from the environment or the backend .env (only that key is read). */
function testDatabaseUrl(): string | undefined {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const envFile = join(apiRoot, '..', '..', '.env');
  return existsSync(envFile)
    ? parse(readFileSync(envFile)).TEST_DATABASE_URL || undefined
    : undefined;
}

/** Drops and recreates the public schema so every run starts from the real migrations. */
async function resetLocalDatabase(url: string): Promise<void> {
  const dbName = new URL(url).pathname.slice(1);
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to reset "${dbName}": TEST_DATABASE_URL must point at a database whose name contains "test".`,
    );
  }
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach TEST_DATABASE_URL (${(err as Error).message}). Start Postgres and run \`pnpm db:setup\`, ` +
        'or unset TEST_DATABASE_URL to use Testcontainers (Docker).',
    );
  }
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}

/**
 * Local (no Docker): TEST_DATABASE_URL, e.g. postgresql://sila:sila@localhost:5432/sila_test (`pnpm db:setup`).
 * CI / no TEST_DATABASE_URL: one Postgres 16 container per run (Testcontainers).
 * Either way the schema is built with the real migrations, including the raw SQL constraints.
 * Plus a real MinIO for documents (Testcontainers, or TEST_S3_ENDPOINT).
 */
export default async function globalSetup(): Promise<void> {
  Object.assign(process.env, TEST_ENV);
  // Object storage (documents suite) starts alongside the database; see ./minio.ts.
  const storage = startObjectStorage(TEST_ENV.S3_BUCKET!);
  storage.catch(() => undefined); // surfaced by the await below, not as an unhandled rejection
  const localUrl = testDatabaseUrl();
  if (localUrl) {
    await resetLocalDatabase(localUrl);
    process.env.DATABASE_URL = localUrl;
  } else {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('sila_test')
      .withUsername('sila')
      .withPassword('sila')
      .start();
    globalThis.__SILA_PG__ = container;
    process.env.DATABASE_URL = container.getConnectionUri();
  }

  Object.assign(process.env, await storage);

  execSync('pnpm exec prisma migrate deploy', { cwd: apiRoot, env: process.env, stdio: 'pipe' });
}
