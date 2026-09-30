import { Controller, Get, Header, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CalendarFeedResponse } from '@sila/contracts';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { paramsDto } from '../../common/http/zod-dto';
import { CalendarFeedService } from './calendar-feed.service';

class FeedParams extends paramsDto('calendarFeed.ics') {}

@ApiTags('calendar-feed')
@Controller()
export class CalendarFeedController {
  constructor(private readonly service: CalendarFeedService) {}

  @ApiBearerAuth()
  @Roles('TRAINER')
  @Get('trainer/calendar-feed')
  get(@CurrentUser() user: AuthUser): Promise<CalendarFeedResponse> {
    return this.service.get(user.id);
  }

  @ApiBearerAuth()
  @Roles('TRAINER')
  @Post('trainer/calendar-feed/regenerate')
  @HttpCode(200)
  regenerate(@CurrentUser() user: AuthUser): Promise<CalendarFeedResponse> {
    return this.service.regenerate(user.id);
  }

  /** Public: the unguessable token is the credential (calendar apps cannot send auth headers). */
  @Public()
  @Get('calendar/:token.ics')
  @Header('Cache-Control', 'private, max-age=300')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async ics(
    @Param() { token }: FeedParams,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const body = await this.service.render(token);
    res.type('text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="sila-practices.ics"');
    return body;
  }
}
