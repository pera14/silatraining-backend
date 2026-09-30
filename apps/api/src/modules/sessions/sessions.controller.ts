import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ClientHome, ClientPractice, TodayResponse, TrainerPractice } from '@sila/contracts';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { bodyDto, paramsDto, queryDto } from '../../common/http/zod-dto';
import { SessionsService } from './sessions.service';

class IdParams extends paramsDto('trainer.sessions.update') {}
class TrainerBookDto extends bodyDto('trainer.sessions.create') {}
class TrainerUpdateDto extends bodyDto('trainer.sessions.update') {}
class MoveDto extends bodyDto('trainer.sessions.move') {}
class TrainerCancelDto extends bodyDto('trainer.sessions.cancel') {}
class TodayQueryDto extends queryDto('trainer.today') {}
class ClientBookDto extends bodyDto('client.sessions.create') {}
class ClientSessionsQueryDto extends queryDto('client.sessions.list') {}

@ApiTags('sessions')
@ApiBearerAuth()
@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  // ------------------------------------------------------------------ trainer

  @Roles('TRAINER')
  @Get('trainer/today')
  today(@CurrentUser() user: AuthUser, @Query() query: TodayQueryDto): Promise<TodayResponse> {
    return this.sessions.today(user.id, query);
  }

  @Roles('TRAINER')
  @Post('trainer/sessions')
  @HttpCode(201)
  trainerBook(
    @CurrentUser() user: AuthUser,
    @Body() body: TrainerBookDto,
  ): Promise<TrainerPractice> {
    return this.sessions.trainerBook(user.id, body);
  }

  @Roles('TRAINER')
  @Patch('trainer/sessions/:id')
  trainerUpdate(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: TrainerUpdateDto,
  ): Promise<TrainerPractice> {
    return this.sessions.trainerUpdate(user.id, id, body);
  }

  @Roles('TRAINER')
  @Post('trainer/sessions/:id/move')
  @HttpCode(200)
  move(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: MoveDto,
  ): Promise<TrainerPractice> {
    return this.sessions.trainerMove(user.id, id, body);
  }

  @Roles('TRAINER')
  @Post('trainer/sessions/:id/cancel')
  @HttpCode(200)
  trainerCancel(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: TrainerCancelDto,
  ): Promise<TrainerPractice> {
    return this.sessions.trainerCancel(user.id, id, body);
  }

  // ------------------------------------------------------------------ client

  @Roles('CLIENT')
  @Get('client/home')
  home(@CurrentUser() user: AuthUser): Promise<ClientHome> {
    return this.sessions.clientHome(user.id);
  }

  @Roles('CLIENT')
  @Get('client/sessions')
  clientList(
    @CurrentUser() user: AuthUser,
    @Query() query: ClientSessionsQueryDto,
  ): Promise<ClientPractice[]> {
    return this.sessions.clientList(user.id, query);
  }

  @Roles('CLIENT')
  @Post('client/sessions')
  @HttpCode(201)
  clientBook(@CurrentUser() user: AuthUser, @Body() body: ClientBookDto): Promise<ClientPractice> {
    return this.sessions.clientBook(user.id, body);
  }

  @Roles('CLIENT')
  @Post('client/sessions/:id/cancel')
  @HttpCode(200)
  clientCancel(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<ClientPractice> {
    return this.sessions.clientCancel(user.id, id);
  }
}
