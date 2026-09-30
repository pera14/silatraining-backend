import { buildPath, type EndpointKey, endpoints } from '@sila/contracts';
import { randomUUID } from 'node:crypto';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { type Api, clientOf, trainer } from './scheduling/fixtures';

/** Every authenticated endpoint Agent B serves (feat/content), from the contract registry so none is missed. */
const AGENT_B = /^trainer\.(notes|exercises|plans|clientPlans|documents|calendarFeed)\..+$/;
const KEYS = (Object.keys(endpoints) as EndpointKey[]).filter((k) => AGENT_B.test(k));

function call(
  api: Pick<Api, 'get' | 'post' | 'patch' | 'put' | 'delete'> | null,
  ctx: SchedulingContext,
  key: EndpointKey,
  id: string,
) {
  const def = endpoints[key];
  const path = buildPath(def.path, { id });
  const method = def.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
  const req = api ? api[method](path) : ctx.http()[method](`/api${path}`);
  return def.method === 'GET' ? req : req.send({});
}

describe('content access control (e2e)', () => {
  let ctx: SchedulingContext;

  beforeAll(async () => {
    ctx = await createSchedulingApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
  });

  it('covers all 24 Agent B endpoints, all trainer-only', () => {
    expect(KEYS).toHaveLength(24);
    expect(KEYS.every((k) => endpoints[k].access === 'TRAINER')).toBe(true);
  });

  it.each(KEYS)('%s: 401 without a token, 403 for a client, allowed for a trainer', async (key) => {
    const t = await trainer(ctx);
    const c = await clientOf(ctx, t.user.id);
    const id = randomUUID();

    const anon = await call(null, ctx, key, id);
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('UNAUTHORIZED');

    const wrong = await call(c.api, ctx, key, id);
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('FORBIDDEN');

    // The guard lets the trainer through; the request may still fail validation (400) or find nothing (404).
    const right = await call(t.api, ctx, key, id);
    expect([401, 403]).not.toContain(right.status);
    expect(right.status).toBeLessThan(500);
  });

  it('calendarFeed.ics is public (no token needed) and never 401/403', async () => {
    expect(endpoints['calendarFeed.ics'].access).toBe('public');
    const res = await ctx.http().get(`/api/calendar/${'x'.repeat(43)}.ics`);
    expect(res.status).toBe(404);
  });

  it('a trainer passing their own client id to another trainer’s client-scoped routes is 404', async () => {
    const a = await trainer(ctx, 'A');
    const b = await trainer(ctx, 'B');
    const ca = await clientOf(ctx, a.user.id);
    const clientScoped: EndpointKey[] = [
      'trainer.notes.list',
      'trainer.clientPlans.list',
      'trainer.documents.list',
    ];
    for (const key of clientScoped) {
      const res = await b.api.get(buildPath(endpoints[key].path, { id: ca.user.id }));
      expect([key, res.status]).toEqual([key, 404]);
    }
    // a client id that is not a client at all (the trainer's own user id)
    const self = await a.api.get(`/trainer/clients/${a.user.id}/notes`);
    expect(self.status).toBe(404);
  });
});
