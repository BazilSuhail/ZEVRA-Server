import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HttpErrorCode, httpStatusToErrorCode, mapPgError } from '../errors/error-codes';

export interface HttpErrorBody {
  success: false;
  statusCode: number;
  error: HttpErrorCode;
  message: string;
  details?: string[];
  path: string;
  timestamp: string;
  requestId: string;
}

interface NormalizedError {
  status: number;
  error: HttpErrorCode;
  message: string;
  details?: string[];
}

const GENERIC_MESSAGES: Record<HttpErrorCode, string> = {
  VALIDATION_ERROR: 'Invalid request',
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'Access denied',
  NOT_FOUND: 'Resource not found',
  CONFLICT: 'Resource already exists',
  RATE_LIMITED: 'Too many requests, please try again later',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  INTERNAL_ERROR: 'Internal server error',
};

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return out.length > 0 ? out : undefined;
}

function normalizeHttpException(exception: HttpException): NormalizedError {
  const status = exception.getStatus();
  const error = httpStatusToErrorCode(status);
  if (error === 'INTERNAL_ERROR' || error === 'RATE_LIMITED') {
    return { status, error, message: GENERIC_MESSAGES[error] };
  }

  const response = exception.getResponse();
  if (typeof response === 'string') {
    return { status, error, message: response || GENERIC_MESSAGES[error] };
  }

  const body = response as { message?: unknown; details?: unknown };
  const details = toStringArray(body.details) ?? toStringArray(body.message);
  let message: string;
  if (typeof body.message === 'string' && body.message.length > 0) {
    message = body.message;
  } else if (details) {
    message = details[0];
  } else {
    message = exception.message || GENERIC_MESSAGES[error];
  }
  return details ? { status, error, message, details } : { status, error, message };
}

/**
 * Errors raised by Express middleware (body-parser, multer) are plain
 * http-errors objects with a numeric `status` and a `type`.
 */
function normalizeMiddlewareError(exception: unknown): NormalizedError | null {
  if (!exception || typeof exception !== 'object') return null;
  const e = exception as { status?: unknown; statusCode?: unknown; type?: unknown; expose?: unknown };
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null;
  if (status === null || status < 400 || status > 599 || typeof e.expose !== 'boolean') return null;
  const error = httpStatusToErrorCode(status);
  if (e.type === 'entity.parse.failed') {
    return { status: HttpStatus.BAD_REQUEST, error: 'VALIDATION_ERROR', message: 'Malformed request body' };
  }
  return { status, error, message: GENERIC_MESSAGES[error] };
}

export function normalizeException(exception: unknown): NormalizedError {
  if (exception instanceof HttpException) {
    return normalizeHttpException(exception);
  }
  const pg = mapPgError(exception);
  if (pg) {
    return { status: pg.status, error: pg.error, message: pg.message };
  }
  const middleware = normalizeMiddlewareError(exception);
  if (middleware) return middleware;
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: 'INTERNAL_ERROR',
    message: GENERIC_MESSAGES.INTERNAL_ERROR,
  };
}

/**
 * Single global filter: every HTTP error leaves the server in the shape
 * defined by CONTRACT §2. Raw driver/internal messages are logged, never sent.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') {
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const normalized = normalizeException(exception);
    const requestId =
      request.requestId ?? (typeof request.headers?.['x-request-id'] === 'string'
        ? (request.headers['x-request-id'] as string)
        : randomUUID());
    const path = request.originalUrl ?? request.url;

    if (normalized.status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`${request.method} ${path} req=${requestId} ${err.message}`, err.stack);
    }

    const body: HttpErrorBody = {
      success: false,
      statusCode: normalized.status,
      error: normalized.error,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
      path,
      timestamp: new Date().toISOString(),
      requestId,
    };

    if (response.headersSent) {
      response.end();
      return;
    }
    response.setHeader('X-Request-Id', requestId);
    response.status(normalized.status).json(body);
  }
}
