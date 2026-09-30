import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { MailerService } from '../../src/common/mailer/mailer.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { Clock } from '../../src/modules/sessions/clock';
import { FakeMailer, type TestContext } from '../setup/app';

/** A settable clock: every "now" in the scheduling modules comes from here during e2e runs. */
export class FakeClock extends Clock {
  current = new Date('2026-10-05T08:00:00Z'); // Monday 10:00 in Belgrade

  override now(): Date {
    return new Date(this.current);
  }

  set(iso: string | Date): void {
    this.current = new Date(iso);
  }
}

export interface SchedulingContext extends TestContext {
  clock: FakeClock;
}

/** Same as `createTestApp`, plus a FakeClock so cutoffs can be tested to the minute. */
export async function createSchedulingApp(): Promise<SchedulingContext> {
  const mailer = new FakeMailer();
  const clock = new FakeClock();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailerService)
    .useValue(mailer)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    mailer,
    clock,
    http: () => request(app.getHttpServer()),
  };
}
