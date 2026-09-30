import { ClientDetail, ClientListItem, Package, PackageType } from '@sila/contracts';
import { z } from 'zod';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { addPackage, addSlot, clientOf, left, local, trainer, world } from './scheduling/fixtures';

describe('packages and clients (e2e)', () => {
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

  // ------------------------------------------------------------------ package types

  describe('package types', () => {
    it('CRUD with archive instead of delete', async () => {
      const t = await trainer(ctx);
      const created = await t.api
        .post('/trainer/package-types')
        .send({ name: '10 practices / month', practices: 10, priceRsd: 12000 })
        .expect(201);
      const type = PackageType.parse(created.body);
      expect(type).toMatchObject({ validityMonths: 1, priceRsd: 12000, archivedAt: null });

      await t.api.get(`/trainer/package-types/${type.id}`).expect(200);
      let res = await t.api
        .patch(`/trainer/package-types/${type.id}`)
        .send({ name: '8 practices', practices: 8 })
        .expect(200);
      expect(res.body).toMatchObject({ name: '8 practices', practices: 8 });

      await t.api.delete(`/trainer/package-types/${type.id}`).expect(204);
      expect((await t.api.get('/trainer/package-types').expect(200)).body).toEqual([]);
      res = await t.api.get('/trainer/package-types?includeArchived=true').expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].archivedAt).not.toBeNull();

      res = await t.api
        .patch(`/trainer/package-types/${type.id}`)
        .send({ archived: false })
        .expect(200);
      expect(res.body.archivedAt).toBeNull();

      const t2 = await trainer(ctx, 'Other');
      await t2.api.get(`/trainer/package-types/${type.id}`).expect(404);
      await t2.api.patch(`/trainer/package-types/${type.id}`).send({ name: 'x' }).expect(404);
      await t2.api.delete(`/trainer/package-types/${type.id}`).expect(404);
      await t.api.post('/trainer/package-types').send({ name: '', practices: 0 }).expect(400);
    });
  });

  // ------------------------------------------------------------------ packages

  describe('adding packages', () => {
    it('copies a type and sets validUntil = start + 1 month − 1 day', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const type = (
        await t.api
          .post('/trainer/package-types')
          .send({ name: '10 practices / month', practices: 10, priceRsd: 12000 })
          .expect(201)
      ).body;

      const res = await t.api
        .post(`/trainer/clients/${c.user.id}/packages`)
        .send({ packageTypeId: type.id, validFrom: '2026-10-05' })
        .expect(201);
      expect(Package.parse(res.body)).toMatchObject({
        name: '10 practices / month',
        totalPractices: 10,
        priceRsd: 12000,
        validFrom: '2026-10-05',
        validUntil: '2026-11-04',
        extendedUntil: null,
        paymentStatus: 'UNPAID',
        paidAt: null,
        usage: { available: 10, used: 0, left: 10, effectiveUntil: '2026-11-04' },
        isActive: true,
      });

      // month-end start: Jan 31 + 1 month is clamped to Feb 28, minus a day
      const jan = await t.api
        .post(`/trainer/clients/${c.user.id}/packages`)
        .send({ packageTypeId: type.id, validFrom: '2027-01-31', name: 'Winter', priceRsd: null })
        .expect(201);
      expect(jan.body).toMatchObject({
        name: 'Winter',
        validUntil: '2027-02-27',
        priceRsd: null,
        isActive: false,
      });

      const paid = await t.api
        .post(`/trainer/clients/${c.user.id}/packages`)
        .send({
          name: 'Custom',
          totalPractices: 4,
          validFrom: '2026-12-01',
          paymentStatus: 'PAID',
          paymentMethod: 'CASH',
        })
        .expect(201);
      expect(paid.body).toMatchObject({
        packageTypeId: null,
        validUntil: '2026-12-31',
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        paidAt: '2026-10-05T08:00:00.000Z',
      });

      const list = z
        .array(Package)
        .parse((await t.api.get(`/trainer/clients/${c.user.id}/packages`).expect(200)).body);
      expect(list.map((p) => p.validFrom)).toEqual(['2027-01-31', '2026-12-01', '2026-10-05']);
    });

    it('validates the type, the client and the body', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const t2 = await trainer(ctx, 'Other');
      const c2 = await clientOf(ctx, t2.user.id);
      const foreignType = (
        await t2.api.post('/trainer/package-types').send({ name: 'X', practices: 5 }).expect(201)
      ).body;
      const archived = (
        await t.api.post('/trainer/package-types').send({ name: 'Old', practices: 5 }).expect(201)
      ).body;
      await t.api.delete(`/trainer/package-types/${archived.id}`).expect(204);

      for (const packageTypeId of [foreignType.id, archived.id]) {
        await t.api
          .post(`/trainer/clients/${c.user.id}/packages`)
          .send({ packageTypeId, validFrom: '2026-10-05' })
          .expect(404);
      }
      await t.api
        .post(`/trainer/clients/${c2.user.id}/packages`)
        .send({ name: 'X', totalPractices: 5, validFrom: '2026-10-05' })
        .expect(404);
      await t.api
        .post(`/trainer/clients/${c.user.id}/packages`)
        .send({ validFrom: '2026-10-05' })
        .expect(400);
      await t.api.get(`/trainer/clients/${c2.user.id}/packages`).expect(404);
    });

    it('marks paid in one tap and back to unpaid', async () => {
      const w = await world(ctx);
      const unpaid = await addPackage(ctx, {
        trainerId: w.trainer.user.id,
        clientId: w.client.user.id,
        validFrom: '2026-11-01',
        validUntil: '2026-11-30',
      });
      let res = await w.trainer.api
        .patch(`/trainer/packages/${unpaid.id}`)
        .send({ paymentStatus: 'PAID', paymentMethod: 'TRANSFER', paymentNote: 'Invoice 12' })
        .expect(200);
      expect(res.body).toMatchObject({
        paymentStatus: 'PAID',
        paymentMethod: 'TRANSFER',
        paidAt: '2026-10-05T08:00:00.000Z',
        paymentNote: 'Invoice 12',
      });
      res = await w.trainer.api
        .patch(`/trainer/packages/${unpaid.id}`)
        .send({ paymentStatus: 'UNPAID' })
        .expect(200);
      expect(res.body).toMatchObject({
        paymentStatus: 'UNPAID',
        paymentMethod: null,
        paidAt: null,
      });

      const t2 = await trainer(ctx, 'Other');
      await t2.api
        .patch(`/trainer/packages/${unpaid.id}`)
        .send({ paymentStatus: 'PAID' })
        .expect(404);
    });
  });

  // ------------------------------------------------------------------ expiry + extension

  describe('expiry and extension', () => {
    it('expires at validUntil; an approved extension up to start + 5 weeks − 1 day covers later practices', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const pkg = (
        await t.api
          .post(`/trainer/clients/${c.user.id}/packages`)
          .send({ name: '10 / month', totalPractices: 10, validFrom: '2026-10-05' })
          .expect(201)
      ).body; // valid until 2026-11-04
      const lastDay = await addSlot(ctx, t.user.id, local('2026-11-04', '20:00'));
      const dayAfter = await addSlot(ctx, t.user.id, local('2026-11-05', '07:00'));

      await c.api.post('/client/sessions').send({ slotId: lastDay.id }).expect(201);
      let res = await c.api.post('/client/sessions').send({ slotId: dayAfter.id }).expect(402);
      expect(res.body.code).toBe('NO_PACKAGE');

      // limit: 2026-10-05 + 5 weeks − 1 day = 2026-11-08
      res = await t.api
        .post(`/trainer/packages/${pkg.id}/extend`)
        .send({ extendedUntil: '2026-11-09', note: 'Sick' })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'EXTENSION_LIMIT',
        details: { maxExtendedUntil: '2026-11-08' },
      });
      await t.api
        .post(`/trainer/packages/${pkg.id}/extend`)
        .send({ extendedUntil: '2026-11-08' })
        .expect(400);
      await t.api
        .post(`/trainer/packages/${pkg.id}/extend`)
        .send({ extendedUntil: '2026-11-03', note: 'Too short' })
        .expect(400);

      res = await t.api
        .post(`/trainer/packages/${pkg.id}/extend`)
        .send({ extendedUntil: '2026-11-08', note: 'Was sick for a week' })
        .expect(200);
      expect(res.body).toMatchObject({
        extendedUntil: '2026-11-08',
        extensionNote: 'Was sick for a week',
        extensionApprovedAt: '2026-10-05T08:00:00.000Z',
        usage: { effectiveUntil: '2026-11-08' },
      });
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'package.extend', entityId: pkg.id } }),
      ).toBe(1);

      await c.api.post('/client/sessions').send({ slotId: dayAfter.id }).expect(201);
      const home = (await c.api.get('/client/home').expect(200)).body;
      expect(home).toMatchObject({ validUntil: '2026-11-08', extended: true, left: 8 });

      // and after the extension the package is expired
      ctx.clock.set(local('2026-11-09', '10:00'));
      expect((await c.api.get('/client/home').expect(200)).body.hasActivePackage).toBe(false);
    });
  });

  // ------------------------------------------------------------------ adjust

  describe('adjust', () => {
    it('adds or removes practices with a note, audit-logged, never below zero left', async () => {
      const w = await world(ctx);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'));
      await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(201);

      let res = await w.trainer.api
        .post(`/trainer/packages/${w.pkg.id}/adjust`)
        .send({ delta: 2, note: 'Bonus for referral' })
        .expect(200);
      expect(res.body).toMatchObject({
        adjustment: 2,
        usage: { available: 12, used: 1, left: 11 },
      });

      res = await w.trainer.api
        .post(`/trainer/packages/${w.pkg.id}/adjust`)
        .send({ delta: -12, note: 'Too many' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      res = await w.trainer.api
        .post(`/trainer/packages/${w.pkg.id}/adjust`)
        .send({ delta: -11, note: 'Refund' })
        .expect(200);
      expect(res.body.usage.left).toBe(0);
      expect(await left(ctx, w.pkg.id)).toBe(0);

      await w.trainer.api
        .post(`/trainer/packages/${w.pkg.id}/adjust`)
        .send({ delta: 0, note: 'x' })
        .expect(400);
      await w.trainer.api
        .post(`/trainer/packages/${w.pkg.id}/adjust`)
        .send({ delta: 1 })
        .expect(400);

      const logs = await ctx.prisma.auditLog.findMany({
        where: { action: 'package.adjust', entityId: w.pkg.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(logs.map((l) => l.meta)).toEqual([
        { delta: 2, note: 'Bonus for referral', adjustment: 2 },
        { delta: -11, note: 'Refund', adjustment: -9 },
      ]);
    });
  });

  // ------------------------------------------------------------------ client side

  it('GET /client/packages lists own packages without the trainer-only payment note', async () => {
    const w = await world(ctx);
    await ctx.prisma.package.update({ where: { id: w.pkg.id }, data: { paymentNote: 'private' } });
    const other = await clientOf(ctx, w.trainer.user.id);
    await addPackage(ctx, {
      trainerId: w.trainer.user.id,
      clientId: other.user.id,
      validFrom: '2026-10-01',
      validUntil: '2026-10-31',
    });
    const res = await w.client.api.get('/client/packages').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: w.pkg.id, isActive: true, usage: { left: 10 } });
    expect(res.body[0]).not.toHaveProperty('paymentNote');
  });

  // ------------------------------------------------------------------ clients

  describe('trainer clients', () => {
    async function roster() {
      const t = await trainer(ctx);
      const tid = t.user.id;
      const mk = (firstName: string, opts: { archived?: boolean } = {}) =>
        clientOf(ctx, tid, { firstName, lastName: 'Test', ...opts });
      const healthy = await mk('Ana');
      await addPackage(ctx, {
        trainerId: tid,
        clientId: healthy.user.id,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
        paid: true,
      });
      const unpaid = await mk('Bojan');
      await addPackage(ctx, {
        trainerId: tid,
        clientId: unpaid.user.id,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
      });
      const low = await mk('Ceca');
      await addPackage(ctx, {
        trainerId: tid,
        clientId: low.user.id,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
        paid: true,
        total: 2,
      });
      const expiring = await mk('Dragan');
      await addPackage(ctx, {
        trainerId: tid,
        clientId: expiring.user.id,
        validFrom: '2026-09-09',
        validUntil: '2026-10-08',
        paid: true,
      });
      const none = await mk('Ema');
      const archived = await mk('Filip', { archived: true });
      return { t, healthy, unpaid, low, expiring, none, archived };
    }

    it('lists clients with the active package, next practice and flags', async () => {
      const r = await roster();
      const slot = await addSlot(ctx, r.t.user.id, local('2026-10-07', '18:00'));
      await r.healthy.api.post('/client/sessions').send({ slotId: slot.id }).expect(201);

      const res = await r.t.api.get('/trainer/clients').expect(200);
      const list = z.array(ClientListItem).parse(res.body);
      expect(list.map((c) => [c.firstName, c.flags])).toEqual([
        ['Ana', []],
        ['Bojan', ['UNPAID']],
        ['Ceca', ['LOW']],
        ['Dragan', ['EXPIRING']],
        ['Ema', ['NO_PACKAGE']],
      ]);
      expect(list[0]).toMatchObject({
        activePackage: { usage: { left: 9 } },
        nextPractice: { startsAt: slot.startsAt.toISOString() },
        archived: false,
      });
      expect(list[4]).toMatchObject({ activePackage: null, nextPractice: null });

      const unpaidOnly = await r.t.api.get('/trainer/clients?flag=UNPAID').expect(200);
      expect(unpaidOnly.body.map((c: { firstName: string }) => c.firstName)).toEqual(['Bojan']);
      const search = await r.t.api.get('/trainer/clients?q=dra%20test').expect(200);
      expect(search.body.map((c: { firstName: string }) => c.firstName)).toEqual(['Dragan']);
      const all = await r.t.api.get('/trainer/clients?includeArchived=true').expect(200);
      expect(all.body).toHaveLength(6);
      await r.t.api.get('/trainer/clients?flag=NOPE').expect(400);

      // another trainer sees none of them
      const t2 = await trainer(ctx, 'Other');
      expect((await t2.api.get('/trainer/clients').expect(200)).body).toEqual([]);
    });

    it('keeps UNPAID for an expired unpaid package', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: c.user.id,
        validFrom: '2026-08-01',
        validUntil: '2026-08-31',
      });
      const res = await t.api.get('/trainer/clients').expect(200);
      expect(res.body[0].flags).toEqual(['UNPAID', 'NO_PACKAGE']);
    });

    it('shows detail with email and pinned note, and archives / unarchives', async () => {
      const w = await world(ctx);
      await ctx.prisma.clientNote.create({
        data: {
          clientId: w.client.user.id,
          trainerId: w.trainer.user.id,
          body: 'Shoulder',
          pinned: true,
        },
      });
      const res = await w.trainer.api.get(`/trainer/clients/${w.client.user.id}`).expect(200);
      expect(ClientDetail.parse(res.body)).toMatchObject({
        id: w.client.user.id,
        email: w.client.user.email,
        pinnedNote: { body: 'Shoulder' },
        activePackage: { id: w.pkg.id },
      });

      let upd = await w.trainer.api
        .patch(`/trainer/clients/${w.client.user.id}`)
        .send({ archived: true })
        .expect(200);
      expect(upd.body.archived).toBe(true);
      expect((await w.trainer.api.get('/trainer/clients').expect(200)).body).toEqual([]);
      // an archived client can no longer book
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
      await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(404);

      upd = await w.trainer.api
        .patch(`/trainer/clients/${w.client.user.id}`)
        .send({ archived: false })
        .expect(200);
      expect(upd.body.archived).toBe(false);
      await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(201);

      const t2 = await trainer(ctx, 'Other');
      await t2.api.get(`/trainer/clients/${w.client.user.id}`).expect(404);
      await t2.api
        .patch(`/trainer/clients/${w.client.user.id}`)
        .send({ archived: true })
        .expect(404);
    });
  });
});
