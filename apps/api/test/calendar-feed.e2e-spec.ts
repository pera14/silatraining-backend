import { CalendarFeedResponse } from '@sila/contracts';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { addPlan, addSlot, clientOf, local, trainer, world } from './scheduling/fixtures';

/** `http://localhost:3001/api/calendar/<token>.ics` → `/api/calendar/<token>.ics` */
function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** Unfolded VEVENT blocks (RFC 5545 folds long lines at 75 octets). */
function events(ics: string): string[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  return [...unfolded.matchAll(/BEGIN:VEVENT\r\n([\s\S]*?)END:VEVENT/g)].map((m) => m[1]!);
}

describe('calendar feed (e2e)', () => {
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

  it('GET creates the feed once and returns the same URL; only the token hash is stored', async () => {
    const t = await trainer(ctx);
    const first = CalendarFeedResponse.parse(
      (await t.api.get('/trainer/calendar-feed').expect(200)).body,
    );
    const again = CalendarFeedResponse.parse(
      (await t.api.get('/trainer/calendar-feed').expect(200)).body,
    );
    expect(again.url).toBe(first.url);
    expect(first.url).toMatch(/^http:\/\/localhost:3001\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
    const rows = await ctx.prisma.calendarFeedToken.findMany();
    expect(rows).toHaveLength(1);
    const token = pathOf(first.url).split('/').pop()!.replace('.ics', '');
    expect(rows[0]!.tokenHash).not.toContain(token);
  });

  it('concurrent first calls end with one active feed', async () => {
    const t = await trainer(ctx);
    const urls = await Promise.all(
      [1, 2, 3, 4].map(
        async () =>
          CalendarFeedResponse.parse((await t.api.get('/trainer/calendar-feed').expect(200)).body)
            .url,
      ),
    );
    expect(new Set(urls).size).toBe(1);
    expect(await ctx.prisma.calendarFeedToken.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("serves the trainer's non-cancelled practices as iCal; public, no auth", async () => {
    const w = await world(ctx);
    const t = w.trainer;
    const planA = await addPlan(ctx, t.user.id, w.client.user.id, 'Plan A', 0);
    const s1 = await addSlot(ctx, t.user.id, local('2026-10-06', '18:00'));
    const s2 = await addSlot(ctx, t.user.id, local('2026-10-07', '18:30'));
    const s3 = await addSlot(ctx, t.user.id, local('2026-10-08', '07:00'));
    const afterDst = await addSlot(ctx, t.user.id, local('2026-10-26', '18:00')); // CET, UTC+1
    const p1 = (await w.client.api.post('/client/sessions').send({ slotId: s1.id }).expect(201))
      .body;
    await t.api
      .post('/trainer/sessions')
      .send({ slotId: s2.id, clientId: w.client.user.id, planId: planA.id })
      .expect(201);
    const p3 = (await w.client.api.post('/client/sessions').send({ slotId: s3.id }).expect(201))
      .body;
    await w.client.api.post(`/client/sessions/${p3.id}/cancel`).expect(200);
    await t.api
      .post('/trainer/sessions')
      .send({ slotId: afterDst.id, clientId: w.client.user.id })
      .expect(201);
    // another trainer's practice must never leak into this feed
    const other = await world(ctx);
    const os = await addSlot(ctx, other.trainer.user.id, local('2026-10-06', '18:00'));
    await other.client.api.post('/client/sessions').send({ slotId: os.id }).expect(201);

    const { url } = (await t.api.get('/trainer/calendar-feed').expect(200)).body;
    const res = await ctx.http().get(pathOf(url)).expect(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    const ics = res.text;
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toContain('X-WR-CALNAME:SILA · Marko Ilić');

    const ev = events(ics);
    expect(ev).toHaveLength(3);
    expect(ev[2]).toContain('DTSTART:20261026T170000Z');
    const clientName = `${w.client.user.firstName} ${w.client.user.lastName}`;
    expect(ev[0]).toContain(`UID:${p1.id}@sila-training`);
    // UTC instants: 18:00 in Belgrade (CEST, UTC+2)
    expect(ev[0]).toContain('DTSTART:20261006T160000Z');
    expect(ev[0]).toContain('DTEND:20261006T170000Z');
    expect(ev[0]).toContain(`SUMMARY:${clientName}`);
    expect(ev[0]).toContain('STATUS:CONFIRMED');
    expect(ev[1]).toContain('DTSTART:20261007T163000Z');
    expect(ev[1]).toContain(`SUMMARY:${clientName} · Plan A`);
    expect(ev[1]).toContain(
      `URL;VALUE=URI:http://localhost:3001/trainer/clients/${w.client.user.id}`,
    );
    expect(ics).not.toContain(other.client.user.lastName);
  });

  it('regenerate revokes the old URL immediately (404) and the new one works', async () => {
    const t = await trainer(ctx);
    const old = (await t.api.get('/trainer/calendar-feed').expect(200)).body.url;
    const fresh = CalendarFeedResponse.parse(
      (await t.api.post('/trainer/calendar-feed/regenerate').expect(200)).body,
    );
    expect(fresh.url).not.toBe(old);
    const gone = await ctx.http().get(pathOf(old)).expect(404);
    expect(gone.body.code).toBe('NOT_FOUND');
    await ctx.http().get(pathOf(fresh.url)).expect(200);
    expect((await t.api.get('/trainer/calendar-feed').expect(200)).body.url).toBe(fresh.url);
  });

  it('unknown tokens are 404, malformed ones 400; a forged token for another row id does not work', async () => {
    const t = await trainer(ctx);
    await t.api.get('/trainer/calendar-feed').expect(200);
    const unknown = await ctx
      .http()
      .get(`/api/calendar/${'a'.repeat(43)}.ics`)
      .expect(404);
    expect(unknown.body.code).toBe('NOT_FOUND');
    await ctx.http().get('/api/calendar/short.ics').expect(400);
    // the row id is not the token
    const row = await ctx.prisma.calendarFeedToken.findFirstOrThrow();
    await ctx.http().get(`/api/calendar/${row.id}.ics`).expect(404);
    // only the .ics path exists
    await ctx
      .http()
      .get(`/api/calendar/${'a'.repeat(43)}`)
      .expect(404);
  });

  it('feeds are per trainer', async () => {
    const a = await trainer(ctx, 'A');
    const b = await trainer(ctx, 'B');
    const c = await clientOf(ctx, a.user.id);
    const slot = await addSlot(ctx, a.user.id, local('2026-10-06', '18:00'));
    await a.api
      .post('/trainer/sessions')
      .send({ slotId: slot.id, clientId: c.user.id, withoutPackage: true })
      .expect(201);
    const urlA = (await a.api.get('/trainer/calendar-feed').expect(200)).body.url;
    const urlB = (await b.api.get('/trainer/calendar-feed').expect(200)).body.url;
    expect(urlA).not.toBe(urlB);
    expect(events((await ctx.http().get(pathOf(urlA)).expect(200)).text)).toHaveLength(1);
    expect(events((await ctx.http().get(pathOf(urlB)).expect(200)).text)).toHaveLength(0);
    // B regenerating does not touch A's feed
    await b.api.post('/trainer/calendar-feed/regenerate').expect(200);
    await ctx.http().get(pathOf(urlA)).expect(200);
  });
});
