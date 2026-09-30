import { Injectable } from '@nestjs/common';
import type { EndpointBody, EndpointQuery, Plan } from '@sila/contracts';
import { DomainError } from '../../common/errors/domain-error';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { type PrismaTx, PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const WITH_EXERCISES = {
  exercises: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { exercise: { select: { id: true, name: true, category: true, videoUrl: true } } },
  },
} as const satisfies Prisma.PlanInclude;

type PlanRow = Prisma.PlanGetPayload<{ include: typeof WITH_EXERCISES }>;

/** Rotation order first; ties keep creation order stable via id. */
const ROTATION_ORDER = [
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.PlanOrderByWithRelationInput[];

/**
 * Plan templates and client plans (SPEC §4 "Plans and exercises"). Assigning a template to a client deep-copies
 * it, so the client's Plan A/B can change without touching the template. A client's active plans ordered by
 * `sortOrder` define the A → B → A rotation that booking (Agent A) uses; archiving a plan removes it from the
 * rotation while past practices keep pointing at it.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
  ) {}

  /** `?template=true` → templates; otherwise every client plan of the trainer. Archived plans are hidden. */
  async list(trainerId: string, query: EndpointQuery<'trainer.plans.list'>): Promise<Plan[]> {
    const rows = await this.prisma.plan.findMany({
      where: {
        trainerId,
        archivedAt: null,
        clientId: query.template ? null : { not: null },
      },
      orderBy: query.template ? ROTATION_ORDER : [{ clientId: 'asc' }, ...ROTATION_ORDER],
      include: WITH_EXERCISES,
    });
    return rows.map(toPlan);
  }

  /** A new template; without `sortOrder` it goes to the end. */
  async createTemplate(
    trainerId: string,
    body: EndpointBody<'trainer.plans.create'>,
  ): Promise<Plan> {
    const row = await this.prisma.plan.create({
      data: {
        trainerId,
        clientId: null,
        name: body.name,
        notes: body.notes ?? null,
        sortOrder: body.sortOrder ?? (await this.nextSortOrder(this.prisma, trainerId, null)),
      },
      include: WITH_EXERCISES,
    });
    return toPlan(row);
  }

  async get(trainerId: string, id: string): Promise<Plan> {
    return toPlan(await this.findOwned(this.prisma, trainerId, id));
  }

  async update(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.plans.update'>,
  ): Promise<Plan> {
    await this.findOwned(this.prisma, trainerId, id);
    const row = await this.prisma.plan.update({
      where: { id },
      data: { name: body.name, notes: body.notes, sortOrder: body.sortOrder },
      include: WITH_EXERCISES,
    });
    return toPlan(row);
  }

  /** Archive (idempotent). The plan leaves the rotation; practices that used it keep the reference. */
  async archive(trainerId: string, id: string): Promise<void> {
    await this.findOwned(this.prisma, trainerId, id);
    await this.prisma.plan.updateMany({
      where: { id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
  }

  /**
   * Replaces the ordered exercise list (array order becomes sortOrder). Every exercise must be the trainer's; an
   * archived exercise is only accepted if the plan already contains it, so reordering an old plan still works.
   */
  async putExercises(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.plans.putExercises'>,
  ): Promise<Plan> {
    await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent PUTs on the same plan: last writer wins with a consistent list.
      const locked = await tx.$queryRaw<Array<{ trainerId: string }>>`
        SELECT "trainerId" FROM "Plan" WHERE id = ${id} FOR UPDATE`;
      this.ownership.assertOwnedByTrainer(trainerId, locked[0], 'Plan');

      const ids = [...new Set(body.items.map((i) => i.exerciseId))];
      const [exercises, current] = await Promise.all([
        tx.exercise.findMany({
          where: { id: { in: ids }, trainerId },
          select: { id: true, archivedAt: true },
        }),
        tx.planExercise.findMany({ where: { planId: id }, select: { exerciseId: true } }),
      ]);
      const inPlan = new Set(current.map((c) => c.exerciseId));
      const usable = new Set(
        exercises.filter((e) => !e.archivedAt || inPlan.has(e.id)).map((e) => e.id),
      );
      const invalid = ids.filter((x) => !usable.has(x));
      if (invalid.length > 0) {
        throw new DomainError('NOT_FOUND', 'Exercise not found', { exerciseIds: invalid });
      }

      await tx.planExercise.deleteMany({ where: { planId: id } });
      if (body.items.length > 0) {
        await tx.planExercise.createMany({
          data: body.items.map((item, index) => ({
            planId: id,
            exerciseId: item.exerciseId,
            sets: item.sets ?? null,
            reps: item.reps || null,
            weight: item.weight || null,
            restSec: item.restSec ?? null,
            notes: item.notes || null,
            sortOrder: index,
          })),
        });
      }
    });
    return this.get(trainerId, id);
  }

  // ------------------------------------------------------------------ client plans

  /** The client's active plans in rotation order. Archived clients stay readable. */
  async listForClient(trainerId: string, clientId: string): Promise<Plan[]> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const rows = await this.prisma.plan.findMany({
      where: { trainerId, clientId, archivedAt: null },
      orderBy: ROTATION_ORDER,
      include: WITH_EXERCISES,
    });
    return rows.map(toPlan);
  }

  /**
   * `fromTemplateId`: deep copy of the template (name/notes overridable); otherwise an empty plan named `name`.
   * Without `sortOrder` the plan is appended to the end of the client's rotation.
   */
  async createForClient(
    trainerId: string,
    clientId: string,
    body: EndpointBody<'trainer.clientPlans.create'>,
  ): Promise<Plan> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const planId = await this.prisma.$transaction(async (tx) => {
      const template = body.fromTemplateId
        ? await tx.plan.findFirst({
            where: { id: body.fromTemplateId, trainerId, clientId: null, archivedAt: null },
            include: { exercises: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
          })
        : null;
      if (body.fromTemplateId && !template)
        throw new DomainError('NOT_FOUND', 'Template not found');

      const name = body.name ?? template?.name;
      if (!name) throw new DomainError('VALIDATION_FAILED', 'Provide fromTemplateId or name');

      const plan = await tx.plan.create({
        data: {
          trainerId,
          clientId,
          name,
          notes: body.notes !== undefined ? body.notes : (template?.notes ?? null),
          sortOrder: body.sortOrder ?? (await this.nextSortOrder(tx, trainerId, clientId)),
        },
      });
      if (template && template.exercises.length > 0) {
        await tx.planExercise.createMany({
          data: template.exercises.map((e, index) => ({
            planId: plan.id,
            exerciseId: e.exerciseId,
            sets: e.sets,
            reps: e.reps,
            weight: e.weight,
            restSec: e.restSec,
            notes: e.notes,
            sortOrder: index,
          })),
        });
      }
      return plan.id;
    });
    return this.get(trainerId, planId);
  }

  // ------------------------------------------------------------------ internals

  private async findOwned(tx: PrismaTx, trainerId: string, id: string): Promise<PlanRow> {
    const row = await tx.plan.findUnique({ where: { id }, include: WITH_EXERCISES });
    this.ownership.assertOwnedByTrainer(trainerId, row, 'Plan');
    return row;
  }

  /** One past the highest sortOrder among the active plans of the same owner (templates or one client). */
  private async nextSortOrder(
    tx: PrismaTx,
    trainerId: string,
    clientId: string | null,
  ): Promise<number> {
    const agg = await tx.plan.aggregate({
      where: { trainerId, clientId, archivedAt: null },
      _max: { sortOrder: true },
    });
    return agg._max.sortOrder === null ? 0 : agg._max.sortOrder + 1;
  }
}

export function toPlan(p: PlanRow): Plan {
  return {
    id: p.id,
    clientId: p.clientId,
    name: p.name,
    notes: p.notes,
    sortOrder: p.sortOrder,
    archivedAt: p.archivedAt?.toISOString() ?? null,
    exercises: p.exercises.map((pe) => ({
      id: pe.id,
      exercise: pe.exercise,
      sets: pe.sets,
      reps: pe.reps,
      weight: pe.weight,
      restSec: pe.restSec,
      notes: pe.notes,
      sortOrder: pe.sortOrder,
    })),
  };
}
