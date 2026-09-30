import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Me } from '@sila/contracts';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { bodyDto } from '../../common/http/zod-dto';
import { UsersService } from './users.service';

class UpdateProfileDto extends bodyDto('client.profile.update') {}

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<Me> {
    return this.users.getMe(user.id);
  }

  @Patch('trainer/profile')
  @Roles('TRAINER')
  updateTrainerProfile(@CurrentUser() user: AuthUser, @Body() body: UpdateProfileDto): Promise<Me> {
    return this.users.updateProfile(user.id, body);
  }

  @Patch('client/profile')
  @Roles('CLIENT')
  updateClientProfile(@CurrentUser() user: AuthUser, @Body() body: UpdateProfileDto): Promise<Me> {
    return this.users.updateProfile(user.id, body);
  }
}
