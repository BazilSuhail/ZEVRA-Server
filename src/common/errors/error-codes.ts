import { HttpStatus } from '@nestjs/common';

export type HttpErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export type SocketErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_AUTHENTICATED'
  | 'NOT_MEMBER'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export function httpStatusToErrorCode(status: number): HttpErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_ERROR';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'PAYLOAD_TOO_LARGE';
    default:
      return status >= 400 && status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
  }
}

export function httpStatusToSocketCode(status: number): SocketErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
    case HttpStatus.CONFLICT:
      return 'VALIDATION_ERROR';
    case HttpStatus.UNAUTHORIZED:
      return 'NOT_AUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'NOT_MEMBER';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'PAYLOAD_TOO_LARGE';
    default:
      return 'INTERNAL_ERROR';
  }
}

export interface PgErrorMapping {
  status: number;
  error: HttpErrorCode;
  message: string;
}

/**
 * Maps a node-postgres driver error (which carries a SQLSTATE `code`) to a
 * client-safe status/code/message. Returns null when the value is not a
 * recognisable database error. Driver text is never included.
 */
export function mapPgError(err: unknown): PgErrorMapping | null {
  const pg = findPgError(err);
  if (!pg) return null;
  switch (pg.code) {
    case '23505':
      return { status: HttpStatus.CONFLICT, error: 'CONFLICT', message: 'Resource already exists' };
    case '23503':
      return { status: HttpStatus.NOT_FOUND, error: 'NOT_FOUND', message: 'Referenced resource not found' };
    case '22P02':
    case '22001':
    case '22003':
    case '23502':
    case '23514':
      return { status: HttpStatus.BAD_REQUEST, error: 'VALIDATION_ERROR', message: 'Invalid input' };
    default:
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
      };
  }
}

function findPgError(err: unknown): { code: string } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
