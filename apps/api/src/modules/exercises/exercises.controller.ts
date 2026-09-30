import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Exercise } from '@sila/contracts';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { bodyDto, paramsDto, queryDto } from '../../common/http/zod-dto';
import { ExercisesService } from './exercises.service';

class IdParams extends paramsDto('trainer.exercises.get') {}
class ExercisesQueryDto extends queryDto('trainer.exercises.list') {}
class CreateExerciseDto extends bodyDto('trainer.exercises.create') {}
class UpdateExerciseDto extends bodyDto('trainer.exercises.update') {}

@ApiTags('exercises')
@ApiBearerAuth()
@Roles('TRAINER')
@Controller('trainer/exercises')
export class ExercisesController {
  constructor(private readonly service: ExercisesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ExercisesQueryDto): Promise<Exercise[]> {
    return this.service.list(user.id, query);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser, @Body() body: CreateExerciseDto): Promise<Exercise> {
    return this.service.create(user.id, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<Exercise> {
    return this.service.get(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: UpdateExerciseDto,
  ): Promise<Exercise> {
    return this.service.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<void> {
    await this.service.archive(user.id, id);
  }
}
