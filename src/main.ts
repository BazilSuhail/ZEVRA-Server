import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './common/exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Global CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true,
  });
  
  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());
  
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  
  const logger = new Logger('NestJS');
  logger.log(`🚀 Application running on http://localhost:${port}`);
}
bootstrap();