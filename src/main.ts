import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { createValidationPipe } from './common/pipes/validation';
import { getCorsOrigins, validateEnv } from './common/config';

const logger = new Logger('Bootstrap');
const SHUTDOWN_TIMEOUT_MS = 10_000;

let app: NestExpressApplication | undefined;
let shuttingDown = false;

async function shutdownAfterFatal(reason: string, err: unknown): Promise<void> {
  logger.error(reason, err instanceof Error ? err.stack : String(err));
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    await app?.close();
  } catch (closeErr) {
    logger.error(`Error during shutdown: ${(closeErr as Error).message}`);
  } finally {
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason instanceof Error ? reason.stack : String(reason));
});

process.on('uncaughtException', (err) => {
  void shutdownAfterFatal('Uncaught exception', err);
});

async function bootstrap() {
  validateEnv();

  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    rawBody: true,
  });

  // LiveKit webhooks are sent as application/webhook+json; parse them as JSON
  // so the raw body is captured for signature verification.
  app.useBodyParser('json', { type: 'application/webhook+json', limit: '1mb' });

  if (process.env.TRUST_PROXY) {
    const value = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value);
  }

  app.use(helmet());

  const origins = getCorsOrigins();
  app.enableCors({
    origin: origins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Authorization, X-Request-Id',
    exposedHeaders: 'X-Request-Id, Retry-After',
    credentials: true,
  });

  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());

  // SIGTERM/SIGINT → app.close(): runs onModuleDestroy/onApplicationShutdown
  // hooks (HTTP server, Socket.IO, Redis clients, pg pool).
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  logger.log(`Listening on port ${port} (CORS origins: ${origins.join(', ') || 'none'})`);
}

bootstrap().catch((err) => {
  logger.error('Failed to start', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
