import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { RedisRateLimiter } from '../rate-limit/redis-rate-limiter';

export interface RouteRateLimit {
  /** Scope used in the Redis key: zevra:ratelimit:{scope}:{ip|user}:{id}. */
  scope: string;
  limit: number;
  windowMs: number;
  /** Also count per `body.username` (lower-cased) in addition to per IP. */
  byUsername?: boolean;
  /** Count per authenticated user instead of per IP. */
  byUser?: boolean;
}

const RATE_LIMIT_KEY = 'zevra:route-rate-limit';

export const RateLimit = (options: RouteRateLimit) => SetMetadata(RATE_LIMIT_KEY, options);

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Route-level rate limit backed by an atomic Redis counter. Used for auth
 * endpoints (per IP and per username) and uploads (per user). Apply with
 * `@UseGuards(RateLimitGuard)` plus `@RateLimit({...})`. When `byUser` is
 * set the guard must run after the JWT guard.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RedisRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RouteRateLimit | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options || context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const keys: string[] = [];

    if (options.byUser && req.user?.id) {
      keys.push(`user:${req.user.id}`);
    } else {
      keys.push(`ip:${hashKey(String(req.ip ?? 'unknown'))}`);
    }
    if (options.byUsername && typeof req.body?.username === 'string' && req.body.username.length > 0) {
      keys.push(`username:${hashKey(req.body.username.trim().toLowerCase())}`);
    }

    for (const key of keys) {
      const result = await this.limiter.hit(options.scope, key, options.limit, options.windowMs);
      if (!result.allowed) {
        res.setHeader?.('Retry-After', String(Math.max(1, Math.ceil(result.resetMs / 1000))));
        throw new HttpException(
          'Too many requests, please try again later',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }
}
