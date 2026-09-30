import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { cleanupOpenApiDoc, ZodValidationPipe } from 'nestjs-zod';
import { AppConfig } from './config/app-config.service';

/**
 * Everything `main.ts` applies to the app, shared with the e2e suite so tests exercise the real setup.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);
  const express = app as NestExpressApplication;

  app.setGlobalPrefix('api');
  // Behind Caddy (prod) or the Next.js dev proxy: trust private-network proxies so req.ip is the client
  // (rate limiting is per client IP).
  express.set('trust proxy', 'loopback, linklocal, uniquelocal');
  express.disable('x-powered-by');

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.appUrl, credentials: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.enableShutdownHooks();

  if (!config.isProduction) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('SILA Training API')
        .setDescription('Schemas come from @sila/contracts. Errors: { code, message, details? }.')
        .setVersion('0.1')
        .addBearerAuth()
        .addCookieAuth('sila_refresh')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(doc));
  }
}
