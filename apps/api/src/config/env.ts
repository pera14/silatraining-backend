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

  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_SECURE: bool.default(false),
  MAIL_FROM: z.string().min(3),
});
export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return result.data;
}
