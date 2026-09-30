import { validateEnv } from './env';

const base = {
  APP_URL: 'http://localhost:3001',
  API_URL: 'http://localhost:3001/api',
  DATABASE_URL: 'postgresql://sila:sila@localhost:5432/sila',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JOIN_TOKEN_SECRET: 'c'.repeat(32),
  SESSION_HINT_SECRET: 'd'.repeat(32),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  MAIL_FROM: 'SILA <no-reply@sila.test>',
};

describe('validateEnv mail transport', () => {
  it('prints emails (log) when SMTP_HOST is empty', () => {
    const env = validateEnv({ ...base, SMTP_HOST: '', SMTP_PORT: '' });
    expect(env.MAIL_TRANSPORT).toBe('log');
    expect(env.SMTP_HOST).toBeUndefined();
  });

  it('uses SMTP when SMTP_HOST is set', () => {
    const env = validateEnv({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587' });
    expect(env).toMatchObject({
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
    });
  });

  it('rejects smtp without a host and log mode in production', () => {
    expect(() => validateEnv({ ...base, MAIL_TRANSPORT: 'smtp' })).toThrow(
      /SMTP_HOST and SMTP_PORT/,
    );
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /production needs real email/,
    );
  });
});
