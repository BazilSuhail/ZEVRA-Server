import { ExceptionFilter, ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { Logger } from '@nestjs/common';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const message = exception.getResponse();
    const requestId = (request as any).requestId;

    this.logger.error(
      `${exception.message} — ${request.method} ${request.url}${requestId ? ` — req=${requestId}` : ''}`,
    );

    response.status(status).json({
      success: false,
      statusCode: status,
      timestamp: new Date().toISOString(),
      requestId,
      path: request.url,
      message: typeof message === 'string' ? message : (message as any).message || message,
    });
  }
}
