import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Plan } from '@sila/contracts';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { bodyDto, paramsDto, queryDto } from '../../common/http/zod-dto';
import { PlansService } from './plans.service';

class IdParams extends paramsDto('trainer.plans.get') {}
class PlansQueryDto extends queryDto('trainer.plans.list') {}
class CreatePlanDto extends bodyDto('trainer.plans.create') {}
class UpdatePlanDto extends bodyDto('trainer.plans.update') {}
class PutExercisesDto extends bodyDto('trainer.plans.putExercises') {}
class CreateClientPlanDto extends bodyDto('trainer.clientPlans.create') {}

@ApiTags('plans')
@ApiBearerAuth()
@Roles('TRAINER')
@Controller()
export class PlansController {
  constructor(private readonly service: PlansService) {}

  @Get('trainer/plans')
  list(@CurrentUser() user: AuthUser, @Query() query: PlansQueryDto): Promise<Plan[]> {
    return this.service.list(user.id, query);
  }

  @Post('trainer/plans')
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser, @Body() body: CreatePlanDto): Promise<Plan> {
    return this.service.createTemplate(user.id, body);
  }

  @Get('trainer/plans/:id')
  get(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<Plan> {
    return this.service.get(user.id, id);
  }

  @Patch('trainer/plans/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: UpdatePlanDto,
  ): Promise<Plan> {
    return this.service.update(user.id, id, body);
  }

  @Delete('trainer/plans/:id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<void> {
    await this.service.archive(user.id, id);
  }

  @Put('trainer/plans/:id/exercises')
  putExercises(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: PutExercisesDto,
  ): Promise<Plan> {
    return this.service.putExercises(user.id, id, body);
  }

  @Get('trainer/clients/:id/plans')
  listForClient(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<Plan[]> {
    return this.service.listForClient(user.id, id);
  }

  @Post('trainer/clients/:id/plans')
  @HttpCode(201)
  createForClient(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: CreateClientPlanDto,
  ): Promise<Plan> {
    return this.service.createForClient(user.id, id, body);
  }
}
