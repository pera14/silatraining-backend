import { Module } from '@nestjs/common';
import { AuthSessionService } from './auth-session.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/** FOUNDATION-OWNED: do not edit in the parallel phase. */
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthSessionService],
  exports: [AuthSessionService],
})
export class AuthModule {}
