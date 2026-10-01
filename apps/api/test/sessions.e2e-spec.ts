import { ClientHome, ClientPractice, TodayResponse, TrainerPractice } from '@sila/contracts';
import { z } from 'zod';
import { AttendanceCron } from '../src/modules/sessions/attendance.cron';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import {
  addPackage,
  addPlan,
  addSlot,
  clientOf,
  left,
  local,
  trainer,
  world,
} from './scheduling/fixtures';

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('practices (e2e)', () => {
  let ctx: SchedulingContext;

  beforeAll(async () => {
    ctx = await createSchedulingApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.clock.set('2026-10-05T08:00:00Z'); // Mon 5 Oct 2026, 10:00 Belgrade
  });

  // ------------------------------------------------------------------ client booking

  describe('client booking: POST /client/sessions', () => {
    it('books an open slot with the active package (201) and uses one practice', async () => {
      const w = await world(ctx);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '18:00'));

      const res = await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(201);
      const body = ClientPractice.parse(res.body);
      expect(body).toMatchObject({
        status: 'BOOKED',
        startsAt: '2026-10-06T16:00:00.000Z',
        canCancel: true,
        packageName: '10 practices / month',
      });
      expect(await left(ctx, w.pkg.id)).toBe(9);
      expect(await ctx.prisma.session.findUnique({ where: { id: body.id } })).toMatchObject({
        packageId: w.pkg.id,
        createdById: w.client.user.id,
      });
    });

    it('enforces the 6h cutoff: exactly 6:00 before start is allowed, 5:59 is 422 BOOKING_CUTOFF', async () => {
      const w = await world(ctx);
      const startsAt = local('2026-10-06', '18:00');
      const a = await addSlot(ctx, w.trainer.user.id, startsAt);
      const b = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '19:00'));

      ctx.clock.set(new Date(startsAt.getTime() - 6 * HOUR));
      await w.client.api.post('/client/sessions').send({ slotId: a.id }).expect(201);

      ctx.clock.set(new Date(b.startsAt.getTime() - 6 * HOUR + MINUTE)); // 5:59 before
      const res = await w.client.api.post('/client/sessions').send({ slotId: b.id }).expect(422);
      expect(res.body.code).toBe('BOOKING_CUTOFF');
    });

    it('returns 402 NO_PACKAGE without a package, outside validity, or with no practices left', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const oct = await addSlot(ctx, t.user.id, local('2026-10-06', '18:00'));

      let res = await c.api.post('/client/sessions').send({ slotId: oct.id }).expect(402);
      expect(res.body.code).toBe('NO_PACKAGE');

      // a package that ended on Oct 5 does not cover Oct 6
      await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: c.user.id,
        validFrom: '2026-09-06',
        validUntil: '2026-10-05',
      });
      res = await c.api.post('/client/sessions').send({ slotId: oct.id }).expect(402);
      expect(res.body.code).toBe('NO_PACKAGE');

      // a 1-practice package that is used up
      await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: c.user.id,
        validFrom: '2026-10-06',
        validUntil: '2026-11-05',
        total: 1,
      });
      await c.api.post('/client/sessions').send({ slotId: oct.id }).expect(201);
      const next = await addSlot(ctx, t.user.id, local('2026-10-07', '18:00'));
      res = await c.api.post('/client/sessions').send({ slotId: next.id }).expect(402);
      expect(res.body.code).toBe('NO_PACKAGE');
    });

    it('returns 409 SLOT_TAKEN for a booked slot and 404 for locked, reserved-for-others or foreign slots', async () => {
      const w = await world(ctx);
      const other = await clientOf(ctx, w.trainer.user.id);
      await addPackage(ctx, {
        trainerId: w.trainer.user.id,
        clientId: other.user.id,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
      });
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '18:00'));
      await other.api.post('/client/sessions').send({ slotId: slot.id }).expect(201);
      const taken = await w.client.api
        .post('/client/sessions')
        .send({ slotId: slot.id })
        .expect(409);
      expect(taken.body.code).toBe('SLOT_TAKEN');

      const locked = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'), {
        status: 'LOCKED',
      });
      const reserved = await addSlot(ctx, w.trainer.user.id, local('2026-10-08', '18:00'), {
        reservedForClientId: other.user.id,
      });
      const t2 = await trainer(ctx, 'Other');
      const foreign = await addSlot(ctx, t2.user.id, local('2026-10-09', '18:00'));
      for (const s of [locked, reserved, foreign]) {
        const res = await w.client.api.post('/client/sessions').send({ slotId: s.id }).expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }

      // a slot reserved for me is bookable
      const mine = await addSlot(ctx, w.trainer.user.id, local('2026-10-10', '18:00'), {
        reservedForClientId: w.client.user.id,
      });
      await w.client.api.post('/client/sessions').send({ slotId: mine.id }).expect(201);
    });

    it('lets exactly one of many concurrent bookings of one slot succeed', async () => {
      const t = await trainer(ctx);
      const clients = await Promise.all(
        Array.from({ length: 8 }, (_, i) => clientOf(ctx, t.user.id, { firstName: `C${i}` })),
      );
      for (const c of clients) {
        await addPackage(ctx, {
          trainerId: t.user.id,
          clientId: c.user.id,
          validFrom: '2026-10-01',
          validUntil: '2026-10-31',
        });
      }
      const slot = await addSlot(ctx, t.user.id, local('2026-10-06', '18:00'));

      const results = await Promise.all(
        clients.map((c) => c.api.post('/client/sessions').send({ slotId: slot.id })),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(clients.length - 1);
      expect(
        results.filter((r) => r.status === 409).every((r) => r.body.code === 'SLOT_TAKEN'),
      ).toBe(true);
      expect(await ctx.prisma.session.count({ where: { slotId: slot.id } })).toBe(1);
    });

    it('never overspends the last practice with parallel bookings of different slots', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const pkg = await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: c.user.id,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
        total: 1,
      });
      const slots = await Promise.all(
        ['17:00', '18:00', '19:00'].map((time) =>
          addSlot(ctx, t.user.id, local('2026-10-06', time)),
        ),
      );
      const results = await Promise.all(
        slots.map((s) => c.api.post('/client/sessions').send({ slotId: s.id })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 402, 402]);
      expect(await left(ctx, pkg.id)).toBe(0);
    });

    it('treats an archived client as having no trainer', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id, { archived: true });
      const slot = await addSlot(ctx, t.user.id, local('2026-10-06', '18:00'));
      await c.api.post('/client/sessions').send({ slotId: slot.id }).expect(404);
    });
  });

  // ------------------------------------------------------------------ client cancel

  describe('client cancel: POST /client/sessions/:id/cancel', () => {
    it('cancels at exactly 6:00 before (practice returned, slot reopens) and refuses at 5:59 (403)', async () => {
      const w = await world(ctx);
      const a = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
      const b = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '19:00'));
      const pa = (await w.client.api.post('/client/sessions').send({ slotId: a.id }).expect(201))
        .body;
      const pb = (await w.client.api.post('/client/sessions').send({ slotId: b.id }).expect(201))
        .body;
      expect(await left(ctx, w.pkg.id)).toBe(8);

      ctx.clock.set(new Date(a.startsAt.getTime() - 6 * HOUR));
      const res = await w.client.api.post(`/client/sessions/${pa.id}/cancel`).expect(200);
      expect(ClientPractice.parse(res.body)).toMatchObject({
        status: 'CANCELLED',
        canCancel: false,
      });
      expect(await left(ctx, w.pkg.id)).toBe(9);
      // the slot is free again
      const other = await clientOf(ctx, w.trainer.user.id);
      await addPackage(ctx, {
        trainerId: w.trainer.user.id,
        clientId: other.user.id,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
      });
      ctx.clock.set('2026-10-05T08:00:00Z');
      await other.api.post('/client/sessions').send({ slotId: a.id }).expect(201);

      ctx.clock.set(new Date(b.startsAt.getTime() - 6 * HOUR + MINUTE));
      const late = await w.client.api.post(`/client/sessions/${pb.id}/cancel`).expect(403);
      expect(late.body.code).toBe('CANCEL_CUTOFF');
      expect(await left(ctx, w.pkg.id)).toBe(9);
    });

    it("returns 404 for someone else's practice and 409 INVALID_STATE when already cancelled", async () => {
      const w = await world(ctx);
      const other = await clientOf(ctx, w.trainer.user.id);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
      const p = (await w.client.api.post('/client/sessions').send({ slotId: slot.id })).body;
      await other.api.post(`/client/sessions/${p.id}/cancel`).expect(404);
      await w.client.api.post(`/client/sessions/${p.id}/cancel`).expect(200);
      const again = await w.client.api.post(`/client/sessions/${p.id}/cancel`).expect(409);
      expect(again.body.code).toBe('INVALID_STATE');
    });
  });

  // ------------------------------------------------------------------ trainer booking

  describe('trainer booking: POST /trainer/sessions', () => {
    it('books without a cutoff, including locked slots, and uses the active package', async () => {
      const w = await world(ctx);
      const soon = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '11:00'), {
        status: 'LOCKED',
      });
      const res = await w.trainer.api
        .post('/trainer/sessions')
        .send({ slotId: soon.id, clientId: w.client.user.id })
        .expect(201);
      expect(TrainerPractice.parse(res.body)).toMatchObject({
        packageId: w.pkg.id,
        client: { id: w.client.user.id },
        status: 'BOOKED',
      });
      expect(await left(ctx, w.pkg.id)).toBe(9);
    });

    it('books withoutPackage (packageId null) even when the client has no package', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const slot = await addSlot(ctx, t.user.id, local('2026-10-06', '18:00'));
      await t.api
        .post('/trainer/sessions')
        .send({ slotId: slot.id, clientId: c.user.id })
        .expect(402);
      const res = await t.api
        .post('/trainer/sessions')
        .send({ slotId: slot.id, clientId: c.user.id, withoutPackage: true })
        .expect(201);
      expect(res.body.packageId).toBeNull();
    });

    it("404s for another trainer's client or slot", async () => {
      const w = await world(ctx);
      const t2 = await trainer(ctx, 'Other');
      const c2 = await clientOf(ctx, t2.user.id);
      const mySlot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '18:00'));
      const theirSlot = await addSlot(ctx, t2.user.id, local('2026-10-06', '18:00'));
      await w.trainer.api
        .post('/trainer/sessions')
        .send({ slotId: mySlot.id, clientId: c2.user.id })
        .expect(404);
      await w.trainer.api
        .post('/trainer/sessions')
        .send({ slotId: theirSlot.id, clientId: w.client.user.id })
        .expect(404);
    });
  });

  // ------------------------------------------------------------------ move / cancel (trainer)

  describe('trainer move and cancel', () => {
    it('moves a practice to a free slot keeping package and plan; a taken slot is 409', async () => {
      const w = await world(ctx);
      const planA = await addPlan(ctx, w.trainer.user.id, w.client.user.id, 'Plan A', 0);
      const from = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '18:00'));
      const to = await addSlot(ctx, w.trainer.user.id, local('2026-10-08', '09:30'));
      const busy = await addSlot(ctx, w.trainer.user.id, local('2026-10-09', '09:00'));
      const p = (
        await w.trainer.api
          .post('/trainer/sessions')
          .send({ slotId: from.id, clientId: w.client.user.id })
          .expect(201)
      ).body;
      await w.trainer.api
        .post('/trainer/sessions')
        .send({ slotId: busy.id, clientId: w.client.user.id })
        .expect(201);

      const res = await w.trainer.api
        .post(`/trainer/sessions/${p.id}/move`)
        .send({ slotId: to.id })
        .expect(200);
      expect(res.body).toMatchObject({
        slotId: to.id,
        startsAt: to.startsAt.toISOString(),
        packageId: w.pkg.id,
        plan: { id: planA.id },
      });
      expect(await left(ctx, w.pkg.id)).toBe(8); // moving does not use another practice

      const taken = await w.trainer.api
        .post(`/trainer/sessions/${p.id}/move`)
        .send({ slotId: busy.id })
        .expect(409);
      expect(taken.body.code).toBe('SLOT_TAKEN');

      // the old slot is free again
      await w.client.api.post('/client/sessions').send({ slotId: from.id }).expect(201);
    });

    it('cancels anytime; returnPractice defaults to yes ≥ 6h before and no inside 6h; audit-logged', async () => {
      const w = await world(ctx);
      const far = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
      const near = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '13:00')); // 3h away
      const explicit = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '14:00'));
      const book = async (slotId: string) =>
        (
          await w.trainer.api
            .post('/trainer/sessions')
            .send({ slotId, clientId: w.client.user.id })
            .expect(201)
        ).body.id as string;
      const [pFar, pNear, pExplicit] = [
        await book(far.id),
        await book(near.id),
        await book(explicit.id),
      ];
      expect(await left(ctx, w.pkg.id)).toBe(7);

      let res = await w.trainer.api.post(`/trainer/sessions/${pFar}/cancel`).send({}).expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', practiceReturned: true });
      res = await w.trainer.api.post(`/trainer/sessions/${pNear}/cancel`).send({}).expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', practiceReturned: false });
      res = await w.trainer.api
        .post(`/trainer/sessions/${pExplicit}/cancel`)
        .send({ returnPractice: true })
        .expect(200);
      expect(res.body.practiceReturned).toBe(true);
      expect(await left(ctx, w.pkg.id)).toBe(9); // only the near one stays used

      expect(
        await ctx.prisma.auditLog.count({
          where: { action: 'session.cancel', actorId: w.trainer.user.id },
        }),
      ).toBe(3);
      const again = await w.trainer.api
        .post(`/trainer/sessions/${pFar}/cancel`)
        .send({})
        .expect(409);
      expect(again.body.code).toBe('INVALID_STATE');
    });
  });

  // ------------------------------------------------------------------ attendance

  describe('attendance: PATCH /trainer/sessions/:id', () => {
    it('toggles ATTENDED / NO_SHOW; both use a practice, a cancel returns it', async () => {
      const w = await world(ctx);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '09:00')); // earlier today
      const p = (
        await w.trainer.api
          .post('/trainer/sessions')
          .send({ slotId: slot.id, clientId: w.client.user.id })
          .expect(201)
      ).body;

      let res = await w.trainer.api
        .patch(`/trainer/sessions/${p.id}`)
        .send({ status: 'NO_SHOW' })
        .expect(200);
      expect(res.body.status).toBe('NO_SHOW');
      expect(res.body.attendanceMarkedAt).not.toBeNull();
      expect(await left(ctx, w.pkg.id)).toBe(9); // a no-show uses a practice

      res = await w.trainer.api
        .patch(`/trainer/sessions/${p.id}`)
        .send({ status: 'ATTENDED' })
        .expect(200);
      expect(res.body.status).toBe('ATTENDED');
      expect(await left(ctx, w.pkg.id)).toBe(9);

      // a future booking that gets cancelled gives the practice back
      const future = await addSlot(ctx, w.trainer.user.id, local('2026-10-09', '09:00'));
      const pf = (await w.client.api.post('/client/sessions').send({ slotId: future.id })).body;
      expect(await left(ctx, w.pkg.id)).toBe(8);
      await w.client.api.post(`/client/sessions/${pf.id}/cancel`).expect(200);
      expect(await left(ctx, w.pkg.id)).toBe(9);
    });

    it('refuses attendance on a future day or a cancelled practice (409 INVALID_STATE)', async () => {
      const w = await world(ctx);
      const tomorrow = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'));
      const p = (
        await w.trainer.api
          .post('/trainer/sessions')
          .send({ slotId: tomorrow.id, clientId: w.client.user.id })
          .expect(201)
      ).body;
      let res = await w.trainer.api
        .patch(`/trainer/sessions/${p.id}`)
        .send({ status: 'ATTENDED' })
        .expect(409);
      expect(res.body.code).toBe('INVALID_STATE');

      await w.trainer.api.post(`/trainer/sessions/${p.id}/cancel`).send({}).expect(200);
      ctx.clock.set('2026-10-06T10:00:00Z');
      res = await w.trainer.api
        .patch(`/trainer/sessions/${p.id}`)
        .send({ status: 'NO_SHOW' })
        .expect(409);
      expect(res.body.code).toBe('INVALID_STATE');
    });

    it("switches the plan to one of the client's plans only", async () => {
      const w = await world(ctx);
      const planB = await addPlan(ctx, w.trainer.user.id, w.client.user.id, 'Plan B', 1);
      const template = await ctx.prisma.plan.create({
        data: { trainerId: w.trainer.user.id, clientId: null, name: 'Template', sortOrder: 0 },
      });
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'));
      const p = (
        await w.trainer.api
          .post('/trainer/sessions')
          .send({ slotId: slot.id, clientId: w.client.user.id })
          .expect(201)
      ).body;
      let res = await w.trainer.api
        .patch(`/trainer/sessions/${p.id}`)
        .send({ planId: planB.id })
        .expect(200);
      expect(res.body.plan).toEqual({ id: planB.id, name: 'Plan B' });
      await w.trainer.api
        .patch(`/trainer/sessions/${p.id}`)
        .send({ planId: template.id })
        .expect(404);
      res = await w.trainer.api
        .patch(`/trainer/sessions/${p.id}`)
        .send({ planId: null })
        .expect(200);
      expect(res.body.plan).toBeNull();
      await w.trainer.api.patch(`/trainer/sessions/${p.id}`).send({}).expect(400);
    });

    it('nightly job marks BOOKED practices of finished days as ATTENDED, not today’s', async () => {
      const w = await world(ctx);
      const yesterday = await addSlot(ctx, w.trainer.user.id, local('2026-10-04', '23:00'));
      const today = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '09:00'));
      const noShow = await addSlot(ctx, w.trainer.user.id, local('2026-10-04', '10:00'));
      const cancelled = await addSlot(ctx, w.trainer.user.id, local('2026-10-04', '12:00'));
      const ids: Record<string, string> = {};
      for (const [k, s] of Object.entries({ yesterday, today, noShow, cancelled })) {
        ids[k] = (
          await w.trainer.api
            .post('/trainer/sessions')
            .send({ slotId: s.id, clientId: w.client.user.id })
            .expect(201)
        ).body.id;
      }
      await w.trainer.api
        .patch(`/trainer/sessions/${ids.noShow}`)
        .send({ status: 'NO_SHOW' })
        .expect(200);
      await w.trainer.api.post(`/trainer/sessions/${ids.cancelled}/cancel`).send({}).expect(200);

      ctx.clock.set(local('2026-10-05', '00:05')); // the cron's run time
      const cron = ctx.app.get(AttendanceCron);
      expect(await cron.autoMarkAttended()).toBe(1);
      expect(await cron.autoMarkAttended()).toBe(0); // idempotent

      const status = async (id: string) =>
        (await ctx.prisma.session.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(ids.yesterday!)).toBe('ATTENDED');
      expect(await status(ids.today!)).toBe('BOOKED');
      expect(await status(ids.noShow!)).toBe('NO_SHOW');
      expect(await status(ids.cancelled!)).toBe('CANCELLED');
    });
  });

  // ------------------------------------------------------------------ plan rotation

  describe('plan rotation', () => {
    it('gives each new practice the next plan after the previous practice (A → B → A), ignoring attendance', async () => {
      const w = await world(ctx);
      const a = await addPlan(ctx, w.trainer.user.id, w.client.user.id, 'Plan A', 0);
      const b = await addPlan(ctx, w.trainer.user.id, w.client.user.id, 'Plan B', 1);
      const plans: string[] = [];
      for (const day of ['2026-10-06', '2026-10-08', '2026-10-10']) {
        const slot = await addSlot(ctx, w.trainer.user.id, local(day, '18:00'));
        const res = await w.client.api
          .post('/client/sessions')
          .send({ slotId: slot.id })
          .expect(201);
        const s = await ctx.prisma.session.findUniqueOrThrow({ where: { id: res.body.id } });
        plans.push(s.planId!);
      }
      expect(plans).toEqual([a.id, b.id, a.id]);

      // a cancelled practice does not advance the rotation
      const latest = await ctx.prisma.session.findFirstOrThrow({
        where: { planId: a.id },
        orderBy: { startsAt: 'desc' },
      });
      await w.client.api.post(`/client/sessions/${latest.id}/cancel`).expect(200);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-12', '18:00'));
      const res = await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(201);
      expect(
        (await ctx.prisma.session.findUniqueOrThrow({ where: { id: res.body.id } })).planId,
      ).toBe(a.id);
    });

    it('uses an explicit trainer plan and leaves plan null for clients without plans', async () => {
      const w = await world(ctx);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '18:00'));
      const res = await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(201);
      expect(
        (await ctx.prisma.session.findUniqueOrThrow({ where: { id: res.body.id } })).planId,
      ).toBeNull();

      const b = await addPlan(ctx, w.trainer.user.id, w.client.user.id, 'Plan B', 1);
      await addPlan(ctx, w.trainer.user.id, w.client.user.id, 'Plan A', 0);
      const s2 = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
      const r2 = await w.trainer.api
        .post('/trainer/sessions')
        .send({ slotId: s2.id, clientId: w.client.user.id, planId: b.id })
        .expect(201);
      expect(r2.body.plan).toEqual({ id: b.id, name: 'Plan B' });
    });
  });

  // ------------------------------------------------------------------ Today

  describe('GET /trainer/today', () => {
    it("lists the day's practices with pinned note, package badge and the client's plans", async () => {
      const w = await world(ctx);
      const a = await addPlan(ctx, w.trainer.user.id, w.client.user.id, 'Plan A', 0);
      const b = await addPlan(ctx, w.trainer.user.id, w.client.user.id, 'Plan B', 1);
      await ctx.prisma.clientNote.create({
        data: {
          clientId: w.client.user.id,
          trainerId: w.trainer.user.id,
          body: 'Knee!',
          pinned: true,
        },
      });
      const s1 = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '18:00'));
      const s0 = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '07:00'));
      const cancelled = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '12:00'));
      const tomorrow = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '07:00'));
      for (const s of [s1, s0, cancelled, tomorrow]) {
        await w.trainer.api
          .post('/trainer/sessions')
          .send({ slotId: s.id, clientId: w.client.user.id })
          .expect(201);
      }
      const c = await ctx.prisma.session.findFirstOrThrow({ where: { slotId: cancelled.id } });
      await w.trainer.api
        .post(`/trainer/sessions/${c.id}/cancel`)
        .send({ returnPractice: true })
        .expect(200);

      const res = await w.trainer.api.get('/trainer/today').expect(200);
      const body = TodayResponse.parse(res.body);
      expect(body.date).toBe('2026-10-05');
      expect(body.practices.map((p) => p.startsAt)).toEqual([
        s0.startsAt.toISOString(),
        s1.startsAt.toISOString(),
      ]);
      expect(body.practices[0]).toMatchObject({
        pinnedNote: { body: 'Knee!' },
        package: { packageId: w.pkg.id, left: 7, total: 10, paymentStatus: 'PAID' },
        clientPlans: [
          { id: a.id, name: 'Plan A' },
          { id: b.id, name: 'Plan B' },
        ],
      });

      const other = await w.trainer.api.get('/trainer/today?date=2026-10-06').expect(200);
      expect(other.body.practices).toHaveLength(1);
    });

    it('covers the whole 25h local day on the last Sunday of October', async () => {
      const w = await world(ctx);
      ctx.clock.set('2026-10-25T10:00:00Z');
      const early = await addSlot(ctx, w.trainer.user.id, local('2026-10-25', '00:00')); // 22:00Z Oct 24
      const late = await addSlot(ctx, w.trainer.user.id, local('2026-10-25', '23:00')); // 22:00Z Oct 25
      const nextDay = await addSlot(ctx, w.trainer.user.id, local('2026-10-26', '00:00'));
      for (const s of [early, late, nextDay]) {
        await w.trainer.api
          .post('/trainer/sessions')
          .send({ slotId: s.id, clientId: w.client.user.id })
          .expect(201);
      }
      const res = await w.trainer.api.get('/trainer/today').expect(200);
      expect(res.body.date).toBe('2026-10-25');
      expect(res.body.practices.map((p: { startsAt: string }) => p.startsAt)).toEqual([
        '2026-10-24T22:00:00.000Z',
        '2026-10-25T22:00:00.000Z',
      ]);
    });
  });

  // ------------------------------------------------------------------ client home + lists

  describe('client home and practice lists', () => {
    it('shows left/total, valid until, extension and the next practice', async () => {
      const w = await world(ctx);
      await ctx.prisma.package.update({
        where: { id: w.pkg.id },
        data: { extendedUntil: new Date('2026-11-04T00:00:00Z') },
      });
      const s = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '15:00')); // 5h away
      await w.trainer.api
        .post('/trainer/sessions')
        .send({ slotId: s.id, clientId: w.client.user.id })
        .expect(201);

      const res = await w.client.api.get('/client/home').expect(200);
      expect(ClientHome.parse(res.body)).toMatchObject({
        hasActivePackage: true,
        left: 9,
        total: 10,
        validUntil: '2026-11-04',
        extended: true,
        packageName: '10 practices / month',
        nextPractice: { startsAt: s.startsAt.toISOString(), canCancel: false },
        trainer: { id: w.trainer.user.id },
      });
    });

    it('shows the no-package state', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const res = await c.api.get('/client/home').expect(200);
      expect(res.body).toMatchObject({
        hasActivePackage: false,
        left: null,
        total: null,
        validUntil: null,
        nextPractice: null,
        trainer: { id: t.user.id },
      });
    });

    it('splits upcoming and past practices with canCancel', async () => {
      const w = await world(ctx);
      const past = await addSlot(ctx, w.trainer.user.id, local('2026-10-02', '18:00'));
      const soon = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '12:00'));
      const later = await addSlot(ctx, w.trainer.user.id, local('2026-10-08', '12:00'));
      for (const s of [past, soon, later]) {
        await w.trainer.api
          .post('/trainer/sessions')
          .send({ slotId: s.id, clientId: w.client.user.id })
          .expect(201);
      }
      const upcoming = z
        .array(ClientPractice)
        .parse((await w.client.api.get('/client/sessions').expect(200)).body);
      expect(upcoming.map((p) => [p.startsAt, p.canCancel])).toEqual([
        [soon.startsAt.toISOString(), false],
        [later.startsAt.toISOString(), true],
      ]);
      const pastList = (await w.client.api.get('/client/sessions?scope=past').expect(200)).body;
      expect(pastList.map((p: { startsAt: string }) => p.startsAt)).toEqual([
        past.startsAt.toISOString(),
      ]);
      await w.client.api.get('/client/sessions?scope=nope').expect(400);
    });
  });

  describe('GET /trainer/clients/:id/sessions', () => {
    it("lists one client's practices: upcoming soonest first, past (ended or cancelled) newest first", async () => {
      const w = await world(ctx);
      const other = await clientOf(ctx, w.trainer.user.id, { firstName: 'Luka' });
      const old = await addSlot(ctx, w.trainer.user.id, local('2026-07-01', '18:00')); // > 62 days back
      const past = await addSlot(ctx, w.trainer.user.id, local('2026-10-02', '18:00'));
      const soon = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '12:00'));
      const cancelled = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '12:00'));
      const later = await addSlot(ctx, w.trainer.user.id, local('2026-10-08', '12:00'));
      const notMine = await addSlot(ctx, w.trainer.user.id, local('2026-10-09', '12:00'));
      const book = async (slotId: string, clientId = w.client.user.id) =>
        (
          await w.trainer.api
            .post('/trainer/sessions')
            .send({ slotId, clientId, withoutPackage: true })
            .expect(201)
        ).body as TrainerPractice;
      for (const s of [old, past, soon, later]) await book(s.id);
      const toCancel = await book(cancelled.id);
      await w.trainer.api.post(`/trainer/sessions/${toCancel.id}/cancel`).send({}).expect(200);
      await book(notMine.id, other.user.id);

      const url = `/trainer/clients/${w.client.user.id}/sessions`;
      const upcoming = z
        .array(TrainerPractice)
        .parse((await w.trainer.api.get(url).expect(200)).body);
      expect(upcoming.map((p) => p.startsAt)).toEqual([
        soon.startsAt.toISOString(),
        later.startsAt.toISOString(),
      ]);
      const history = z
        .array(TrainerPractice)
        .parse((await w.trainer.api.get(`${url}?scope=past`).expect(200)).body);
      expect(history.map((p) => [p.startsAt, p.status])).toEqual([
        [cancelled.startsAt.toISOString(), 'CANCELLED'],
        [past.startsAt.toISOString(), 'BOOKED'],
        [old.startsAt.toISOString(), 'BOOKED'],
      ]);
      expect(history.every((p) => p.client.id === w.client.user.id)).toBe(true);
    });

    it("is 404 for another trainer's client", async () => {
      const w = await world(ctx);
      const stranger = await trainer(ctx, 'Jovana');
      await stranger.api.get(`/trainer/clients/${w.client.user.id}/sessions`).expect(404);
    });
  });
});
