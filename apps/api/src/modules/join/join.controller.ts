import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthResponse, JoinAcceptResponse, JoinInfo, JoinLinkResponse } from '@sila/contracts';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AUTH_THROTTLE } from '../../common/http/throttle';
import { bodyDto, paramsDto } from '../../common/http/zod-dto';
import { JoinService } from './join.service';

class JoinTokenParams extends paramsDto('join.get') {}
class JoinRegisterDto extends bodyDto('join.register') {}

@ApiTags('join')
@Controller()
export class JoinController {
  constructor(private readonly join: JoinService) {}

  @Public()
  @Get('join/:token')
  getInfo(@Param() { token }: JoinTokenParams): Promise<JoinInfo> {
    return this.join.getInfo(token);
  }

  @Public()
  @Post('join/:token/register')
  @HttpCode(201)
  @Throttle(AUTH_THROTTLE)
  register(
    @Param() { token }: JoinTokenParams,
    @Body() body: JoinRegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.join.register(token, body, res);
  }

  @ApiBearerAuth()
  @Roles('CLIENT')
  @Post('join/:token/accept')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  accept(
    @Param() { token }: JoinTokenParams,
    @CurrentUser() user: AuthUser,
  ): Promise<JoinAcceptResponse> {
    return this.join.accept(token, user.id);
  }

  @ApiBearerAuth()
  @Roles('TRAINER')
  @Get('trainer/join-link')
  getLink(@CurrentUser() user: AuthUser): Promise<JoinLinkResponse> {
    return this.join.getLink(user.id);
  }

  @ApiBearerAuth()
  @Roles('TRAINER')
  @Post('trainer/join-link/regenerate')
  @HttpCode(200)
  regenerate(@CurrentUser() user: AuthUser): Promise<JoinLinkResponse> {
    return this.join.regenerate(user.id);
  }
}
