import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisRateLimiter, RATE_LIMIT_PREFIX } from './redis-rate-limiter';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed storage for @nestjs/throttler so limits hold across
 * instances and restarts. Fixed window; once over the limit the caller stays
 * blocked until the window expires. Times are returned in seconds, matching
 * the in-memory storage shipped with the throttler.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly limiter: RedisRateLimiter) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const { count, ttl: remainingMs } = await this.limiter.increment(
      `${RATE_LIMIT_PREFIX}:http-${throttlerName}:${key}`,
      ttl,
    );
    const seconds = Math.ceil(remainingMs / 1000);
    const isBlocked = count > limit;
    return {
      totalHits: count,
      timeToExpire: seconds,
      isBlocked,
      timeToBlockExpire: isBlocked ? seconds : 0,
    };
  }
}
