import { buildPath, type EndpointKey, endpoints } from '@sila/contracts';
import { randomUUID } from 'node:crypto';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { addPackage, addSlot, type Api, clientOf, local, trainer } from './scheduling/fixtures';

/** Every endpoint Agent A serves (feat/scheduling), taken from the contract registry so none is missed. */
const AGENT_A =
  /^(trainer\.(today|calendar|slots\..+|slotSeries\..+|sessions\..+|clients\.(list|get|update)|packages\..+|packageTypes\..+)|client\.(home|slots|sessions\..+|packages))$/;
const KEYS = (Object.keys(endpoints) as EndpointKey[]).filter((k) => AGENT_A.test(k));

const RANGE = { from: '2026-10-05T00:00:00Z', to: '2026-10-12T00:00:00Z' };

function request(
  api: Pick<Api, 'get' | 'post' | 'patch' | 'put' | 'delete'> | null,
  ctx: SchedulingContext,
  key: EndpointKey,
  id: string,
  body?: object,
) {
  const def = endpoints[key];
  let path = buildPath(def.path, { id });
  if ('query' in def && (key === 'trainer.calendar' || key === 'client.slots')) {
    path += `?from=${RANGE.from}&to=${RANGE.to}`;
  }
  const method = def.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
  const req = api ? api[method](path) : ctx.http()[method](`/api${path}`);
  return body && def.method !== 'GET' ? req.send(body) : req;
}

