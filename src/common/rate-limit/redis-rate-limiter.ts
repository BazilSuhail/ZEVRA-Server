import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * Fixed-window counter executed atomically in Redis: INCR, set the window
 * expiry on the first hit (or if a TTL was somehow lost), return count + TTL.
 */
const FIXED_WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Milliseconds until the current window resets. */
  resetMs: number;
}

export const RATE_LIMIT_PREFIX = 'zevra:ratelimit';

@Injectable()
export class RedisRateLimiter {
  private readonly logger = new Logger(RedisRateLimiter.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Counts one hit for `zevra:ratelimit:{scope}:{key}` within `windowMs`.
   * Fails open (allowed) if Redis is unavailable, logging a warning.
   */
  async hit(scope: string, key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const { count, ttl } = await this.increment(`${RATE_LIMIT_PREFIX}:${scope}:${key}`, windowMs);
    return { allowed: count <= limit, count, limit, resetMs: ttl };
  }

  /** Raw atomic increment used by both the throttler storage and auth limits. */
  async increment(redisKey: string, windowMs: number): Promise<{ count: number; ttl: number }> {
    const client = this.redisService.getClient();
    if (!client) {
      this.logger.warn('Redis unavailable; rate limit not enforced');
      return { count: 0, ttl: windowMs };
    }
    try {
      const reply = (await client.eval(FIXED_WINDOW_LUA, {
        keys: [redisKey],
        arguments: [String(Math.max(1, Math.floor(windowMs)))],
      })) as unknown as [number, number];
      return { count: Number(reply[0]), ttl: Math.max(0, Number(reply[1])) };
    } catch (err) {
      this.logger.warn(`Rate limit check failed: ${(err as Error).message}`);
      return { count: 0, ttl: windowMs };
    }
  }
}
