import { config } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// The backend keeps one .env at the repo root; an already-set DATABASE_URL (CI, Testcontainers) wins.
config({ path: ['.env', '../../.env'], quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
