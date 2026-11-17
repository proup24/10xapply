import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { Logger, type LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { apiKeyMiddleware, isIntakePost } from './common/api-key.middleware';
import type { Environment } from './config/environment';

/** Nest's own body parser is off: only the intake route reads a body, raw. */
export const APP_OPTIONS = { bodyParser: false } as const;

/** Builds the app with the key check in front of every route. No Swagger. */
export async function createApp(
  env: Environment,
  options: { logger?: false | LoggerService } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(env),
    { ...options, ...APP_OPTIONS },
  );
  configureApp(app, env);
  return app;
}

/**
 * The middleware and prefix every app gets. Exported so a test can apply it
 * to an app built from a testing module with an overridden provider.
 */
export function configureApp(
  app: NestExpressApplication,
  env: Environment,
): void {
  app.disable('x-powered-by');
  app.use(apiKeyMiddleware(env.API_KEY));
  // Intake only: the exact bytes as a Buffer (any content type) for the HMAC.
  // `inflate: false`: the signature is over the wire bytes, so a compressed
  // body is refused (415) rather than inflated and checked as something else.
  const raw = express.raw({ type: () => true, limit: '1mb', inflate: false });
  const logger = new Logger('IntakeBody');
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isIntakePost(req.method, req.path)) {
      next();
      return;
    }
    raw(req, res, (error?: unknown) => {
      if (error === undefined || error === null) {
        next();
        return;
      }
      // A fixed JSON body: never Express's HTML page, a stack or the request body.
      // A fixed log line too: no body, no path (it holds the token).
      const status = statusOf(error);
      logger.log(`intake: rejected ${status}`);
      res.status(status).json({ error: errorName(status) });
    });
  });
  app.setGlobalPrefix('api');
}

function errorName(status: number): string {
  if (status === 413) return 'payload-too-large';
  if (status === 415) return 'unsupported-encoding';
  return 'bad-request';
}

/** The 4xx status a body-parser error carries, else 400. */
function statusOf(error: unknown): number {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? error.status
      : undefined;
  return typeof status === 'number' && status >= 400 && status < 500
    ? status
    : 400;
}
