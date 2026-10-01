/**
 * One-time local database setup WITHOUT Docker (idempotent; safe to re-run).
 *
 *   pnpm db:setup
 *
 * Connects to your local PostgreSQL 16 as a superuser (default: your OS user on localhost:5432, as with
 * Homebrew's `brew services start postgresql@16`; override with PG_ADMIN_URL) and creates:
 *   - role `sila` (password `sila`, CREATEDB)
 *   - databases `sila` (dev), `sila_test` (API e2e) and `sila_e2e` (web real-stack e2e), owned by `sila`
 *   - the `btree_gist` extension in both (needs superuser; the `sila` role cannot create extensions)
 */
import { config } from 'dotenv';
import { Client } from 'pg';

config({ path: ['.env', '../../.env'], quiet: true });

const ADMIN_URL = process.env.PG_ADMIN_URL ?? 'postgresql://localhost:5432/postgres';
const ROLE = 'sila';
const PASSWORD = 'sila';
const DATABASES = ['sila', 'sila_test', 'sila_e2e'];

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function main() {
  try {
    await withClient(ADMIN_URL, async (admin) => {
      const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
      if (role.rowCount === 0) {
        await admin.query(`CREATE ROLE ${ROLE} WITH LOGIN PASSWORD '${PASSWORD}' CREATEDB`);
        console.log(`created role ${ROLE}`);
      } else {
        await admin.query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${PASSWORD}' CREATEDB`);
      }
      for (const db of DATABASES) {
        const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
        if (exists.rowCount === 0) {
          await admin.query(`CREATE DATABASE ${db} OWNER ${ROLE}`);
          console.log(`created database ${db}`);
        }
      }
    });
    for (const db of DATABASES) {
      const url = new URL(ADMIN_URL);
      url.pathname = `/${db}`;
      await withClient(url.toString(), async (c) => {
        await c.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
        // the app role owns the public schema so migrations (and e2e schema resets) work
        await c.query(`ALTER SCHEMA public OWNER TO ${ROLE}`);
      });
    }
    console.log(
      `✔ local Postgres ready: ${DATABASES.map((d) => `postgresql://${ROLE}:${PASSWORD}@localhost:5432/${d}`).join('  ')}`,
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ECONNREFUSED') {
      console.error(
        '✖ PostgreSQL is not reachable on localhost:5432. Start it with: brew services start postgresql@16',
      );
    } else {
      console.error(`✖ database setup failed: ${e.message}`);
      console.error(
        '  Set PG_ADMIN_URL to a superuser connection string if your local superuser is not your OS user.',
      );
    }
    process.exitCode = 1;
  }
}

void main();
