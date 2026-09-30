import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env';

/** Typed, validated configuration. Inject this instead of reading process.env. */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get appUrl(): string {
    return this.get('APP_URL').replace(/\/$/, '');
  }

  get timezone(): string {
    return this.get('APP_TIMEZONE');
  }
}
