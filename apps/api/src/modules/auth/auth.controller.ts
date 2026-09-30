import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthResponse } from '@sila/contracts';
import type { Request, Response } from 'express';
import { Public } from '../../common/auth/decorators';
import { AUTH_THROTTLE } from '../../common/http/throttle';
import { bodyDto } from '../../common/http/zod-dto';
import { AuthSessionService } from './auth-session.service';
import { AuthService } from './auth.service';

class LoginDto extends bodyDto('auth.login') {}
class ForgotPasswordDto extends bodyDto('auth.forgotPassword') {}
class ResetPasswordDto extends bodyDto('auth.resetPassword') {}

@ApiTags('auth')
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: AuthSessionService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.auth.login(body, res);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.sessions.rotate(req, res);
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.sessions.revoke(req, res);
  }

  @Post('password/forgot')
  @HttpCode(204)
  @Throttle(AUTH_THROTTLE)
  forgot(@Body() body: ForgotPasswordDto): Promise<void> {
    return this.auth.forgotPassword(body);
  }

  @Post('password/reset')
  @HttpCode(204)
  @Throttle(AUTH_THROTTLE)
  reset(@Body() body: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(body);
  }
}
