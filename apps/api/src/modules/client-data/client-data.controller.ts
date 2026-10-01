import { Controller, Delete, Get, Header, HttpCode, Param, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Readable } from 'node:stream';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { paramsDto } from '../../common/http/zod-dto';
import { contentDisposition } from '../../common/storage/storage.service';
import { ClientDataService } from './client-data.service';

class IdParams extends paramsDto('trainer.clients.export') {}

@ApiTags('client data')
@ApiBearerAuth()
@Controller('trainer/clients/:id')
export class ClientDataController {
  constructor(private readonly clientData: ClientDataService) {}

  @Roles('TRAINER')
  @Get('export')
  @Header('Cache-Control', 'no-store')
  @ApiProduces('application/zip')
  async export(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<StreamableFile> {
    const { fileName, stream } = await this.clientData.export(user.id, id);
    return new StreamableFile(Readable.from(stream), {
      type: 'application/zip',
      disposition: contentDisposition(fileName),
    });
  }

  @Roles('TRAINER')
  @Delete()
  @HttpCode(204)
  async delete(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<void> {
    await this.clientData.delete(user.id, id);
  }
}
