import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CreateDocumentResponse, Document, DocumentDownloadResponse } from '@sila/contracts';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { bodyDto, paramsDto } from '../../common/http/zod-dto';
import { DocumentsService } from './documents.service';

class IdParams extends paramsDto('trainer.documents.list') {}
class CreateDocumentDto extends bodyDto('trainer.documents.create') {}

@ApiTags('documents')
@ApiBearerAuth()
@Roles('TRAINER')
@Controller()
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  @Get('trainer/clients/:id/documents')
  list(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<Document[]> {
    return this.service.list(user.id, id);
  }

  @Post('trainer/clients/:id/documents')
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: CreateDocumentDto,
  ): Promise<CreateDocumentResponse> {
    return this.service.create(user.id, id, body);
  }

  @Post('trainer/documents/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<Document> {
    return this.service.confirm(user.id, id);
  }

  @Get('trainer/documents/:id/download')
  download(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
  ): Promise<DocumentDownloadResponse> {
    return this.service.download(user.id, id);
  }

  @Delete('trainer/documents/:id')
  @HttpCode(204)
  async delete(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<void> {
    await this.service.softDelete(user.id, id);
  }
}
