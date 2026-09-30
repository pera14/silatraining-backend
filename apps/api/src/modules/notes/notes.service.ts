import { Injectable } from '@nestjs/common';
import type { EndpointBody, Note } from '@sila/contracts';
import { DomainError } from '../../common/errors/domain-error';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { isConstraintViolation } from '../../common/prisma/prisma-errors';
import { type PrismaTx, PrismaService } from '../../common/prisma/prisma.service';
import type { ClientNote } from '../../generated/prisma/client';

/**
 * Trainer-private notes per client (SPEC §4 "Notes"). At most one note per client is pinned (partial unique
 * index `client_note_one_pinned`); pinning a note unpins the previous one in the same transaction.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
  ) {}

  /** Pinned first, then newest. Archived clients stay readable. */
  async list(trainerId: string, clientId: string): Promise<Note[]> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const notes = await this.prisma.clientNote.findMany({
      where: { clientId, trainerId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    return notes.map(toNote);
  }

  async create(
    trainerId: string,
    clientId: string,
    body: EndpointBody<'trainer.notes.create'>,
  ): Promise<Note> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const note = await this.pinSafely(() =>
      this.prisma.$transaction(async (tx) => {
        if (body.pinned) await this.unpinAll(tx, clientId);
        return tx.clientNote.create({
          data: { clientId, trainerId, body: body.body, pinned: body.pinned ?? false },
        });
      }),
    );
    return toNote(note);
  }

  async update(
    trainerId: string,
    noteId: string,
    body: EndpointBody<'trainer.notes.update'>,
  ): Promise<Note> {
    const note = await this.pinSafely(() =>
      this.prisma.$transaction(async (tx) => {
        const current = await this.findOwned(tx, trainerId, noteId);
        if (body.pinned && !current.pinned) await this.unpinAll(tx, current.clientId);
        return tx.clientNote.update({
          where: { id: current.id },
          data: { body: body.body, pinned: body.pinned },
        });
      }),
    );
    return toNote(note);
  }

  async delete(trainerId: string, noteId: string): Promise<void> {
    const current = await this.findOwned(this.prisma, trainerId, noteId);
    await this.prisma.clientNote.deleteMany({ where: { id: current.id } });
  }

  // ------------------------------------------------------------------ internals

  private async findOwned(tx: PrismaTx, trainerId: string, noteId: string): Promise<ClientNote> {
    const note = await tx.clientNote.findUnique({ where: { id: noteId } });
    this.ownership.assertOwnedByTrainer(trainerId, note, 'Note');
    return note;
  }

  /**
   * Locks the client's TrainerClient row first, so two concurrent "pin" requests for the same client serialize
   * instead of racing on the one-pinned index.
   */
  private async unpinAll(tx: PrismaTx, clientId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "TrainerClient" WHERE "clientId" = ${clientId} FOR UPDATE`;
    await tx.clientNote.updateMany({ where: { clientId, pinned: true }, data: { pinned: false } });
  }

  /** Backstop for the partial unique index (should be unreachable thanks to the row lock). */
  private async pinSafely<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isConstraintViolation(err, 'unique', 'client_note_one_pinned')) {
        throw new DomainError('INVALID_STATE', 'Another note was just pinned. Please try again.');
      }
      throw err;
    }
  }
}

function toNote(n: ClientNote): Note {
  return {
    id: n.id,
    clientId: n.clientId,
    body: n.body,
    pinned: n.pinned,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}
