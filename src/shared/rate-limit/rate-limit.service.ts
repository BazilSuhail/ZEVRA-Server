import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private redisService: RedisService) {}

  async checkRateLimit(
    key: string,
    config: RateLimitConfig,
  ): Promise<RateLimitResult> {
    const client = this.redisService.getClient();
    if (!client) {
      // No Redis — allow all (degraded mode)
      return { allowed: true, remaining: config.maxRequests, resetMs: 0 };
    }

    const now = Date.now();
    const windowStart = now - config.windowMs;
    const windowKey = `ratelimit:${key}:${Math.floor(now / config.windowMs)}`;

    try {
      const multi = client.multi();
      multi.ZREMRANGEBYSCORE(windowKey, 0, windowStart);
      multi.ZADD(windowKey, { score: now, value: `${now}-${Math.random().toString(36).slice(2, 8)}` });
      multi.ZCARD(windowKey);
      multi.PEXPIRE(windowKey, config.windowMs + 1000);

      const results = await multi.exec();
      const count = Number(results[2] ?? 0);
      const remaining = Math.max(0, config.maxRequests - count);
      const resetMs = windowStart + config.windowMs;

      return { allowed: count <= config.maxRequests, remaining, resetMs };
    } catch (err) {
      this.logger.error(`Rate limit check failed: ${(err as Error).message}`);
      // Fail open — allow on error
      return { allowed: true, remaining: config.maxRequests, resetMs: 0 };
    }
  }

  // Predefined rate limit configs
  static readonly SEND_MESSAGE: RateLimitConfig = { windowMs: 1000, maxRequests: 500 };
  static readonly TYPING: RateLimitConfig = { windowMs: 1000, maxRequests: 200 };
  static readonly GET_MESSAGES: RateLimitConfig = { windowMs: 1000, maxRequests: 1000 };
  static readonly CONNECTION_PER_IP: RateLimitConfig = { windowMs: 60_000, maxRequests: 2000 };
}
