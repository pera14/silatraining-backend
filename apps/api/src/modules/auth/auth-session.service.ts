import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse } from '@sila/contracts';
import type { CookieOptions, Request, Response } from 'express';
import type { AccessTokenPayload } from '../../common/auth/auth-user';
import { hmacHex, randomToken } from '../../common/crypto/tokens';
import { DomainError } from '../../common/errors/domain-error';
import { toMe } from '../../common/http/mappers';
import { type PrismaTx, PrismaService } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config.service';
import type { User } from '../../generated/prisma/client';

export const REFRESH_COOKIE = 'sila_refresh';
/** Non-authoritative role hint read by the web app's route gate (proxy.ts). The API never trusts it. */
export const SESSION_HINT_COOKIE = 'sila_session';

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A refresh token presented again within this window after rotation is treated as a benign race (two tabs
 * refreshing at once): 401 without revoking the family. The browser already holds the new cookie, so the
 * web client's single retry succeeds. Outside the window, reuse = theft: revoke every token of the user.
 */
const REUSE_GRACE_MS = 10_000;

@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  /** Creates a refresh token, sets both cookies and returns the access token + user. */
  async issue(res: Response, user: User, tx: PrismaTx = this.prisma): Promise<AuthResponse> {
    const refreshToken = randomToken();
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashRefresh(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return this.respond(res, user, refreshToken, tx);
  }

  /** Rotates the refresh cookie. Throws TOKEN_INVALID (and clears cookies) on any problem. */
  async rotate(req: Request, res: Response): Promise<AuthResponse> {
    const presented = this.readRefreshCookie(req);
    if (!presented) throw this.invalid(res);

    const tokenHash = this.hashRefresh(presented);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!existing) throw this.invalid(res);

    if (existing.revokedAt) {
      const sinceRevoked = Date.now() - existing.revokedAt.getTime();
      if (sinceRevoked > REUSE_GRACE_MS) {
        this.logger.warn(
          `Refresh token reuse detected for user ${existing.userId}; revoking all sessions`,
        );
        await this.revokeAllForUser(existing.userId);
        throw this.invalid(res);
      }
      // benign race: do not clear cookies, the browser already has the rotated one
      throw new DomainError('TOKEN_INVALID');
    }
    if (existing.expiresAt.getTime() <= Date.now()) throw this.invalid(res);

    const next = randomToken();
    return this.prisma.$transaction(async (tx) => {
      // Conditional revoke: exactly one concurrent rotation of the same token can win.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count !== 1) throw new DomainError('TOKEN_INVALID');
      await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          tokenHash: this.hashRefresh(next),
          expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        },
      });
      return this.respond(res, existing.user, next, tx);
    });
  }

  /** Revokes the presented refresh token (if any) and clears cookies. Idempotent. */
  async revoke(req: Request, res: Response): Promise<void> {
    const presented = this.readRefreshCookie(req);
    if (presented) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hashRefresh(presented), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    this.clearCookies(res);
  }

  async revokeAllForUser(userId: string, tx: PrismaTx = this.prisma): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  clearCookies(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions('/api/auth'));
    res.clearCookie(SESSION_HINT_COOKIE, this.cookieOptions('/'));
  }

  // ------------------------------------------------------------------ internals

  private async respond(
    res: Response,
    user: User,
    refreshToken: string,
    tx: PrismaTx,
  ): Promise<AuthResponse> {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: ACCESS_TTL_SECONDS,
      algorithm: 'HS256',
    });
    const hint = await this.jwt.signAsync(payload, {
      secret: this.config.get('SESSION_HINT_SECRET'),
      expiresIn: Math.floor(REFRESH_TTL_MS / 1000),
      algorithm: 'HS256',
    });
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...this.cookieOptions('/api/auth'),
      maxAge: REFRESH_TTL_MS,
    });
    res.cookie(SESSION_HINT_COOKIE, hint, { ...this.cookieOptions('/'), maxAge: REFRESH_TTL_MS });

    const trainer =
      user.role === 'CLIENT'
        ? ((
            await tx.trainerClient.findUnique({
              where: { clientId: user.id },
              include: { trainer: true },
            })
          )?.trainer ?? null)
        : null;
    return { accessToken, expiresIn: ACCESS_TTL_SECONDS, user: toMe(user, trainer) };
  }

  private cookieOptions(path: string): CookieOptions {
    return { httpOnly: true, secure: this.config.isProduction, sameSite: 'lax', path };
  }

  private readRefreshCookie(req: Request): string | undefined {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private hashRefresh(token: string): string {
    return hmacHex(this.config.get('JWT_REFRESH_SECRET'), token);
  }

  private invalid(res: Response): DomainError {
    this.clearCookies(res);
    return new DomainError('TOKEN_INVALID');
  }
}