describe('scheduling access control (e2e)', () => {
  let ctx: SchedulingContext;

  beforeAll(async () => {
    ctx = await createSchedulingApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.clock.set('2026-10-05T08:00:00Z');
  });

  it('covers all 33 Agent A endpoints', () => {
    expect(KEYS).toHaveLength(33);
  });

  it.each(KEYS)(
    '%s: 401 without a token, 403 for the wrong role, allowed for the right role',
    async (key) => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const def = endpoints[key];
      const [allowed, forbidden] = def.access === 'TRAINER' ? [t.api, c.api] : [c.api, t.api];
      const id = randomUUID();

      const anon = await request(null, ctx, key, id, {});
      expect(anon.status).toBe(401);
      expect(anon.body.code).toBe('UNAUTHORIZED');

      const wrong = await request(forbidden, ctx, key, id, {});
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe('FORBIDDEN');

      // The guard lets the right role through; the request may still fail validation (400) or find nothing (404).
      const right = await request(allowed, ctx, key, id, {});
      expect([401, 403]).not.toContain(right.status);
      expect(right.status).toBeLessThan(500);
    },
  );

  describe("cross-trainer: trainer B gets 404 on everything of trainer A's", () => {
    let a: Awaited<ReturnType<typeof trainer>>;
    let b: Awaited<ReturnType<typeof trainer>>;
    let ids: Record<string, string>;
    let clientB: string;

    beforeEach(async () => {
      a = await trainer(ctx, 'A');
      b = await trainer(ctx, 'B');
      const c = await clientOf(ctx, a.user.id);
      clientB = (await clientOf(ctx, b.user.id)).user.id;
      const pkg = await addPackage(ctx, {
        trainerId: a.user.id,
        clientId: c.user.id,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
      });
      const slot = await addSlot(ctx, a.user.id, local('2026-10-06', '09:00'));
      const free = await addSlot(ctx, a.user.id, local('2026-10-06', '10:00'));
      const session = (
        await a.api
          .post('/trainer/sessions')
          .send({ slotId: slot.id, clientId: c.user.id })
          .expect(201)
      ).body;
      const series = (
        await a.api
          .post('/trainer/slot-series')
          .send({
            weekdays: [3],
            startTime: '07:00',
            validFrom: '2026-10-07',
            validUntil: '2026-10-07',
          })
          .expect(201)
      ).body;
      const type = (
        await a.api.post('/trainer/package-types').send({ name: 'T', practices: 5 }).expect(201)
      ).body;
      ids = {
        client: c.user.id,
        pkg: pkg.id,
        slot: free.id,
        bookedSlot: slot.id,
        session: session.id,
        series: series.id,
        type: type.id,
      };
    });

    const cases: Array<[EndpointKey, (ids: Record<string, string>) => [string, object?]]> = [
      ['trainer.slots.update', (i) => [i.slot!, { status: 'LOCKED' }]],
      ['trainer.slots.delete', (i) => [i.slot!]],
      ['trainer.slotSeries.update', (i) => [i.series!, { autoBook: false }]],
      ['trainer.slotSeries.delete', (i) => [i.series!]],
      ['trainer.sessions.update', (i) => [i.session!, { planId: null }]],
      ['trainer.sessions.cancel', (i) => [i.session!, {}]],
      ['trainer.clients.get', (i) => [i.client!]],
      ['trainer.clients.update', (i) => [i.client!, { archived: true }]],
      ['trainer.packages.listForClient', (i) => [i.client!]],
      [
        'trainer.packages.create',
        (i) => [i.client!, { name: 'X', totalPractices: 1, validFrom: '2026-10-05' }],
      ],
      ['trainer.packages.update', (i) => [i.pkg!, { paymentStatus: 'PAID' }]],
      ['trainer.packages.extend', (i) => [i.pkg!, { extendedUntil: '2026-11-01', note: 'x' }]],
      ['trainer.packages.adjust', (i) => [i.pkg!, { delta: 1, note: 'x' }]],
      ['trainer.packageTypes.get', (i) => [i.type!]],
      ['trainer.packageTypes.update', (i) => [i.type!, { name: 'Y' }]],
      ['trainer.packageTypes.delete', (i) => [i.type!]],
    ];

    it.each(cases)('%s', async (key, pick) => {
      const [id, body] = pick(ids);
      const res = await request(b.api, ctx, key, id, body);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('trainer.sessions.create / move with A’s slot or client, and A’s data never shows up in B’s lists', async () => {
      await b.api
        .post('/trainer/sessions')
        .send({ slotId: ids.slot, clientId: clientB, withoutPackage: true })
        .expect(404);
      await b.api
        .post('/trainer/sessions')
        .send({ slotId: ids.slot, clientId: ids.client, withoutPackage: true })
        .expect(404);
      await b.api
        .post(`/trainer/sessions/${ids.session}/move`)
        .send({ slotId: ids.slot })
        .expect(404);
      await b.api
        .post('/trainer/slot-series')
        .send({
          weekdays: [1],
          startTime: '09:00',
          validFrom: '2026-10-05',
          reservedForClientId: ids.client,
        })
        .expect(404);

      const cal = (
        await b.api.get(`/trainer/calendar?from=${RANGE.from}&to=${RANGE.to}`).expect(200)
      ).body;
      expect(cal).toEqual({ slots: [], practices: [] });
      expect(
        (await b.api.get('/trainer/today?date=2026-10-06').expect(200)).body.practices,
      ).toEqual([]);
      expect((await b.api.get('/trainer/slot-series').expect(200)).body).toEqual([]);
      expect((await b.api.get('/trainer/package-types').expect(200)).body).toEqual([]);
      expect(
        (await b.api.get('/trainer/clients').expect(200)).body.map((c: { id: string }) => c.id),
      ).toEqual([clientB]);

      // and A's rows are untouched
      expect(await ctx.prisma.slot.count({ where: { trainerId: a.user.id } })).toBe(3);
      expect(
        (await ctx.prisma.session.findUniqueOrThrow({ where: { id: ids.session } })).status,
      ).toBe('BOOKED');
    });
  });

  it("cross-client: client Y cannot see or cancel client X's practices and sees only their own trainer's slots", async () => {
    const t = await trainer(ctx);
    const x = await clientOf(ctx, t.user.id);
    await addPackage(ctx, {
      trainerId: t.user.id,
      clientId: x.user.id,
      validFrom: '2026-10-01',
      validUntil: '2026-10-31',
    });
    const slot = await addSlot(ctx, t.user.id, local('2026-10-07', '09:00'));
    const px = (await x.api.post('/client/sessions').send({ slotId: slot.id }).expect(201)).body;

    const t2 = await trainer(ctx, 'Other');
    const y = await clientOf(ctx, t2.user.id);
    const res = await y.api.post(`/client/sessions/${px.id}/cancel`).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect((await y.api.get('/client/sessions').expect(200)).body).toEqual([]);
    expect((await y.api.get('/client/packages').expect(200)).body).toEqual([]);
    await addSlot(ctx, t.user.id, local('2026-10-08', '09:00'));
    expect(
      (await y.api.get(`/client/slots?from=${RANGE.from}&to=${RANGE.to}`).expect(200)).body,
    ).toEqual([]);
    await y.api.post('/client/sessions').send({ slotId: slot.id }).expect(404);
  });
});
