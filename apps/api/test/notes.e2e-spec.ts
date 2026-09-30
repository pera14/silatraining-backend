import { Note } from '@sila/contracts';
import { z } from 'zod';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { clientOf, trainer } from './scheduling/fixtures';

const Notes = z.array(Note);

describe('client notes (e2e)', () => {
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

  async function setup() {
    const t = await trainer(ctx);
    const c = await clientOf(ctx, t.user.id);
    const add = async (body: string, pinned?: boolean) =>
      Note.parse(
        (await t.api.post(`/trainer/clients/${c.user.id}/notes`).send({ body, pinned }).expect(201))
          .body,
      );
    const list = async () =>
      Notes.parse((await t.api.get(`/trainer/clients/${c.user.id}/notes`).expect(200)).body);
    return { t, c, add, list };
  }

  it('creates, lists (pinned first, then newest), edits and deletes notes', async () => {
    const { t, c, add, list } = await setup();
    const first = await add('  Bad left knee — no deep squats  ');
    expect(first).toMatchObject({
      clientId: c.user.id,
      body: 'Bad left knee — no deep squats',
      pinned: false,
    });
    const second = await add('Prefers mornings');
    const pinned = await add('Goal: 5 kg by December', true);

    expect((await list()).map((n) => n.id)).toEqual([pinned.id, second.id, first.id]);

    const edited = Note.parse(
      (await t.api.patch(`/trainer/notes/${first.id}`).send({ body: 'Knee OK now' }).expect(200))
        .body,
    );
    expect(edited.body).toBe('Knee OK now');
    expect(Date.parse(edited.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));

    await t.api.delete(`/trainer/notes/${second.id}`).expect(204);
    await t.api.delete(`/trainer/notes/${second.id}`).expect(404);
    expect((await list()).map((n) => n.id)).toEqual([pinned.id, first.id]);
  });

  it('keeps exactly one pinned note per client: pinning another unpins the previous one', async () => {
    const { t, add, list } = await setup();
    const a = await add('A', true);
    const b = await add('B', true); // create pinned
    expect((await list()).filter((n) => n.pinned).map((n) => n.id)).toEqual([b.id]);

    await t.api.patch(`/trainer/notes/${a.id}`).send({ pinned: true }).expect(200); // pin via edit
    expect((await list()).filter((n) => n.pinned).map((n) => n.id)).toEqual([a.id]);

    await t.api.patch(`/trainer/notes/${a.id}`).send({ pinned: false }).expect(200);
    expect((await list()).filter((n) => n.pinned)).toEqual([]);

    // re-pinning the pinned note is a no-op, not a conflict
    await t.api.patch(`/trainer/notes/${b.id}`).send({ pinned: true }).expect(200);
    await t.api.patch(`/trainer/notes/${b.id}`).send({ pinned: true }).expect(200);
    expect((await list()).filter((n) => n.pinned).map((n) => n.id)).toEqual([b.id]);
  });

  it('concurrent pins of different notes end with one pinned note and no errors', async () => {
    const { t, add, list } = await setup();
    const notes = await Promise.all(['1', '2', '3', '4', '5'].map((b) => add(b)));
    const results = await Promise.all(
      notes.map((n) => t.api.patch(`/trainer/notes/${n.id}`).send({ pinned: true })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await list()).filter((n) => n.pinned)).toHaveLength(1);
  });

  it('pins are per client', async () => {
    const t = await trainer(ctx);
    const c1 = await clientOf(ctx, t.user.id);
    const c2 = await clientOf(ctx, t.user.id);
    await t.api
      .post(`/trainer/clients/${c1.user.id}/notes`)
      .send({ body: 'x', pinned: true })
      .expect(201);
    await t.api
      .post(`/trainer/clients/${c2.user.id}/notes`)
      .send({ body: 'y', pinned: true })
      .expect(201);
    expect(await ctx.prisma.clientNote.count({ where: { pinned: true } })).toBe(2);
  });

  it('validates input', async () => {
    const { t, c, add } = await setup();
    const n = await add('x');
    for (const body of [{}, { body: '' }, { body: '   ' }, { body: 'x'.repeat(5001) }]) {
      const res = await t.api.post(`/trainer/clients/${c.user.id}/notes`).send(body).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    await t.api.patch(`/trainer/notes/${n.id}`).send({}).expect(400);
    await t.api.patch('/trainer/notes/not-a-uuid').send({ body: 'x' }).expect(400);
  });

  it('works for archived clients (the client detail stays reachable)', async () => {
    const { c, add, list } = await setup();
    await ctx.prisma.trainerClient.update({
      where: { clientId: c.user.id },
      data: { archivedAt: new Date() },
    });
    await add('Left for the summer');
    expect(await list()).toHaveLength(1);
  });

  it("cross-trainer: B cannot list, add, edit, pin or delete A's notes", async () => {
    const a = await trainer(ctx, 'A');
    const b = await trainer(ctx, 'B');
    const c = await clientOf(ctx, a.user.id);
    const note = (
      await a.api
        .post(`/trainer/clients/${c.user.id}/notes`)
        .send({ body: 'private', pinned: true })
    ).body as Note;

    for (const res of [
      await b.api.get(`/trainer/clients/${c.user.id}/notes`),
      await b.api.post(`/trainer/clients/${c.user.id}/notes`).send({ body: 'x', pinned: true }),
      await b.api.patch(`/trainer/notes/${note.id}`).send({ body: 'hacked' }),
      await b.api.patch(`/trainer/notes/${note.id}`).send({ pinned: false }),
      await b.api.delete(`/trainer/notes/${note.id}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    const row = await ctx.prisma.clientNote.findUniqueOrThrow({ where: { id: note.id } });
    expect(row).toMatchObject({ body: 'private', pinned: true });
    expect(await ctx.prisma.clientNote.count()).toBe(1);
  });
});
