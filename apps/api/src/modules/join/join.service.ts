import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  AuthResponse,
  EndpointBody,
  JoinAcceptResponse,
  JoinInfo,
  JoinLinkResponse,
} from '@sila/contracts';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as QRCode from 'qrcode';
import { hashPassword } from '../../common/crypto/password';
import { deriveToken, sha256 } from '../../common/crypto/tokens';
import { DomainError } from '../../common/errors/domain-error';
import { type ClientJoinedEvent, EVENTS } from '../../common/events/events';
import { fullName } from '../../common/http/mappers';
import { isConstraintViolation } from '../../common/prisma/prisma-errors';
import { type PrismaTx, PrismaService } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config.service';
import type { JoinLink, User } from '../../generated/prisma/client';
import { AuthSessionService } from '../auth/auth-session.service';

@Injectable()
export class JoinService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AuthSessionService,
    private readonly config: AppConfig,
    private readonly events: EventEmitter2,
  ) {}

  // ------------------------------------------------------------------ trainer side

  /** The trainer's active link as URL + QR; created on first use. */
  async getLink(trainerId: string): Promise<JoinLinkResponse> {
    const existing = await this.prisma.joinLink.findFirst({
      where: { trainerId, revokedAt: null },
    });
    return this.present(existing ?? (await this.createLink(trainerId)));
  }

  /** Revokes the current link and creates a new one (old URL/QR immediately returns 410). */
  async regenerate(trainerId: string): Promise<JoinLinkResponse> {
    const link = await this.prisma.$transaction(async (tx) => {
      await tx.joinLink.updateMany({
        where: { trainerId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return this.insertLink(tx, trainerId);
    });
    return this.present(link);
  }

  // ------------------------------------------------------------------ public side

  async getInfo(token: string): Promise<JoinInfo> {
    const { trainer } = await this.resolve(token);
    return {
      trainerName: fullName(trainer),
      trainerFirstName: trainer.firstName,
      trainerPhotoUrl: trainer.photoUrl,
    };
  }

  /** New person: creates a CLIENT linked to the trainer and signs them in. */
  async register(
    token: string,
    body: EndpointBody<'join.register'>,
    res: Response,
  ): Promise<AuthResponse> {
    const passwordHash = await hashPassword(body.password);
    try {
      const { response, trainerId, clientId } = await this.prisma.$transaction(async (tx) => {
        const { trainer } = await this.resolve(token, tx);
        if (await tx.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
          throw new DomainError('EMAIL_TAKEN');
        }
        const client = await tx.user.create({
          data: {
            role: 'CLIENT',
            email: body.email,
            passwordHash,
            firstName: body.firstName,
            lastName: body.lastName,
            phone: body.phone ?? null,
            consentAt: new Date(),
          },
        });
        await tx.trainerClient.create({ data: { trainerId: trainer.id, clientId: client.id } });
        const response = await this.sessions.issue(res, client, tx);
        return { response, trainerId: trainer.id, clientId: client.id };
      });
      this.emitJoined({ clientId, trainerId, via: 'register' });
      return response;
    } catch (err) {
      // Two concurrent registrations with the same email: the unique index decides.
      if (isConstraintViolation(err, 'unique')) throw new DomainError('EMAIL_TAKEN');
      throw err;
    }
  }

  /** Existing signed-in client links to the trainer. Idempotent for the same trainer. */
  async accept(token: string, clientId: string): Promise<JoinAcceptResponse> {
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const { trainer } = await this.resolve(token, tx);
        const current = await tx.trainerClient.findUnique({ where: { clientId } });
        if (current && current.trainerId !== trainer.id) throw new DomainError('ALREADY_LINKED');
        if (current) {
          // Re-joining an archived relationship reactivates it.
          if (current.archivedAt) {
            await tx.trainerClient.update({
              where: { trainerId_clientId: { trainerId: trainer.id, clientId } },
              data: { archivedAt: null },
            });
          }
          return { trainer, linked: false };
        }
        await tx.trainerClient.create({ data: { trainerId: trainer.id, clientId } });
        return { trainer, linked: true };
      });
      if (result.linked) this.emitJoined({ clientId, trainerId: result.trainer.id, via: 'accept' });
      return { trainerName: fullName(result.trainer), linked: result.linked };
    } catch (err) {
      // Concurrent accept of two different links: TrainerClient.clientId is unique.
      if (isConstraintViolation(err, 'unique')) throw new DomainError('ALREADY_LINKED');
      throw err;
    }
  }

  // ------------------------------------------------------------------ internals

  /** Active link + its trainer, or 410 LINK_REVOKED for unknown/revoked tokens. */
  private async resolve(
    token: string,
    tx: PrismaTx = this.prisma,
  ): Promise<{ link: JoinLink; trainer: User }> {
    const link = await tx.joinLink.findUnique({
      where: { tokenHash: sha256(token) },
      include: { trainer: true },
    });
    if (!link || link.revokedAt || link.trainer.role !== 'TRAINER')
      throw new DomainError('LINK_REVOKED');
    return { link, trainer: link.trainer };
  }

  private async createLink(trainerId: string): Promise<JoinLink> {
    try {
      return await this.insertLink(this.prisma, trainerId);
    } catch (err) {
      // Lost a race with a concurrent first call: the partial unique index keeps one active link.
      if (isConstraintViolation(err, 'unique')) {
        return this.prisma.joinLink.findFirstOrThrow({ where: { trainerId, revokedAt: null } });
      }
      throw err;
    }
  }

  private async insertLink(tx: PrismaTx, trainerId: string): Promise<JoinLink> {
    const id = randomUUID();
    const token = this.tokenFor(id);
    return tx.joinLink.create({ data: { id, trainerId, tokenHash: sha256(token) } });
  }

  private tokenFor(linkId: string): string {
    return deriveToken(this.config.get('JOIN_TOKEN_SECRET'), 'join', linkId);
  }

  private async present(link: JoinLink): Promise<JoinLinkResponse> {
    const url = `${this.config.appUrl}/join/${this.tokenFor(link.id)}`;
    const qrSvg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#0f1729', light: '#ffffff' },
    });
    return { url, qrSvg, createdAt: link.createdAt.toISOString() };
  }

  private emitJoined(event: ClientJoinedEvent): void {
    this.events.emit(EVENTS.clientJoined, event);
  }
}
