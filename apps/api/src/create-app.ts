import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { apiKeyMiddleware } from './common/api-key.middleware';
import type { Environment } from './config/environment';

/** Builds the app with the key check in front of every route. No Swagger. */
export async function createApp(
  env: Environment,
  options: { logger?: false } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    options,
  );
  app.disable('x-powered-by');
  app.use(apiKeyMiddleware(env.API_KEY));
  app.setGlobalPrefix('api');
  return app;
}
