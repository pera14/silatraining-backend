import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type {
  ClientDetail,
  ClientListItem,
  ClientPackage,
  Package,
  PackageType,
} from '@sila/contracts';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { bodyDto, paramsDto, queryDto } from '../../common/http/zod-dto';
import { ClientsService } from './clients.service';
import { PackagesService } from './packages.service';

class IdParams extends paramsDto('trainer.packages.update') {}
class CreatePackageDto extends bodyDto('trainer.packages.create') {}
class UpdatePackageDto extends bodyDto('trainer.packages.update') {}
class ExtendPackageDto extends bodyDto('trainer.packages.extend') {}
class AdjustPackageDto extends bodyDto('trainer.packages.adjust') {}
class PackageTypesQueryDto extends queryDto('trainer.packageTypes.list') {}
class CreatePackageTypeDto extends bodyDto('trainer.packageTypes.create') {}
class UpdatePackageTypeDto extends bodyDto('trainer.packageTypes.update') {}
class ClientsQueryDto extends queryDto('trainer.clients.list') {}
class UpdateClientDto extends bodyDto('trainer.clients.update') {}

@ApiTags('packages')
@ApiBearerAuth()
@Controller()
export class PackagesController {
  constructor(
    private readonly packages: PackagesService,
    private readonly clients: ClientsService,
  ) {}

  // ------------------------------------------------------------------ clients

  @Roles('TRAINER')
  @Get('trainer/clients')
  listClients(
    @CurrentUser() user: AuthUser,
    @Query() query: ClientsQueryDto,
  ): Promise<ClientListItem[]> {
    return this.clients.list(user.id, query);
  }

  @Roles('TRAINER')
  @Get('trainer/clients/:id')
  getClient(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<ClientDetail> {
    return this.clients.get(user.id, id);
  }

  @Roles('TRAINER')
  @Patch('trainer/clients/:id')
  updateClient(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: UpdateClientDto,
  ): Promise<ClientDetail> {
    return this.clients.update(user.id, id, body);
  }

  // ------------------------------------------------------------------ packages

  @Roles('TRAINER')
  @Get('trainer/clients/:id/packages')
  listForClient(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<Package[]> {
    return this.packages.listForClient(user.id, id);
  }

  @Roles('TRAINER')
  @Post('trainer/clients/:id/packages')
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: CreatePackageDto,
  ): Promise<Package> {
    return this.packages.create(user.id, id, body);
  }

  @Roles('TRAINER')
  @Patch('trainer/packages/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: UpdatePackageDto,
  ): Promise<Package> {
    return this.packages.update(user.id, id, body);
  }

  @Roles('TRAINER')
  @Post('trainer/packages/:id/extend')
  @HttpCode(200)
  extend(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: ExtendPackageDto,
  ): Promise<Package> {
    return this.packages.extend(user.id, id, body);
  }

  @Roles('TRAINER')
  @Post('trainer/packages/:id/adjust')
  @HttpCode(200)
  adjust(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: AdjustPackageDto,
  ): Promise<Package> {
    return this.packages.adjust(user.id, id, body);
  }

  // ------------------------------------------------------------------ package types

  @Roles('TRAINER')
  @Get('trainer/package-types')
  listTypes(
    @CurrentUser() user: AuthUser,
    @Query() query: PackageTypesQueryDto,
  ): Promise<PackageType[]> {
    return this.packages.listTypes(user.id, query);
  }

  @Roles('TRAINER')
  @Post('trainer/package-types')
  @HttpCode(201)
  createType(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePackageTypeDto,
  ): Promise<PackageType> {
    return this.packages.createType(user.id, body);
  }

  @Roles('TRAINER')
  @Get('trainer/package-types/:id')
  getType(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<PackageType> {
    return this.packages.getType(user.id, id);
  }

  @Roles('TRAINER')
  @Patch('trainer/package-types/:id')
  updateType(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: UpdatePackageTypeDto,
  ): Promise<PackageType> {
    return this.packages.updateType(user.id, id, body);
  }

  @Roles('TRAINER')
  @Delete('trainer/package-types/:id')
  @HttpCode(204)
  archiveType(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<void> {
    return this.packages.archiveType(user.id, id);
  }

  // ------------------------------------------------------------------ client

  @Roles('CLIENT')
  @Get('client/packages')
  clientPackages(@CurrentUser() user: AuthUser): Promise<ClientPackage[]> {
    return this.packages.clientPackages(user.id);
  }
}
