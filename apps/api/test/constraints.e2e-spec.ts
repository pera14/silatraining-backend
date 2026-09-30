import { PackageUsageService } from '../src/common/package-usage/package-usage.service';
import { isConstraintViolation } from '../src/common/prisma/prisma-errors';
import { createTestApp, createUser, resetDb, type TestContext } from './setup/app';

/** The raw SQL migration (SPEC §3): the database itself refuses invalid schedules. */
describe('database constraints (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
  });

  const slotAt = (trainerId: string, iso: string, minutes = 60) =>
    ctx.prisma.slot.create({
      data: {
        trainerId,
        startsAt: new Date(iso),
        endsAt: new Date(Date.parse(iso) + minutes * 60_000),
      },
    });

  async function catchErr(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error('expected the database to reject this write');
  }

  it('rejects overlapping slots of the same trainer (exclusion), but not of different trainers', async () => {
    const t1 = await createUser(ctx.prisma, 'TRAINER');
    const t2 = await createUser(ctx.prisma, 'TRAINER');
    await slotAt(t1.id, '2026-10-05T07:00:00Z'); // 09:00 Belgrade
    const err = await catchErr(slotAt(t1.id, '2026-10-05T07:30:00Z')); // 09:30 overlaps
    expect(isConstraintViolation(err, 'exclusion', 'slot_no_overlap')).toBe(true);
    await slotAt(t1.id, '2026-10-05T08:00:00Z'); // back-to-back is fine
    await slotAt(t2.id, '2026-10-05T07:30:00Z'); // other trainer is fine
  });

  it('rejects slots not starting on :00/:30 or not exactly 60 minutes', async () => {
    const t = await createUser(ctx.prisma, 'TRAINER');
    expect(
      isConstraintViolation(
        await catchErr(slotAt(t.id, '2026-10-05T07:15:00Z')),
        'check',
        'slot_start',
      ),
    ).toBe(true);
    expect(
      isConstraintViolation(
        await catchErr(slotAt(t.id, '2026-10-05T07:00:30Z')),
        'check',
        'slot_start',
      ),
    ).toBe(true);
    expect(
      isConstraintViolation(
        await catchErr(slotAt(t.id, '2026-10-05T07:00:00Z', 45)),
        'check',
        'slot_len',
      ),
    ).toBe(true);
    await slotAt(t.id, '2026-10-05T09:30:00Z');
  });

  it('allows one live practice per slot; a cancelled one frees the slot', async () => {
    const t = await createUser(ctx.prisma, 'TRAINER');
    const c = await createUser(ctx.prisma, 'CLIENT');
    const slot = await slotAt(t.id, '2026-10-05T07:00:00Z');
    const book = () =>
      ctx.prisma.session.create({
        data: {
          slotId: slot.id,
          trainerId: t.id,
          clientId: c.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          createdById: c.id,
        },
      });
    const first = await book();
    const err = await catchErr(book());
    expect(isConstraintViolation(err, 'unique', 'session_one_per_slot')).toBe(true);
    await ctx.prisma.session.update({
      where: { id: first.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await book();
  });

  it('keeps practice history when a slot is deleted', async () => {
    const t = await createUser(ctx.prisma, 'TRAINER');
    const c = await createUser(ctx.prisma, 'CLIENT');
    const slot = await slotAt(t.id, '2026-10-05T07:00:00Z');
    const s = await ctx.prisma.session.create({
      data: {
        slotId: slot.id,
        trainerId: t.id,
        clientId: c.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        createdById: c.id,
        status: 'CANCELLED',
      },
    });
    await ctx.prisma.slot.delete({ where: { id: slot.id } });
    expect((await ctx.prisma.session.findUniqueOrThrow({ where: { id: s.id } })).slotId).toBeNull();
  });

  it('allows one active join link and one pinned note per client', async () => {
    const t = await createUser(ctx.prisma, 'TRAINER');
    const c = await createUser(ctx.prisma, 'CLIENT');
    await ctx.prisma.joinLink.create({ data: { trainerId: t.id, tokenHash: 'a' } });
    expect(
      isConstraintViolation(
        await catchErr(ctx.prisma.joinLink.create({ data: { trainerId: t.id, tokenHash: 'b' } })),
        'unique',
      ),
    ).toBe(true);
    await ctx.prisma.joinLink.create({
      data: { trainerId: t.id, tokenHash: 'c', revokedAt: new Date() },
    });

    await ctx.prisma.clientNote.create({
      data: { trainerId: t.id, clientId: c.id, body: 'x', pinned: true },
    });
    expect(
      isConstraintViolation(
        await catchErr(
          ctx.prisma.clientNote.create({
            data: { trainerId: t.id, clientId: c.id, body: 'y', pinned: true },
          }),
        ),
        'unique',
        'client_note_one_pinned',
      ),
    ).toBe(true);
    await ctx.prisma.clientNote.create({ data: { trainerId: t.id, clientId: c.id, body: 'z' } });
  });

  it('package_usage: no-show uses a practice, a returned cancellation does not, extension moves the end', async () => {
    const t = await createUser(ctx.prisma, 'TRAINER');
    const c = await createUser(ctx.prisma, 'CLIENT');
    const pkg = await ctx.prisma.package.create({
      data: {
        clientId: c.id,
        trainerId: t.id,
        name: '10 practices / month',
        totalPractices: 10,
        adjustment: 1,
        validFrom: new Date('2026-10-01'),
        validUntil: new Date('2026-10-31'),
        extendedUntil: new Date('2026-11-04'),
      },
    });
    const statuses = [
      ['ATTENDED', false],
      ['NO_SHOW', false],
      ['BOOKED', false],
      ['CANCELLED', true],
      ['CANCELLED', false],
    ] as const;
    for (const [i, [status, returned]] of statuses.entries()) {
      const slot = await slotAt(t.id, `2026-10-0${i + 1}T07:00:00Z`);
      await ctx.prisma.session.create({
        data: {
          slotId: slot.id,
          trainerId: t.id,
          clientId: c.id,
          packageId: pkg.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          createdById: c.id,
          status,
          practiceReturned: returned,
        },
      });
    }
    const usage = ctx.app.get(PackageUsageService);
    expect((await usage.getUsage([pkg.id])).get(pkg.id)).toEqual({
      available: 11,
      used: 4,
      left: 7,
      effectiveUntil: '2026-11-04',
    });
    expect(await usage.findActivePackage(c.id, new Date('2026-11-03T12:00:00Z'))).toMatchObject({
      packageId: pkg.id,
    });
    expect(await usage.findActivePackage(c.id, new Date('2026-11-05T12:00:00Z'))).toBeNull();
    expect(await usage.findActivePackage(c.id, new Date('2026-09-30T12:00:00Z'))).toBeNull();
  });
});
