import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Note } from '@sila/contracts';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { bodyDto, paramsDto } from '../../common/http/zod-dto';
import { NotesService } from './notes.service';

class IdParams extends paramsDto('trainer.notes.list') {}
class CreateNoteDto extends bodyDto('trainer.notes.create') {}
class UpdateNoteDto extends bodyDto('trainer.notes.update') {}

@ApiTags('notes')
@ApiBearerAuth()
@Roles('TRAINER')
@Controller()
export class NotesController {
  constructor(private readonly service: NotesService) {}

  @Get('trainer/clients/:id/notes')
  list(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<Note[]> {
    return this.service.list(user.id, id);
  }

  @Post('trainer/clients/:id/notes')
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: CreateNoteDto,
  ): Promise<Note> {
    return this.service.create(user.id, id, body);
  }

  @Patch('trainer/notes/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: UpdateNoteDto,
  ): Promise<Note> {
    return this.service.update(user.id, id, body);
  }

  @Delete('trainer/notes/:id')
  @HttpCode(204)
  async delete(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<void> {
    await this.service.delete(user.id, id);
  }
}
