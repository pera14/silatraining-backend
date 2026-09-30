import { CalendarResponse, ClientSlot, CreateSlotsResponse, SlotSeries } from '@sila/contracts';
import { z } from 'zod';
import { AutoBookService } from '../src/modules/slots/auto-book.service';
import { SeriesService } from '../src/modules/slots/series.service';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { addPackage, addSlot, clientOf, local, trainer, world } from './scheduling/fixtures';

const utc = (iso: string) => new Date(iso).toISOString();

describe('slots and series (e2e)', () => {
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

  const seriesSlots = (seriesId: string) =>
    ctx.prisma.slot.findMany({ where: { seriesId }, orderBy: { startsAt: 'asc' } });

  // ------------------------------------------------------------------ create

  describe('POST /trainer/slots', () => {
    it('creates a single 60-minute slot', async () => {
      const t = await trainer(ctx);
      const res = await t.api
        .post('/trainer/slots')
        .send({ startsAt: '2026-10-06T16:30:00Z' })
        .expect(201);
      const { created } = CreateSlotsResponse.parse(res.body);
      expect(created).toEqual([
        expect.objectContaining({
          startsAt: '2026-10-06T16:30:00.000Z',
          endsAt: '2026-10-06T17:30:00.000Z',
          status: 'OPEN',
          reservedFor: null,
          practice: null,
        }),
      ]);
    });

    it('rejects a :15 start (and seconds) with 400 before touching the database', async () => {
      const t = await trainer(ctx);
      for (const startsAt of ['2026-10-06T16:15:00Z', '2026-10-06T16:00:30Z']) {
        const res = await t.api.post('/trainer/slots').send({ startsAt }).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      const bulk = await t.api
        .post('/trainer/slots')
        .send({ dates: ['2026-10-06'], times: ['09:15'] })
        .expect(400);
      expect(bulk.body.code).toBe('VALIDATION_FAILED');
      expect(await ctx.prisma.slot.count()).toBe(0);
    });

    it('rejects overlaps with 409 SLOT_OVERLAP listing the conflicts; back-to-back is fine', async () => {
      const t = await trainer(ctx);
      await addSlot(ctx, t.user.id, local('2026-10-06', '09:00'));
      const res = await t.api
        .post('/trainer/slots')
        .send({ startsAt: local('2026-10-06', '09:30').toISOString() })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'SLOT_OVERLAP',
        details: { conflicts: [local('2026-10-06', '09:30').toISOString()] },
      });
      await t.api
        .post('/trainer/slots')
        .send({ startsAt: local('2026-10-06', '10:00').toISOString() })
        .expect(201);

      // another trainer's slots never conflict
      const t2 = await trainer(ctx, 'Other');
      await t2.api
        .post('/trainer/slots')
        .send({ startsAt: local('2026-10-06', '09:30').toISOString() })
        .expect(201);
    });

    it('creates bulk dates × times all-or-nothing', async () => {
      const t = await trainer(ctx);
      const res = await t.api
        .post('/trainer/slots')
        .send({ dates: ['2026-10-06', '2026-10-07'], times: ['09:00', '10:00', '18:30'] })
        .expect(201);
      expect(res.body.created).toHaveLength(6);

      // one clash (Oct 8 09:30 vs requested 09:00) → nothing from this request is created
      await addSlot(ctx, t.user.id, local('2026-10-08', '09:30'));
      const clash = await t.api
        .post('/trainer/slots')
        .send({ dates: ['2026-10-08', '2026-10-09'], times: ['09:00', '11:00'] })
        .expect(409);
      expect(clash.body.details.conflicts).toEqual([local('2026-10-08', '09:00').toISOString()]);
      // requested times overlapping each other
      const self = await t.api
        .post('/trainer/slots')
        .send({ dates: ['2026-10-10'], times: ['09:00', '09:30'] })
        .expect(409);
      expect(self.body.details.conflicts).toHaveLength(2);
      expect(await ctx.prisma.slot.count({ where: { trainerId: t.user.id } })).toBe(7);
    });

    it('handles the DST change days: skips the missing 02:30 in March, creates 02:30 once in October', async () => {
      const t = await trainer(ctx);
      let res = await t.api
        .post('/trainer/slots')
        .send({ dates: ['2027-03-28'], times: ['02:30', '03:00', '09:00'] })
        .expect(201);
      expect(res.body.created.map((s: { startsAt: string }) => s.startsAt)).toEqual([
        utc('2027-03-28T01:00:00Z'), // 03:00 CEST
        utc('2027-03-28T07:00:00Z'), // 09:00 CEST
      ]);

      res = await t.api
        .post('/trainer/slots')
        .send({ dates: ['2026-10-25'], times: ['01:30', '02:30', '09:00'] })
        .expect(201);
      expect(res.body.created.map((s: { startsAt: string }) => s.startsAt)).toEqual([
        utc('2026-10-24T23:30:00Z'), // 01:30 CEST
        utc('2026-10-25T00:30:00Z'), // 02:30 CEST (first occurrence)
        utc('2026-10-25T08:00:00Z'), // 09:00 CET
      ]);
    });
  });

  // ------------------------------------------------------------------ update / delete / lock-range

  describe('PATCH/DELETE /trainer/slots/:id and lock-range', () => {
    it('locks with a reason, unlocks (clearing it) and reserves for own clients only', async () => {
      const w = await world(ctx);
      const t2 = await trainer(ctx, 'Other');
      const foreignClient = await clientOf(ctx, t2.user.id);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'));

      let res = await w.trainer.api
        .patch(`/trainer/slots/${slot.id}`)
        .send({ status: 'LOCKED', lockReason: 'Break' })
        .expect(200);
      expect(res.body).toMatchObject({ status: 'LOCKED', lockReason: 'Break' });
      res = await w.trainer.api
        .patch(`/trainer/slots/${slot.id}`)
        .send({ status: 'OPEN' })
        .expect(200);
      expect(res.body).toMatchObject({ status: 'OPEN', lockReason: null });

      res = await w.trainer.api
        .patch(`/trainer/slots/${slot.id}`)
        .send({ reservedForClientId: w.client.user.id })
        .expect(200);
      expect(res.body.reservedFor).toMatchObject({ id: w.client.user.id });
      await w.trainer.api
        .patch(`/trainer/slots/${slot.id}`)
        .send({ reservedForClientId: foreignClient.user.id })
        .expect(404);
      await w.trainer.api.patch(`/trainer/slots/${slot.id}`).send({}).expect(400);
      await t2.api.patch(`/trainer/slots/${slot.id}`).send({ status: 'LOCKED' }).expect(404);
    });

    it('refuses to lock or delete a booked slot (422 SLOT_BOOKED) until the practice is cancelled', async () => {
      const w = await world(ctx);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'));
      const p = (await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(201))
        .body;

      let res = await w.trainer.api
        .patch(`/trainer/slots/${slot.id}`)
        .send({ status: 'LOCKED' })
        .expect(422);
      expect(res.body.code).toBe('SLOT_BOOKED');
      res = await w.trainer.api.delete(`/trainer/slots/${slot.id}`).expect(422);
      expect(res.body.code).toBe('SLOT_BOOKED');

      await w.client.api.post(`/client/sessions/${p.id}/cancel`).expect(200);
      await w.trainer.api.delete(`/trainer/slots/${slot.id}`).expect(204);
      // the cancelled practice survives the slot
      expect(await ctx.prisma.session.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
        slotId: null,
        status: 'CANCELLED',
      });
      await w.trainer.api.delete(`/trainer/slots/${slot.id}`).expect(404);
    });

    it('lock-range locks open slots overlapping the range and skips booked ones', async () => {
      const w = await world(ctx);
      const s9 = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'));
      const s10 = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '10:00'));
      const s11 = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '11:00'));
      const s13 = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '13:00'));
      await w.client.api.post('/client/sessions').send({ slotId: s10.id }).expect(201);

      const res = await w.trainer.api
        .post('/trainer/slots/lock-range')
        .send({
          from: local('2026-10-06', '09:30').toISOString(), // overlaps the 09:00 slot
          to: local('2026-10-06', '12:00').toISOString(),
          reason: 'Personal',
        })
        .expect(200);
      expect(res.body).toEqual({ locked: 2, skippedBooked: 1 });
      const status = async (id: string) =>
        (await ctx.prisma.slot.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(s9.id)).toBe('LOCKED');
      expect(await status(s10.id)).toBe('OPEN');
      expect(await status(s11.id)).toBe('LOCKED');
      expect(await status(s13.id)).toBe('OPEN');
    });
  });

  // ------------------------------------------------------------------ calendar + client slots

  describe('GET /trainer/calendar and GET /client/slots', () => {
    it('returns slots (reserved, booked) and every practice in range, cancelled included', async () => {
      const w = await world(ctx);
      const booked = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'));
      await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '10:00'), {
        reservedForClientId: w.client.user.id,
      });
      const cancelledSlot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '11:00'));
      await addSlot(ctx, w.trainer.user.id, local('2026-10-20', '11:00')); // outside range
      await w.client.api.post('/client/sessions').send({ slotId: booked.id }).expect(201);
      const c = (await w.client.api.post('/client/sessions').send({ slotId: cancelledSlot.id }))
        .body;
      await w.client.api.post(`/client/sessions/${c.id}/cancel`).expect(200);

      const res = await w.trainer.api
        .get('/trainer/calendar?from=2026-10-05T22:00:00Z&to=2026-10-06T22:00:00Z')
        .expect(200);
      const body = CalendarResponse.parse(res.body);
      expect(body.slots).toHaveLength(3);
      expect(body.slots[0]!.practice).toMatchObject({
        status: 'BOOKED',
        client: { id: w.client.user.id },
      });
      expect(body.slots[1]!.reservedFor).toMatchObject({ id: w.client.user.id });
      expect(body.slots[2]!.practice).toBeNull();
      expect(body.practices.map((p) => p.status)).toEqual(['BOOKED', 'CANCELLED']);

      await w.trainer.api
        .get('/trainer/calendar?from=2026-10-01T00:00:00Z&to=2026-12-31T00:00:00Z')
        .expect(400);
      await w.trainer.api
        .get('/trainer/calendar?from=2026-10-06T00:00:00Z&to=2026-10-01T00:00:00Z')
        .expect(400);
    });

    it('shows clients only bookable slots ≥ 6h ahead, flagging those outside the package', async () => {
      const w = await world(ctx); // package Oct 1–31
      const other = await clientOf(ctx, w.trainer.user.id);
      const tooSoon = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '15:00')); // 5h ahead
      const exactly6h = await addSlot(ctx, w.trainer.user.id, local('2026-10-05', '16:00'));
      const locked = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'), {
        status: 'LOCKED',
      });
      const forOther = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '10:00'), {
        reservedForClientId: other.user.id,
      });
      const forMe = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '11:00'), {
        reservedForClientId: w.client.user.id,
      });
      const booked = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '12:00'));
      await w.trainer.api
        .post('/trainer/sessions')
        .send({ slotId: booked.id, clientId: other.user.id, withoutPackage: true })
        .expect(201);
      const afterPackage = await addSlot(ctx, w.trainer.user.id, local('2026-11-01', '09:00'));
      const t2 = await trainer(ctx, 'Other');
      await addSlot(ctx, t2.user.id, local('2026-10-06', '13:00'));

      const res = await w.client.api
        .get('/client/slots?from=2026-10-04T22:00:00Z&to=2026-11-05T00:00:00Z')
        .expect(200);
      const slots = z.array(ClientSlot).parse(res.body);
      expect(slots.map((s) => s.id)).toEqual([exactly6h.id, forMe.id, afterPackage.id]);
      expect(slots.map((s) => s.withinPackage)).toEqual([true, true, false]);
      expect(slots.map((s) => s.reservedForMe)).toEqual([false, true, false]);
      for (const hidden of [tooSoon, locked, forOther, booked]) {
        expect(slots.map((s) => s.id)).not.toContain(hidden.id);
      }
    });

    it('returns no slots to a client without a trainer', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id, { archived: true });
      await addSlot(ctx, t.user.id, local('2026-10-06', '09:00'));
      const res = await c.api
        .get('/client/slots?from=2026-10-05T00:00:00Z&to=2026-10-10T00:00:00Z')
        .expect(200);
      expect(res.body).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ series

  describe('slot series', () => {
    it('materializes 8 weeks ahead and keeps local 09:00 across the October DST change', async () => {
      const t = await trainer(ctx);
      ctx.clock.set('2026-10-20T08:00:00Z');
      const res = await t.api
        .post('/trainer/slot-series')
        .send({
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startTime: '09:00',
          validFrom: '2026-10-23',
          validUntil: '2026-10-27',
        })
        .expect(201);
      const series = SlotSeries.parse(res.body);
      expect(series).toMatchObject({
        validFrom: '2026-10-23',
        validUntil: '2026-10-27',
        autoBook: false,
      });
      expect((await seriesSlots(series.id)).map((s) => s.startsAt.toISOString())).toEqual([
        utc('2026-10-23T07:00:00Z'),
        utc('2026-10-24T07:00:00Z'),
        utc('2026-10-25T08:00:00Z'), // last Sunday of October: CET from here on
        utc('2026-10-26T08:00:00Z'),
        utc('2026-10-27T08:00:00Z'),
      ]);
    });

    it('keeps local 09:00 across the March DST change and skips the missing 02:30', async () => {
      const t = await trainer(ctx);
      ctx.clock.set('2027-03-20T08:00:00Z');
      const nine = (
        await t.api
          .post('/trainer/slot-series')
          .send({
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            startTime: '09:00',
            validFrom: '2027-03-26',
            validUntil: '2027-03-30',
          })
          .expect(201)
      ).body;
      expect((await seriesSlots(nine.id)).map((s) => s.startsAt.toISOString())).toEqual([
        utc('2027-03-26T08:00:00Z'),
        utc('2027-03-27T08:00:00Z'),
        utc('2027-03-28T07:00:00Z'), // last Sunday of March: CEST
        utc('2027-03-29T07:00:00Z'),
        utc('2027-03-30T07:00:00Z'),
      ]);
      const night = (
        await t.api
          .post('/trainer/slot-series')
          .send({
            weekdays: [6, 7, 1],
            startTime: '02:30',
            validFrom: '2027-03-27',
            validUntil: '2027-03-29',
          })
          .expect(201)
      ).body;
      expect((await seriesSlots(night.id)).map((s) => s.startsAt.toISOString())).toEqual([
        utc('2027-03-27T01:30:00Z'),
        utc('2027-03-29T00:30:00Z'),
      ]);
    });

    it('open-ended series fill SLOT_HORIZON_WEEKS; the nightly run is idempotent and extends day by day', async () => {
      const t = await trainer(ctx);
      const series = (
        await t.api
          .post('/trainer/slot-series')
          .send({ weekdays: [1, 3], startTime: '18:00', validFrom: '2026-10-01' })
          .expect(201)
      ).body;
      // Mon 5 Oct 18:00 (still ahead) … Mon 30 Nov (5 Oct + 56 days): 9 Mondays + 8 Wednesdays
      const slots = await seriesSlots(series.id);
      expect(slots).toHaveLength(17);
      expect(slots[0]!.startsAt.toISOString()).toBe(local('2026-10-05', '18:00').toISOString());
      expect(slots.at(-1)!.startsAt.toISOString()).toBe(local('2026-11-30', '18:00').toISOString());

      const svc = ctx.app.get(SeriesService);
      expect(await svc.materializeAll()).toBe(0);

      // a slot the trainer deleted is not recreated by the nightly run
      await t.api.delete(`/trainer/slots/${slots[3]!.id}`).expect(204);
      expect(await svc.materializeAll()).toBe(0);
      expect(await seriesSlots(series.id)).toHaveLength(16);

      ctx.clock.set('2026-10-08T01:30:00Z'); // Thu 03:30: horizon moves to Thu 3 Dec → adds Wed 2 Dec
      expect(await svc.materializeAll()).toBe(1);
      expect((await seriesSlots(series.id)).at(-1)!.startsAt.toISOString()).toBe(
        local('2026-12-02', '18:00').toISOString(),
      );
    });

    it('rejects a series that overlaps other slots (409 with conflicts) and creates nothing', async () => {
      const t = await trainer(ctx);
      await addSlot(ctx, t.user.id, local('2026-10-07', '18:30'));
      const res = await t.api
        .post('/trainer/slot-series')
        .send({
          weekdays: [1, 3],
          startTime: '18:00',
          validFrom: '2026-10-05',
          validUntil: '2026-10-14',
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'SLOT_OVERLAP',
        details: { conflicts: [local('2026-10-07', '18:00').toISOString()] },
      });
      expect(await ctx.prisma.slotSeries.count()).toBe(0);
      expect(await ctx.prisma.slot.count()).toBe(1);
    });

    it('validates series input (autoBook needs a client; foreign clients 404)', async () => {
      const t = await trainer(ctx);
      const t2 = await trainer(ctx, 'Other');
      const foreign = await clientOf(ctx, t2.user.id);
      await t.api
        .post('/trainer/slot-series')
        .send({ weekdays: [1], startTime: '18:00', validFrom: '2026-10-05', autoBook: true })
        .expect(400);
      await t.api
        .post('/trainer/slot-series')
        .send({ weekdays: [1], startTime: '18:15', validFrom: '2026-10-05' })
        .expect(400);
      await t.api
        .post('/trainer/slot-series')
        .send({
          weekdays: [1],
          startTime: '18:00',
          validFrom: '2026-10-05',
          reservedForClientId: foreign.user.id,
        })
        .expect(404);
    });

    it('edits only future unbooked slots; booked and past slots stay', async () => {
      const w = await world(ctx);
      const series = (
        await w.trainer.api
          .post('/trainer/slot-series')
          .send({
            weekdays: [2, 4],
            startTime: '18:00',
            validFrom: '2026-10-01',
            validUntil: '2026-10-22',
          })
          .expect(201)
      ).body;
      // Tue 6, Thu 8, Tue 13, Thu 15, Tue 20, Thu 22
      const before = await seriesSlots(series.id);
      expect(before).toHaveLength(6);
      await w.client.api.post('/client/sessions').send({ slotId: before[2]!.id }).expect(201); // Tue 13

      ctx.clock.set(local('2026-10-09', '10:00')); // Tue 6 + Thu 8 are now past
      const res = await w.trainer.api
        .patch(`/trainer/slot-series/${series.id}`)
        .send({ startTime: '19:30', weekdays: [2] })
        .expect(200);
      expect(res.body).toMatchObject({ startTime: '19:30', weekdays: [2] });

      const after = (await seriesSlots(series.id)).map((s) => s.startsAt.toISOString());
      expect(after).toEqual([
        local('2026-10-06', '18:00').toISOString(), // past, untouched
        local('2026-10-08', '18:00').toISOString(), // past, untouched
        local('2026-10-13', '18:00').toISOString(), // booked, untouched
        local('2026-10-13', '19:30').toISOString(), // new (does not overlap the booked 18:00)
        local('2026-10-20', '19:30').toISOString(),
      ]);

      await w.trainer.api
        .patch(`/trainer/slot-series/${series.id}`)
        .send({ validUntil: '2026-09-01' })
        .expect(400);
      await w.trainer.api.patch(`/trainer/slot-series/${series.id}`).send({}).expect(400);
    });

    it('deleting a series removes future unbooked slots and keeps booked/past ones as standalone slots', async () => {
      const w = await world(ctx);
      const series = (
        await w.trainer.api
          .post('/trainer/slot-series')
          .send({
            weekdays: [2],
            startTime: '18:00',
            validFrom: '2026-10-01',
            validUntil: '2026-10-27',
          })
          .expect(201)
      ).body;
      const slots = await seriesSlots(series.id); // 6, 13, 20, 27
      await w.client.api.post('/client/sessions').send({ slotId: slots[2]!.id }).expect(201);
      ctx.clock.set(local('2026-10-07', '10:00'));

      await w.trainer.api.delete(`/trainer/slot-series/${series.id}`).expect(204);
      const remaining = await ctx.prisma.slot.findMany({ orderBy: { startsAt: 'asc' } });
      expect(remaining.map((s) => [s.startsAt.toISOString(), s.seriesId])).toEqual([
        [local('2026-10-06', '18:00').toISOString(), null],
        [local('2026-10-20', '18:00').toISOString(), null],
      ]);
      const list = await w.trainer.api.get('/trainer/slot-series').expect(200);
      expect(list.body).toEqual([]);
      await w.trainer.api.delete(`/trainer/slot-series/${series.id}`).expect(404);
    });

    it('autoBook books reserved slots while the package lasts and never re-books a cancellation', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const pkg = await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: c.user.id,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
        total: 3,
      });
      const series = (
        await t.api
          .post('/trainer/slot-series')
          .send({
            weekdays: [2, 4],
            startTime: '07:00',
            validFrom: '2026-10-01',
            validUntil: '2026-11-30',
            reservedForClientId: c.user.id,
            autoBook: true,
          })
          .expect(201)
      ).body;
      expect(series.reservedFor).toMatchObject({ id: c.user.id });

      const booked = () =>
        ctx.prisma.session.findMany({
          where: { clientId: c.user.id },
          orderBy: { startsAt: 'asc' },
        });
      let sessions = await booked();
      expect(sessions.map((s) => s.startsAt.toISOString())).toEqual(
        ['2026-10-06', '2026-10-08', '2026-10-13'].map((d) => local(d, '07:00').toISOString()),
      );
      expect(sessions.every((s) => s.packageId === pkg.id && s.createdById === t.user.id)).toBe(
        true,
      );

      // the client cancels Oct 8 (> 6h ahead): the practice comes back, the cron books the NEXT slot instead
      await c.api.post(`/client/sessions/${sessions[1]!.id}/cancel`).expect(200);
      const autoBook = ctx.app.get(AutoBookService);
      expect(await autoBook.run()).toBe(1);
      sessions = (await booked()).filter((s) => s.status === 'BOOKED');
      expect(sessions.map((s) => s.startsAt.toISOString())).toEqual(
        ['2026-10-06', '2026-10-13', '2026-10-15'].map((d) => local(d, '07:00').toISOString()),
      );
      expect(await autoBook.run()).toBe(0);

      // a new November package (added through the API) books November right away
      await t.api
        .post(`/trainer/clients/${c.user.id}/packages`)
        .send({ name: 'November', totalPractices: 2, validFrom: '2026-11-01' })
        .expect(201);
      const november = (await booked()).filter((s) => s.startsAt >= local('2026-11-01', '00:00'));
      expect(november.map((s) => s.startsAt.toISOString())).toEqual(
        ['2026-11-03', '2026-11-05'].map((d) => local(d, '07:00').toISOString()),
      );
    });

    it('a reserved series without autoBook only reserves', async () => {
      const w = await world(ctx);
      await w.trainer.api
        .post('/trainer/slot-series')
        .send({
          weekdays: [2],
          startTime: '07:00',
          validFrom: '2026-10-01',
          validUntil: '2026-10-31',
          reservedForClientId: w.client.user.id,
        })
        .expect(201);
      expect(await ctx.prisma.session.count()).toBe(0);
      expect(
        await ctx.prisma.slot.count({ where: { reservedForClientId: w.client.user.id } }),
      ).toBe(4);
    });
  });
});
