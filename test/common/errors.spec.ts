import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { ThrottlerException } from '@nestjs/throttler';
import { SocketError, toSocketError } from '../../src/common/errors/socket-error';
import { mapPgError } from '../../src/common/errors/error-codes';
import { AllExceptionsFilter, normalizeException } from '../../src/common/filters/all-exceptions.filter';

function pgError(code: string, message = 'duplicate key value violates unique constraint "users_email_unique"') {
  return Object.assign(new Error(message), { code });
}

describe('normalizeException (HTTP error shape)', () => {
  it('maps validation errors with details', () => {
    const err = new BadRequestException({ message: 'username too short', details: ['username too short', 'email invalid'] });
    expect(normalizeException(err)).toEqual({
      status: 400,
      error: 'VALIDATION_ERROR',
      message: 'username too short',
      details: ['username too short', 'email invalid'],
    });
  });

  it('maps default ValidationPipe array messages into details', () => {
    const err = new BadRequestException(['a must be a string', 'b must be an int']);
    const n = normalizeException(err);
    expect(n.error).toBe('VALIDATION_ERROR');
    expect(n.message).toBe('a must be a string');
    expect(n.details).toEqual(['a must be a string', 'b must be an int']);
  });

  it.each([
    [new UnauthorizedException('nope'), 401, 'UNAUTHORIZED'],
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new NotFoundException('User not found'), 404, 'NOT_FOUND'],
    [new ConflictException('Username already taken'), 409, 'CONFLICT'],
    [new HttpException('x', HttpStatus.PAYLOAD_TOO_LARGE), 413, 'PAYLOAD_TOO_LARGE'],
  ])('maps %p', (err, status, code) => {
    const n = normalizeException(err);
    expect(n.status).toBe(status);
    expect(n.error).toBe(code);
  });

  it('maps ThrottlerException to RATE_LIMITED with a friendly message', () => {
    const n = normalizeException(new ThrottlerException());
    expect(n).toMatchObject({ status: 429, error: 'RATE_LIMITED' });
    expect(n.message).not.toMatch(/Throttler/);
  });

  it('hides 5xx HttpException messages', () => {
    const n = normalizeException(new InternalServerErrorException('secret internals'));
    expect(n).toEqual({ status: 500, error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  it('maps pg unique violation to CONFLICT without driver text', () => {
    const n = normalizeException(pgError('23505'));
    expect(n.status).toBe(409);
    expect(n.error).toBe('CONFLICT');
    expect(n.message).not.toMatch(/duplicate key/);
  });

  it('maps pg invalid text representation and FK violations', () => {
    expect(normalizeException(pgError('22P02')).error).toBe('VALIDATION_ERROR');
    expect(normalizeException(pgError('23503')).error).toBe('NOT_FOUND');
  });

  it('finds pg errors wrapped in a cause (drizzle)', () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: pgError('23505') });
    expect(mapPgError(wrapped)?.error).toBe('CONFLICT');
  });

  it('maps unknown errors to INTERNAL_ERROR', () => {
    expect(normalizeException(new Error('boom: password=123'))).toEqual({
      status: 500,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });

  it('maps body-parser errors', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, expose: true, type: 'entity.too.large' });
    expect(normalizeException(tooLarge).error).toBe('PAYLOAD_TOO_LARGE');
    const malformed = Object.assign(new Error('Unexpected token'), { status: 400, expose: true, type: 'entity.parse.failed' });
    expect(normalizeException(malformed)).toMatchObject({ status: 400, message: 'Malformed request body' });
  });
});

describe('AllExceptionsFilter', () => {
  it('writes the contract body', () => {
    const json = jest.fn();
    const res: any = { headersSent: false, setHeader: jest.fn(), status: jest.fn(() => ({ json })) };
    const req: any = { method: 'GET', url: '/x', originalUrl: '/x', headers: {}, requestId: 'req-12345678' };
    const host: any = {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    };
    new AllExceptionsFilter().catch(new NotFoundException('User not found'), host);
    expect(res.status).toHaveBeenCalledWith(404);
    const body = json.mock.calls[0][0];
    expect(body).toMatchObject({
      success: false,
      statusCode: 404,
      error: 'NOT_FOUND',
      message: 'User not found',
      path: '/x',
      requestId: 'req-12345678',
    });
    expect(typeof body.timestamp).toBe('string');
  });
});

describe('toSocketError', () => {
  it('uses explicit SocketError codes', () => {
    expect(toSocketError(new SocketError('NOT_MEMBER', 'Not a member'))).toEqual({
      success: false,
      error: 'NOT_MEMBER',
      message: 'Not a member',
    });
  });

  it('maps HttpExceptions', () => {
    expect(toSocketError(new UnauthorizedException('x')).error).toBe('NOT_AUTHENTICATED');
    expect(toSocketError(new ForbiddenException('x')).error).toBe('NOT_MEMBER');
    expect(toSocketError(new NotFoundException('gone'))).toEqual({ success: false, error: 'NOT_FOUND', message: 'gone' });
    expect(toSocketError(new BadRequestException(['first', 'second'])).message).toBe('first');
  });

  it('maps WsException payloads', () => {
    expect(toSocketError(new WsException({ error: 'RATE_LIMITED', message: 'slow down' }))).toEqual({
      success: false,
      error: 'RATE_LIMITED',
      message: 'slow down',
    });
    expect(toSocketError(new WsException('bad input')).error).toBe('VALIDATION_ERROR');
  });

  it('never leaks unknown or driver errors', () => {
    expect(toSocketError(new Error('ECONNREFUSED 10.0.0.1'))).toEqual({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(toSocketError(pgError('23505')).message).not.toMatch(/duplicate/);
  });
});
