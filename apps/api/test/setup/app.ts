import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { hashPassword } from '../../src/common/crypto/password';
import { deriveToken, sha256 } from '../../src/common/crypto/tokens';
import { type MailMessage, MailerService } from '../../src/common/mailer/mailer.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import type { Role } from '../../src/generated/prisma/client';

/** Captures emails instead of sending them. */
export class FakeMailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<boolean> {
    this.sent.push(message);
    return true;
  }
}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  mailer: FakeMailer;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(): Promise<TestContext> {
  const mailer = new FakeMailer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailerService)
    .useValue(mailer)
    .compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), mailer, http: () => request(app.getHttpServer()) };
}

/** Empties every table (keeps migrations) — call in beforeEach for isolation. */
export async function resetDb(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} CASCADE`,
  );
}

export const PASSWORD = 'Correct-horse-9';
let passwordHash: Promise<string> | undefined;

export async function createUser(
  prisma: PrismaService,
  role: Role,
  overrides: Partial<{ email: string; firstName: string; lastName: string }> = {},
) {
  passwordHash ??= hashPassword(PASSWORD);
  return prisma.user.create({
    data: {
      role,
      email: overrides.email ?? `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@sila.test`,
      firstName: overrides.firstName ?? (role === 'TRAINER' ? 'Marko' : 'Ana'),
      lastName: overrides.lastName ?? (role === 'TRAINER' ? 'Ilić' : 'Petrović'),
      passwordHash: await passwordHash,
      consentAt: new Date(),
    },
  });
}

/** Creates a join link row and returns its raw token (same derivation as JoinService). */
export async function createJoinLink(
  prisma: PrismaService,
  trainerId: string,
  opts: { revoked?: boolean } = {},
) {
  const id = randomUUID();
  const token = deriveToken(process.env.JOIN_TOKEN_SECRET!, 'join', id);
  await prisma.joinLink.create({
    data: { id, trainerId, tokenHash: sha256(token), revokedAt: opts.revoked ? new Date() : null },
  });
  return token;
}

export async function login(ctx: TestContext, email: string, password = PASSWORD) {
  const res = await ctx.http().post('/api/auth/login').send({ email, password }).expect(200);
  return { accessToken: res.body.accessToken as string, cookies: setCookies(res) };
}

export function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
}

/** `name=value` pair of a Set-Cookie header, suitable for a Cookie request header. */
export function cookiePair(cookies: string[], name: string): string {
  const c = cookies.find((x) => x.startsWith(`${name}=`));
  if (!c) throw new Error(`cookie ${name} not set`);
  return c.split(';')[0]!;
}
