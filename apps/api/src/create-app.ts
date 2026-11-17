import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { apiKeyMiddleware, isIntakePost } from './common/api-key.middleware';
import type { Environment } from './config/environment';

/** Builds the app with the key check in front of every route. No Swagger. */
export async function createApp(
  env: Environment,
  options: { logger?: false } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(env),
    { ...options, bodyParser: false },
  );
  app.disable('x-powered-by');
  app.use(apiKeyMiddleware(env.API_KEY));
  // Intake only: the exact bytes as a Buffer (any content type) for the HMAC.
  const raw = express.raw({ type: () => true, limit: '1mb' });
  app.use((req: Request, res: Response, next: NextFunction) =>
    isIntakePost(req.method, req.path) ? raw(req, res, next) : next(),
  );
  app.setGlobalPrefix('api');
  return app;
}
