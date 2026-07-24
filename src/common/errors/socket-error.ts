import { HttpException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { httpStatusToSocketCode, mapPgError, SocketErrorCode } from './error-codes';

export type { SocketErrorCode } from './error-codes';

export interface SocketErrorAck {
  success: false;
  error: SocketErrorCode;
  message: string;
}

const SOCKET_CODES: ReadonlySet<string> = new Set<SocketErrorCode>([
  'VALIDATION_ERROR',
  'NOT_AUTHENTICATED',
  'NOT_MEMBER',
  'NOT_FOUND',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
]);

/**
 * Error carrying an explicit socket ack code. Throw it from socket handlers
 * (or services they call) and convert with `toSocketError`.
 */
export class SocketError extends Error {
  constructor(
    public readonly code: SocketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SocketError';
  }
}

export function socketError(code: SocketErrorCode, message: string): SocketErrorAck {
  return { success: false, error: code, message };
}

function isSocketCode(value: unknown): value is SocketErrorCode {
  return typeof value === 'string' && SOCKET_CODES.has(value);
}

function firstMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * Converts any thrown value into the socket ack failure shape
 * `{ success: false, error, message }` (CONTRACT §3). Unknown errors and raw
 * database errors never leak driver text.
 */
export function toSocketError(err: unknown): SocketErrorAck {
  if (err instanceof SocketError) {
    return socketError(err.code, err.message);
  }

  if (err instanceof WsException) {
    const payload = err.getError();
    if (typeof payload === 'string') {
      return isSocketCode(payload)
        ? socketError(payload, payload)
        : socketError('VALIDATION_ERROR', payload);
    }
    if (payload && typeof payload === 'object') {
      const obj = payload as { error?: unknown; code?: unknown; message?: unknown };
      const code = isSocketCode(obj.error) ? obj.error : isSocketCode(obj.code) ? obj.code : 'VALIDATION_ERROR';
      return socketError(code, firstMessage(obj.message) ?? 'Request failed');
    }
    return socketError('VALIDATION_ERROR', 'Request failed');
  }

  if (err instanceof HttpException) {
    const status = err.getStatus();
    const code = httpStatusToSocketCode(status);
    if (code === 'INTERNAL_ERROR') {
      return socketError(code, 'Internal server error');
    }
    const response = err.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : firstMessage((response as { message?: unknown }).message) ?? err.message;
    return socketError(code, message);
  }

  const pg = mapPgError(err);
  if (pg) {
    const code = httpStatusToSocketCode(pg.status);
    return socketError(code, pg.message);
  }

  return socketError('INTERNAL_ERROR', 'Internal server error');
}
