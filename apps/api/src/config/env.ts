import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Validated at boot: the API refuses to start with a missing or malformed variable. */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.url(),
  API_URL: z.url(),
  APP_TIMEZONE: z.string().default('Europe/Belgrade'),
  BOOKING_CUTOFF_HOURS: z.coerce.number().int().nonnegative().default(6),
  CANCEL_CUTOFF_HOURS: z.coerce.number().int().nonnegative().default(6),
  SLOT_HORIZON_WEEKS: z.coerce.number().int().positive().default(8),

  DATABASE_URL: z.string().startsWith('postgres'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JOIN_TOKEN_SECRET: z.string().min(32),
  SESSION_HINT_SECRET: z.string().min(32),
  /** Requests per minute per IP on login / register / accept / forgot. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(5),

  /** Where the API reaches the S3 API (prod: `http://minio:9000` on the internal Docker network). */
  S3_ENDPOINT: z.url(),
  /**
   * Origin embedded in presigned URLs, i.e. the address browsers use (prod: `https://files.<domain>` via Caddy).
   * SigV4 signs the Host header, so the proxy in front of MinIO must forward this host unchanged.
   * Empty/unset = S3_ENDPOINT (dev: the API and the browser both use http://localhost:9000).
   */
  S3_PUBLIC_ENDPOINT: emptyAsUndefined(z.url().optional()),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),

  /** Empty = no SMTP: emails are printed to the API console (MAIL_TRANSPORT=log). */
  SMTP_HOST: emptyAsUndefined(z.string().min(1).optional()),
  SMTP_PORT: emptyAsUndefined(z.coerce.number().int().positive().optional()),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_SECURE: bool.default(false),
  MAIL_FROM: z.string().min(3),
  /** `smtp` sends through SMTP_HOST; `log` prints emails to the console (local dev). Default: log without SMTP_HOST. */
  MAIL_TRANSPORT: z.enum(['smtp', 'log']).optional(),
});
export type Env = Omit<z.infer<typeof EnvSchema>, 'MAIL_TRANSPORT'> & {
  MAIL_TRANSPORT: 'smtp' | 'log';
};

function emptyAsUndefined<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema);
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  const env = result.data;
  const transport = env.MAIL_TRANSPORT ?? (env.SMTP_HOST ? 'smtp' : 'log');
  if (transport === 'smtp' && (!env.SMTP_HOST || !env.SMTP_PORT)) {
    throw new Error(
      'Invalid environment configuration:\n  - MAIL_TRANSPORT=smtp needs SMTP_HOST and SMTP_PORT',
    );
  }
  if (transport === 'log' && env.NODE_ENV === 'production') {
    throw new Error(
      'Invalid environment configuration:\n  - production needs real email: set SMTP_HOST/SMTP_PORT (MAIL_TRANSPORT=log is dev-only)',
    );
  }
  return { ...env, MAIL_TRANSPORT: transport };
}
