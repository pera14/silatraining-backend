import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JoinController } from './join.controller';
import { JoinService } from './join.service';

/** FOUNDATION-OWNED: join links, QR, register/accept. */
@Module({ imports: [AuthModule], controllers: [JoinController], providers: [JoinService] })
export class JoinModule {}
