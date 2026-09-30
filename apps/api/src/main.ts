import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfig } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  configureApp(app);
  const config = app.get(AppConfig);
  const port = config.get('PORT');
  await app.listen(port);
  Logger.log(
    `API on http://localhost:${port}/api${config.isProduction ? '' : ` · docs http://localhost:${port}/api/docs`}`,
    'Bootstrap',
  );
}

void bootstrap();
