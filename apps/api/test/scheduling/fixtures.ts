import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { isoToDateOnly } from '../../src/common/time/time';
import { localSlotStart } from '../../src/modules/slots/slot-time';
import { createUser, login } from '../setup/app';
import type { SchedulingContext } from './app';

export const ZONE = 'Europe/Belgrade';

/** Instant of a Belgrade local time, e.g. `local('2026-10-06', '18:00')`. */
export function local(day: string, time: string): Date {
  const d = localSlotStart(day, time, ZONE);
  if (!d) throw new Error(`${day} ${time} does not exist in ${ZONE}`);
  return d;
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

/** A signed-in user's HTTP client: `api.post('/trainer/slots').send(...)`. Paths are under `/api`. */
export interface Api {
  userId: string;
  token: string;
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  patch: (path: string) => request.Test;
  put: (path: string) => request.Test;
  delete: (path: string) => request.Test;
}

export async function signIn(
  ctx: SchedulingContext,
  user: { id: string; email: string },
): Promise<Api> {
  const { accessToken } = await login(ctx, user.email);
  const call = (method: Method) => (path: string) =>
    ctx.http()[method](`/api${path}`).set('Authorization', `Bearer ${accessToken}`);
  return {
    userId: user.id,
    token: accessToken,
    get: call('get'),
    post: call('post'),
    patch: call('patch'),
    put: call('put'),
    delete: call('delete'),
  };
}

export async function trainer(ctx: SchedulingContext, firstName = 'Marko') {
  const user = await createUser(ctx.prisma, 'TRAINER', { firstName });
  return { user, api: await signIn(ctx, user) };
}

export async function clientOf(
  ctx: SchedulingContext,
  trainerId: string,
  opts: { firstName?: string; lastName?: string; archived?: boolean } = {},
) {
  const user = await createUser(ctx.prisma, 'CLIENT', {
    firstName: opts.firstName ?? 'Ana',
    lastName: opts.lastName ?? `Petrović-${randomUUID().slice(0, 4)}`,
  });
  await ctx.prisma.trainerClient.create({
    data: { trainerId, clientId: user.id, archivedAt: opts.archived ? new Date() : null },
  });
  return { user, api: await signIn(ctx, user) };
}

export async function addPackage(
  ctx: SchedulingContext,
  opts: {
    trainerId: string;
    clientId: string;
    validFrom: string;
    validUntil: string;
    total?: number;
    extendedUntil?: string;
    paid?: boolean;
    name?: string;
  },
) {
  return ctx.prisma.package.create({
    data: {
      trainerId: opts.trainerId,
      clientId: opts.clientId,
      name: opts.name ?? '10 practices / month',
      totalPractices: opts.total ?? 10,
      validFrom: isoToDateOnly(opts.validFrom),
      validUntil: isoToDateOnly(opts.validUntil),
      extendedUntil: opts.extendedUntil ? isoToDateOnly(opts.extendedUntil) : null,
      paymentStatus: opts.paid ? 'PAID' : 'UNPAID',
      paidAt: opts.paid ? new Date() : null,
    },
  });
}

export async function addSlot(
  ctx: SchedulingContext,
  trainerId: string,
  startsAt: Date,
  data: { status?: 'OPEN' | 'LOCKED'; reservedForClientId?: string } = {},
) {
  return ctx.prisma.slot.create({
    data: {
      trainerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      ...data,
    },
  });
}

export async function addPlan(
  ctx: SchedulingContext,
  trainerId: string,
  clientId: string,
  name: string,
  sortOrder: number,
) {
  return ctx.prisma.plan.create({ data: { trainerId, clientId, name, sortOrder } });
}

/** Everything most booking tests need: a trainer, a client with a paid October package, API clients. */
export async function world(ctx: SchedulingContext) {
  const t = await trainer(ctx);
  const c = await clientOf(ctx, t.user.id);
  const pkg = await addPackage(ctx, {
    trainerId: t.user.id,
    clientId: c.user.id,
    validFrom: '2026-10-01',
    validUntil: '2026-10-31',
    paid: true,
  });
  return { trainer: t, client: c, pkg };
}

export async function left(ctx: SchedulingContext, packageId: string): Promise<number> {
  const rows = await ctx.prisma.$queryRaw<Array<{ left: number }>>`
    SELECT "left" FROM package_usage WHERE "packageId" = ${packageId}`;
  return rows[0]!.left;
}
