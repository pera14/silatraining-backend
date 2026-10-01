/**
 * FROZEN after Phase 0 (tag v0.1-foundation). Every feature module is already registered below, so the
 * parallel agents never need to edit this file. Add providers/controllers inside your own module instead.
 */
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
import { DEFAULT_THROTTLE } from './common/http/throttle';
import { MailerModule } from './common/mailer/mailer.module';
import { OwnershipModule } from './common/ownership/ownership.module';
import { PackageUsageModule } from './common/package-usage/package-usage.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { ConfigModule } from './config/config.module';
// foundation
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { JoinModule } from './modules/join/join.module';
import { UsersModule } from './modules/users/users.module';
// Agent A (feat/scheduling)
import { PackagesModule } from './modules/packages/packages.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { SlotsModule } from './modules/slots/slots.module';
// Agent B (feat/content)
import { CalendarFeedModule } from './modules/calendar-feed/calendar-feed.module';
import { ClientDataModule } from './modules/client-data/client-data.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ExercisesModule } from './modules/exercises/exercises.module';
import { NotesModule } from './modules/notes/notes.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PlansModule } from './modules/plans/plans.module';

@Module({
  imports: [
    // infrastructure (global)
    ConfigModule,
    PrismaModule,
    MailerModule,
    OwnershipModule,
    PackageUsageModule,
    JwtModule.register({ global: true }),
    ThrottlerModule.forRoot({ throttlers: [DEFAULT_THROTTLE] }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({ wildcard: false }),
    // foundation
    HealthModule,
    AuthModule,
    UsersModule,
    JoinModule,
    // Agent A
    SlotsModule,
    SessionsModule,
    PackagesModule,
    // Agent B
    NotesModule,
    ExercisesModule,
    PlansModule,
    DocumentsModule,
    NotificationsModule,
    CalendarFeedModule,
    // integration (SPEC §7 privacy)
    ClientDataModule,
  ],
  providers: [
    // Order matters: rate limit, then authenticate, then authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
