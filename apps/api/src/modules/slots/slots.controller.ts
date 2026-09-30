import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  endpoints,
  type EndpointBody,
  type CalendarResponse,
  type ClientSlot,
  type CreateSlotsResponse,
  type LockRangeResponse,
  type SlotSeries,
  type TrainerSlot,
} from '@sila/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { bodyDto, paramsDto, queryDto } from '../../common/http/zod-dto';
import { SeriesService } from './series.service';
import { SlotsService } from './slots.service';

class IdParams extends paramsDto('trainer.slots.update') {}
class RangeQueryDto extends queryDto('trainer.calendar') {}
/** A union (single | bulk) cannot be a DTO class, so this body gets an explicit pipe with the contract schema. */
const createSlotsPipe = new ZodValidationPipe(endpoints['trainer.slots.create'].body);
class UpdateSlotDto extends bodyDto('trainer.slots.update') {}
class LockRangeDto extends bodyDto('trainer.slots.lockRange') {}
class CreateSeriesDto extends bodyDto('trainer.slotSeries.create') {}
class UpdateSeriesDto extends bodyDto('trainer.slotSeries.update') {}

@ApiTags('slots')
@ApiBearerAuth()
@Controller()
export class SlotsController {
  constructor(
    private readonly slots: SlotsService,
    private readonly series: SeriesService,
  ) {}

  // ------------------------------------------------------------------ trainer: calendar + slots

  @Roles('TRAINER')
  @Get('trainer/calendar')
  calendar(
    @CurrentUser() user: AuthUser,
    @Query() query: RangeQueryDto,
  ): Promise<CalendarResponse> {
    return this.slots.calendar(user.id, query);
  }

  @Roles('TRAINER')
  @Post('trainer/slots')
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Body(createSlotsPipe) body: EndpointBody<'trainer.slots.create'>,
  ): Promise<CreateSlotsResponse> {
    return this.slots.create(user.id, body);
  }

  // Declared before `trainer/slots/:id` routes for readability; methods differ anyway.
  @Roles('TRAINER')
  @Post('trainer/slots/lock-range')
  @HttpCode(200)
  lockRange(@CurrentUser() user: AuthUser, @Body() body: LockRangeDto): Promise<LockRangeResponse> {
    return this.slots.lockRange(user.id, body);
  }

  @Roles('TRAINER')
  @Patch('trainer/slots/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: UpdateSlotDto,
  ): Promise<TrainerSlot> {
    return this.slots.update(user.id, id, body);
  }

  @Roles('TRAINER')
  @Delete('trainer/slots/:id')
  @HttpCode(204)
  delete(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<void> {
    return this.slots.delete(user.id, id);
  }

  // ------------------------------------------------------------------ trainer: series

  @Roles('TRAINER')
  @Get('trainer/slot-series')
  listSeries(@CurrentUser() user: AuthUser): Promise<SlotSeries[]> {
    return this.series.list(user.id);
  }

  @Roles('TRAINER')
  @Post('trainer/slot-series')
  @HttpCode(201)
  createSeries(@CurrentUser() user: AuthUser, @Body() body: CreateSeriesDto): Promise<SlotSeries> {
    return this.series.create(user.id, body);
  }

  @Roles('TRAINER')
  @Patch('trainer/slot-series/:id')
  updateSeries(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParams,
    @Body() body: UpdateSeriesDto,
  ): Promise<SlotSeries> {
    return this.series.update(user.id, id, body);
  }

  @Roles('TRAINER')
  @Delete('trainer/slot-series/:id')
  @HttpCode(204)
  deleteSeries(@CurrentUser() user: AuthUser, @Param() { id }: IdParams): Promise<void> {
    return this.series.delete(user.id, id);
  }

  // ------------------------------------------------------------------ client

  @Roles('CLIENT')
  @Get('client/slots')
  clientSlots(@CurrentUser() user: AuthUser, @Query() query: RangeQueryDto): Promise<ClientSlot[]> {
    return this.slots.clientSlots(user.id, query);
  }
}
