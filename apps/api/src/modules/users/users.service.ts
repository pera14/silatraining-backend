import { Injectable } from '@nestjs/common';
import type { EndpointBody, Me } from '@sila/contracts';
import { hashPassword, verifyPassword } from '../../common/crypto/password';
import { DomainError } from '../../common/errors/domain-error';
import { toMe } from '../../common/http/mappers';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string): Promise<Me> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { trainerLink: { include: { trainer: true } } },
    });
    // A valid token for a deleted user: treat as signed out.
    if (!user) throw new DomainError('UNAUTHORIZED');
    return toMe(user, user.trainerLink?.trainer ?? null);
  }

  /** Shared by PATCH /trainer/profile and PATCH /client/profile (each only edits the caller). */
  async updateProfile(userId: string, body: EndpointBody<'client.profile.update'>): Promise<Me> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new DomainError('UNAUTHORIZED');

    let passwordHash: string | undefined;
    if (body.password) {
      if (!(await verifyPassword(user.passwordHash, body.password.current))) {
        throw new DomainError('INVALID_CREDENTIALS', 'Your current password is wrong.');
      }
      passwordHash = await hashPassword(body.password.next);
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        photoUrl: body.photoUrl,
        passwordHash,
      },
    });
    return this.getMe(userId);
  }
}
