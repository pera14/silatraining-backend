import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** Private object storage (Agent B). Import where files are needed; nothing connects at boot. */
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
