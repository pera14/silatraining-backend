import { Injectable, Logger } from '@nestjs/common';
import type { AuthResponse, EndpointBody } from '@sila/contracts';
import type { Response } from 'express';
import { getDummyHash, hashPassword, verifyPassword } from '../../common/crypto/password';
import { randomToken, sha256 } from '../../common/crypto/tokens';
import { DomainError } from '../../common/errors/domain-error';
import { MailerService, simpleEmailHtml } from '../../common/mailer/mailer.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config.service';
import { AuthSessionService } from './auth-session.service';

const RESET_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AuthSessionService,
    private readonly mailer: MailerService,
    private readonly config: AppConfig,
  ) {}

  async login(body: EndpointBody<'auth.login'>, res: Response): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: body.email } });
    // Always run a verification so response time does not reveal whether the email exists.
    const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), body.password);
    if (!user || !ok) throw new DomainError('INVALID_CREDENTIALS');
    return this.sessions.issue(res, user);
  }

  /** Always resolves (204) so the endpoint cannot be used to discover accounts. */
  async forgotPassword(body: EndpointBody<'auth.forgotPassword'>): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (!user) return;

    const token = randomToken();
    await this.prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    const url = `${this.config.appUrl}/reset/${token}`;
    await this.mailer.send({
      to: user.email,
      subject: 'Reset your Sila Training password',
      text: `Hi ${user.firstName},\n\nUse this link to set a new password (valid for 1 hour):\n${url}\n\nIf you did not ask for this, ignore this email.`,
      html: simpleEmailHtml({
        title: 'Reset your password',
        body: `Hi ${user.firstName}, use the button below to set a new password. The link is valid for 1 hour. If you did not ask for this, ignore this email.`,
        cta: { label: 'Set a new password', url },
      }),
    });
  }

  /** Single-use token; on success every refresh token of the user is revoked (signs out other devices). */
  async resetPassword(body: EndpointBody<'auth.resetPassword'>): Promise<void> {
    const passwordHash = await hashPassword(body.password);
    await this.prisma.$transaction(async (tx) => {
      const reset = await tx.passwordReset.findUnique({ where: { tokenHash: sha256(body.token) } });
      if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) {
        throw new DomainError('RESET_TOKEN_INVALID');
      }
      const { count } = await tx.passwordReset.updateMany({
        where: { id: reset.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (count !== 1) throw new DomainError('RESET_TOKEN_INVALID');
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      await this.sessions.revokeAllForUser(reset.userId, tx);
    });
  }
}
