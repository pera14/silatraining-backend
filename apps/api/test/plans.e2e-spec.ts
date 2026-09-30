import { Exercise, Plan } from '@sila/contracts';
import { z } from 'zod';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { addSlot, clientOf, local, trainer, world } from './scheduling/fixtures';
import { addExercise } from './content/helpers';

const Plans = z.array(Plan);
const Exercises = z.array(Exercise);

describe('exercise library + plans (e2e)', () => {
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

  // ------------------------------------------------------------------ exercises

  describe('exercises', () => {
    it('CRUD, search by name or category, DELETE archives', async () => {
      const t = await trainer(ctx);
      const created = Exercise.parse(
        (
          await t.api
            .post('/trainer/exercises')
            .send({
              name: 'Goblet squat',
              category: 'Legs',
              description: 'Slow down',
              videoUrl: 'https://youtu.be/abc',
            })
            .expect(201)
        ).body,
      );
      expect(created).toMatchObject({ name: 'Goblet squat', category: 'Legs', archivedAt: null });
      await t.api
        .post('/trainer/exercises')
        .send({ name: 'Bench press', category: 'Chest' })
        .expect(201);
      await t.api.post('/trainer/exercises').send({ name: 'Plank' }).expect(201);

      const all = Exercises.parse((await t.api.get('/trainer/exercises').expect(200)).body);
      expect(all.map((e) => e.name)).toEqual(['Bench press', 'Goblet squat', 'Plank']);
      const legs = Exercises.parse((await t.api.get('/trainer/exercises?q=LEG').expect(200)).body);
      expect(legs.map((e) => e.name)).toEqual(['Goblet squat']);
      const byName = Exercises.parse(
        (await t.api.get('/trainer/exercises?q=pla').expect(200)).body,
      );
      expect(byName.map((e) => e.name)).toEqual(['Plank']);

      const updated = Exercise.parse(
        (
          await t.api
            .patch(`/trainer/exercises/${created.id}`)
            .send({ name: 'Goblet squat (KB)', category: null, videoUrl: null })
            .expect(200)
        ).body,
      );
      expect(updated).toMatchObject({
        name: 'Goblet squat (KB)',
        category: null,
        videoUrl: null,
        description: 'Slow down',
      });

      await t.api.delete(`/trainer/exercises/${created.id}`).expect(204);
      await t.api.delete(`/trainer/exercises/${created.id}`).expect(204); // idempotent
      expect(
        Exercises.parse((await t.api.get('/trainer/exercises').expect(200)).body).map(
          (e) => e.name,
        ),
      ).toEqual(['Bench press', 'Plank']);
      const withArchived = Exercises.parse(
        (await t.api.get('/trainer/exercises?includeArchived=true').expect(200)).body,
      );
      expect(withArchived).toHaveLength(3);
      const archived = Exercise.parse(
        (await t.api.get(`/trainer/exercises/${created.id}`).expect(200)).body,
      );
      expect(archived.archivedAt).not.toBeNull();
    });

    it('validates input', async () => {
      const t = await trainer(ctx);
      for (const body of [
        {},
        { name: '' },
        { name: 'x'.repeat(121) },
        { name: 'x', videoUrl: 'not a url' },
      ]) {
        expect((await t.api.post('/trainer/exercises').send(body)).status).toBe(400);
      }
      const e = await addExercise(ctx, t.user.id, 'Row');
      expect((await t.api.patch(`/trainer/exercises/${e.id}`).send({})).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ templates

  describe('plan templates', () => {
    it('CRUD with ordered exercises; list(template=true) shows only active templates', async () => {
      const t = await trainer(ctx);
      const [squat, row, plank] = await Promise.all(
        ['Squat', 'Row', 'Plank'].map((n) => addExercise(ctx, t.user.id, n)),
      );
      const a = Plan.parse(
        (await t.api.post('/trainer/plans').send({ name: 'Plan A', notes: 'Strength' }).expect(201))
          .body,
      );
      const b = Plan.parse(
        (await t.api.post('/trainer/plans').send({ name: 'Plan B' }).expect(201)).body,
      );
      expect(a).toMatchObject({ clientId: null, sortOrder: 0, exercises: [] });
      expect(b.sortOrder).toBe(1);

      const withEx = Plan.parse(
        (
          await t.api
            .put(`/trainer/plans/${a.id}/exercises`)
            .send({
              items: [
                { exerciseId: plank!.id, notes: 'Finisher' },
                { exerciseId: squat!.id, sets: 4, reps: '8-10', weight: '40 kg', restSec: 90 },
                { exerciseId: row!.id, sets: 3, reps: '12' },
              ],
            })
            .expect(200)
        ).body,
      );
      expect(withEx.exercises.map((e) => [e.exercise.name, e.sortOrder])).toEqual([
        ['Plank', 0],
        ['Squat', 1],
        ['Row', 2],
      ]);
      expect(withEx.exercises[1]).toMatchObject({
        sets: 4,
        reps: '8-10',
        weight: '40 kg',
        restSec: 90,
        notes: null,
      });

      // reorder = PUT the new order; the old rows are replaced
      const reordered = Plan.parse(
        (
          await t.api
            .put(`/trainer/plans/${a.id}/exercises`)
            .send({ items: [{ exerciseId: squat!.id }, { exerciseId: plank!.id }] })
            .expect(200)
        ).body,
      );
      expect(reordered.exercises.map((e) => e.exercise.name)).toEqual(['Squat', 'Plank']);
      expect(await ctx.prisma.planExercise.count({ where: { planId: a.id } })).toBe(2);

      const renamed = Plan.parse(
        (
          await t.api
            .patch(`/trainer/plans/${a.id}`)
            .send({ name: 'Snaga', sortOrder: 5 })
            .expect(200)
        ).body,
      );
      expect(renamed).toMatchObject({ name: 'Snaga', sortOrder: 5, notes: 'Strength' });
      expect(renamed.exercises).toHaveLength(2);

      const templates = Plans.parse(
        (await t.api.get('/trainer/plans?template=true').expect(200)).body,
      );
      expect(templates.map((p) => p.name)).toEqual(['Plan B', 'Snaga']);

      await t.api.delete(`/trainer/plans/${b.id}`).expect(204);
      expect(
        Plans.parse((await t.api.get('/trainer/plans?template=true').expect(200)).body).map(
          (p) => p.name,
        ),
      ).toEqual(['Snaga']);
      const archived = Plan.parse((await t.api.get(`/trainer/plans/${b.id}`).expect(200)).body);
      expect(archived.archivedAt).not.toBeNull();

      // the plain list is client plans only
      expect((await t.api.get('/trainer/plans').expect(200)).body).toEqual([]);
    });

    it('PUT exercises: foreign or unknown exercises are 404; archived ones only if already in the plan', async () => {
      const t = await trainer(ctx);
      const other = await trainer(ctx, 'Other');
      const mine = await addExercise(ctx, t.user.id, 'Mine');
      const theirs = await addExercise(ctx, other.user.id, 'Theirs');
      const plan = Plan.parse(
        (await t.api.post('/trainer/plans').send({ name: 'P' }).expect(201)).body,
      );

      const res = await t.api
        .put(`/trainer/plans/${plan.id}/exercises`)
        .send({ items: [{ exerciseId: mine.id }, { exerciseId: theirs.id }] })
        .expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND', details: { exerciseIds: [theirs.id] } });
      expect(await ctx.prisma.planExercise.count()).toBe(0); // nothing half-written

      await t.api
        .put(`/trainer/plans/${plan.id}/exercises`)
        .send({ items: [{ exerciseId: mine.id }] })
        .expect(200);
      await t.api.delete(`/trainer/exercises/${mine.id}`).expect(204);
      // already in the plan: reorder/edit still works, and the plan keeps showing it
      const kept = Plan.parse(
        (
          await t.api
            .put(`/trainer/plans/${plan.id}/exercises`)
            .send({ items: [{ exerciseId: mine.id, sets: 2 }] })
            .expect(200)
        ).body,
      );
      expect(kept.exercises.map((e) => e.exercise.name)).toEqual(['Mine']);
      // not in another plan: rejected
      const p2 = Plan.parse(
        (await t.api.post('/trainer/plans').send({ name: 'P2' }).expect(201)).body,
      );
      await t.api
        .put(`/trainer/plans/${p2.id}/exercises`)
        .send({ items: [{ exerciseId: mine.id }] })
        .expect(404);

      // empty list clears the plan
      const cleared = Plan.parse(
        (await t.api.put(`/trainer/plans/${plan.id}/exercises`).send({ items: [] }).expect(200))
          .body,
      );
      expect(cleared.exercises).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ client plans

  describe('client plans', () => {
    it('copying a template is a deep copy: editing the client plan never touches the template', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      const [squat, row] = await Promise.all(
        ['Squat', 'Row'].map((n) => addExercise(ctx, t.user.id, n)),
      );
      const tpl = Plan.parse(
        (
          await t.api
            .post('/trainer/plans')
            .send({ name: 'Plan A', notes: 'Full body' })
            .expect(201)
        ).body,
      );
      await t.api
        .put(`/trainer/plans/${tpl.id}/exercises`)
        .send({ items: [{ exerciseId: squat!.id, sets: 3, reps: '10' }, { exerciseId: row!.id }] })
        .expect(200);

      const copy = Plan.parse(
        (
          await t.api
            .post(`/trainer/clients/${c.user.id}/plans`)
            .send({ fromTemplateId: tpl.id })
            .expect(201)
        ).body,
      );
      expect(copy).toMatchObject({
        clientId: c.user.id,
        name: 'Plan A',
        notes: 'Full body',
        sortOrder: 0,
      });
      expect(copy.id).not.toBe(tpl.id);
      expect(copy.exercises.map((e) => [e.exercise.name, e.sets, e.reps])).toEqual([
        ['Squat', 3, '10'],
        ['Row', null, null],
      ]);

      await t.api
        .put(`/trainer/plans/${copy.id}/exercises`)
        .send({ items: [{ exerciseId: row!.id }] })
        .expect(200);
      await t.api.patch(`/trainer/plans/${copy.id}`).send({ name: 'Ana A' }).expect(200);
      const template = Plan.parse((await t.api.get(`/trainer/plans/${tpl.id}`).expect(200)).body);
      expect(template.name).toBe('Plan A');
      expect(template.exercises.map((e) => e.exercise.name)).toEqual(['Squat', 'Row']);

      // a second copy with overrides goes to the end of the rotation; an empty plan by name
      const b = Plan.parse(
        (
          await t.api
            .post(`/trainer/clients/${c.user.id}/plans`)
            .send({ fromTemplateId: tpl.id, name: 'Plan B', notes: null })
            .expect(201)
        ).body,
      );
      expect(b).toMatchObject({ name: 'Plan B', notes: null, sortOrder: 1 });
      const empty = Plan.parse(
        (
          await t.api
            .post(`/trainer/clients/${c.user.id}/plans`)
            .send({ name: 'Mobility' })
            .expect(201)
        ).body,
      );
      expect(empty).toMatchObject({ exercises: [], sortOrder: 2 });

      const list = Plans.parse(
        (await t.api.get(`/trainer/clients/${c.user.id}/plans`).expect(200)).body,
      );
      expect(list.map((p) => p.name)).toEqual(['Ana A', 'Plan B', 'Mobility']);
      // trainer-wide client plan list
      expect(
        Plans.parse((await t.api.get('/trainer/plans?template=false').expect(200)).body),
      ).toHaveLength(3);
    });

    it('rejects an archived, foreign or client plan as a template, and a body without name/template', async () => {
      const t = await trainer(ctx);
      const other = await trainer(ctx, 'Other');
      const c = await clientOf(ctx, t.user.id);
      const archived = Plan.parse(
        (await t.api.post('/trainer/plans').send({ name: 'Old' }).expect(201)).body,
      );
      await t.api.delete(`/trainer/plans/${archived.id}`).expect(204);
      const foreign = Plan.parse(
        (await other.api.post('/trainer/plans').send({ name: 'X' }).expect(201)).body,
      );
      const clientPlan = Plan.parse(
        (await t.api.post(`/trainer/clients/${c.user.id}/plans`).send({ name: 'A' }).expect(201))
          .body,
      );
      for (const id of [archived.id, foreign.id, clientPlan.id]) {
        const res = await t.api
          .post(`/trainer/clients/${c.user.id}/plans`)
          .send({ fromTemplateId: id })
          .expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      await t.api.post(`/trainer/clients/${c.user.id}/plans`).send({}).expect(400);
    });

    it('booking follows the client plan rotation by sortOrder, and archived plans leave it (Agent A integration)', async () => {
      const w = await world(ctx);
      const t = w.trainer;
      const cid = w.client.user.id;
      const tplA = Plan.parse(
        (await t.api.post('/trainer/plans').send({ name: 'Plan A' }).expect(201)).body,
      );
      const tplB = Plan.parse(
        (await t.api.post('/trainer/plans').send({ name: 'Plan B' }).expect(201)).body,
      );
      const a = Plan.parse(
        (
          await t.api
            .post(`/trainer/clients/${cid}/plans`)
            .send({ fromTemplateId: tplA.id })
            .expect(201)
        ).body,
      );
      const b = Plan.parse(
        (
          await t.api
            .post(`/trainer/clients/${cid}/plans`)
            .send({ fromTemplateId: tplB.id })
            .expect(201)
        ).body,
      );

      const book = async (day: string) => {
        const slot = await addSlot(ctx, t.user.id, local(day, '18:00'));
        const res = await w.client.api
          .post('/client/sessions')
          .send({ slotId: slot.id })
          .expect(201);
        return (await ctx.prisma.session.findUniqueOrThrow({ where: { id: res.body.id } })).planId;
      };
      expect(await book('2026-10-06')).toBe(a.id);
      expect(await book('2026-10-07')).toBe(b.id);
      expect(await book('2026-10-08')).toBe(a.id);

      // B moves before A in the rotation
      await t.api.patch(`/trainer/plans/${b.id}`).send({ sortOrder: 0 }).expect(200);
      await t.api.patch(`/trainer/plans/${a.id}`).send({ sortOrder: 1 }).expect(200);
      expect(await book('2026-10-09')).toBe(b.id); // after A comes B (wraps)

      // archiving B leaves only A
      await t.api.delete(`/trainer/plans/${b.id}`).expect(204);
      expect(await book('2026-10-10')).toBe(a.id);
      expect(await book('2026-10-11')).toBe(a.id);
      // history keeps the archived plan
      expect(await ctx.prisma.session.count({ where: { planId: b.id } })).toBe(2);
    });
  });

  it("cross-trainer: B gets 404 on A's exercises, templates and client plans and sees none of them", async () => {
    const a = await trainer(ctx, 'A');
    const b = await trainer(ctx, 'B');
    const c = await clientOf(ctx, a.user.id);
    const ex = await addExercise(ctx, a.user.id, 'Squat');
    const bEx = await addExercise(ctx, b.user.id, 'B squat');
    const tpl = Plan.parse(
      (await a.api.post('/trainer/plans').send({ name: 'A tpl' }).expect(201)).body,
    );
    const cp = Plan.parse(
      (
        await a.api
          .post(`/trainer/clients/${c.user.id}/plans`)
          .send({ fromTemplateId: tpl.id })
          .expect(201)
      ).body,
    );

    for (const res of [
      await b.api.get(`/trainer/exercises/${ex.id}`),
      await b.api.patch(`/trainer/exercises/${ex.id}`).send({ name: 'x' }),
      await b.api.delete(`/trainer/exercises/${ex.id}`),
      await b.api.get(`/trainer/plans/${tpl.id}`),
      await b.api.patch(`/trainer/plans/${tpl.id}`).send({ name: 'x' }),
      await b.api.delete(`/trainer/plans/${cp.id}`),
      await b.api
        .put(`/trainer/plans/${cp.id}/exercises`)
        .send({ items: [{ exerciseId: bEx.id }] }),
      await b.api.get(`/trainer/clients/${c.user.id}/plans`),
      await b.api.post(`/trainer/clients/${c.user.id}/plans`).send({ name: 'x' }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    // B's own plan cannot pull A's exercise in or copy A's template
    const bPlan = Plan.parse(
      (await b.api.post('/trainer/plans').send({ name: 'B' }).expect(201)).body,
    );
    await b.api
      .put(`/trainer/plans/${bPlan.id}/exercises`)
      .send({ items: [{ exerciseId: ex.id }] })
      .expect(404);
    const bClient = await clientOf(ctx, b.user.id);
    await b.api
      .post(`/trainer/clients/${bClient.user.id}/plans`)
      .send({ fromTemplateId: tpl.id })
      .expect(404);

    expect(
      Exercises.parse(
        (await b.api.get('/trainer/exercises?includeArchived=true').expect(200)).body,
      ).map((e) => e.id),
    ).toEqual([bEx.id]);
    expect(
      Plans.parse((await b.api.get('/trainer/plans?template=true').expect(200)).body).map(
        (p) => p.id,
      ),
    ).toEqual([bPlan.id]);
    expect((await b.api.get('/trainer/plans').expect(200)).body).toEqual([]);

    // A's data is untouched
    expect(
      (await ctx.prisma.exercise.findUniqueOrThrow({ where: { id: ex.id } })).archivedAt,
    ).toBeNull();
    expect(
      (await ctx.prisma.plan.findUniqueOrThrow({ where: { id: cp.id } })).archivedAt,
    ).toBeNull();
  });
});
