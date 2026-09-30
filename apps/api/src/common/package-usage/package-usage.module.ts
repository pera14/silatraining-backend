import { Global, Module } from '@nestjs/common';
import { PackageUsageService } from './package-usage.service';

@Global()
@Module({ providers: [PackageUsageService], exports: [PackageUsageService] })
export class PackageUsageModule {}
