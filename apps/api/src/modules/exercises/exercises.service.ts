import { Injectable } from '@nestjs/common';
import type { EndpointBody, EndpointQuery, Exercise } from '@sila/contracts';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Exercise as ExerciseRow } from '../../generated/prisma/client';

/**
 * The trainer's exercise library (SPEC §4 "Plans and exercises"). Exercises are archived, never deleted, because
 * plans reference them (PlanExercise → Exercise is onDelete Restrict).
 */
@Injectable()
export class ExercisesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
  ) {}

  /** Active exercises by name; `q` matches name or category, case-insensitively. */
  async list(
    trainerId: string,
    query: EndpointQuery<'trainer.exercises.list'>,
  ): Promise<Exercise[]> {
    const q = query.q?.trim();
    const rows = await this.prisma.exercise.findMany({
      where: {
        trainerId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { category: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toExercise);
  }

  async get(trainerId: string, id: string): Promise<Exercise> {
    return toExercise(await this.findOwned(trainerId, id));
  }

  async create(
    trainerId: string,
    body: EndpointBody<'trainer.exercises.create'>,
  ): Promise<Exercise> {
    const row = await this.prisma.exercise.create({
      data: {
        trainerId,
        name: body.name,
        category: emptyToNull(body.category),
        description: emptyToNull(body.description),
        videoUrl: body.videoUrl ?? null,
      },
    });
    return toExercise(row);
  }

  async update(
    trainerId: string,
    id: string,
    body: EndpointBody<'trainer.exercises.update'>,
  ): Promise<Exercise> {
    await this.findOwned(trainerId, id);
    const row = await this.prisma.exercise.update({
      where: { id },
      data: {
        name: body.name,
        category: body.category === undefined ? undefined : emptyToNull(body.category),
        description: body.description === undefined ? undefined : emptyToNull(body.description),
        videoUrl: body.videoUrl,
      },
    });
    return toExercise(row);
  }

  /** Archive (idempotent). Plans that already use the exercise keep showing it. */
  async archive(trainerId: string, id: string): Promise<void> {
    await this.findOwned(trainerId, id);
    await this.prisma.exercise.updateMany({
      where: { id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
  }

  private async findOwned(trainerId: string, id: string): Promise<ExerciseRow> {
    const row = await this.prisma.exercise.findUnique({ where: { id } });
    this.ownership.assertOwnedByTrainer(trainerId, row, 'Exercise');
    return row;
  }
}

function emptyToNull(v: string | null | undefined): string | null {
  return v ? v : null;
}

export function toExercise(e: ExerciseRow): Exercise {
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    description: e.description,
    videoUrl: e.videoUrl,
    archivedAt: e.archivedAt?.toISOString() ?? null,
  };
}
