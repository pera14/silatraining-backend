import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AppConfig } from '../../config/app-config.service';
import { DomainError } from '../errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import type { AccessTokenPayload, AuthUser } from './auth-user';
import { IS_PUBLIC_KEY } from './decorators';

/**
 * Global guard: every route requires `Authorization: Bearer <access token>` unless marked @Public().
 * On @Public routes a valid token is still attached (optional auth), an invalid one is ignored.
 *
 * A valid signature is not enough: the user must still exist with the token's role, so a deleted client (SPEC §7
 * "Delete client") is locked out at once instead of when the 15-minute token expires. One primary-key lookup per
 * request is negligible at this scale.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = this.extractToken(req);

    if (!token) {
      if (isPublic) return true;
      throw new DomainError('UNAUTHORIZED');
    }
    const user = await this.verify(token);
    if (user) {
      req.user = user;
      return true;
    }
    if (isPublic) return true;
    throw new DomainError('UNAUTHORIZED', 'Your session has expired. Please sign in again.');
  }

  /** The token's user if the signature is valid and the account still exists with that role. */
  private async verify(token: string): Promise<AuthUser | null> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        algorithms: ['HS256'],
      });
    } catch {
      return null;
    }
    const account = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { role: true },
    });
    return account?.role === payload.role ? { id: payload.sub, role: payload.role } : null;
  }

  private extractToken(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
  }
}
