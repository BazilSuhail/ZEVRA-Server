import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

/**
 * Fixed-window counter, atomic in one round trip: INCR and (on the first hit
 * of a window, or if the TTL was lost) PEXPIRE. Returns [count, pttl].
 */
const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private failureLogged = false;

  constructor(private redisService: RedisService) {}

  /**
   * @param key `{scope}:{id}` — stored as `zevra:ratelimit:{scope}:{id}`.
   * Fails open (allows) when Redis is unavailable; the outage is logged once.
   */
  async checkRateLimit(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    const client = this.redisService.getClient();
    if (!client) {
      this.logFailureOnce('Redis unavailable');
      return { allowed: true, remaining: config.maxRequests, resetMs: 0 };
    }

    try {
      const reply = (await client.eval(FIXED_WINDOW_SCRIPT, {
        keys: [`zevra:ratelimit:${key}`],
        arguments: [String(config.windowMs)],
      })) as unknown as [number, number];
      this.failureLogged = false;

      const count = Number(reply?.[0] ?? 0);
      const ttl = Number(reply?.[1] ?? config.windowMs);
      return {
        allowed: count <= config.maxRequests,
        remaining: Math.max(0, config.maxRequests - count),
        resetMs: Date.now() + Math.max(0, ttl),
      };
    } catch (err) {
      this.logFailureOnce((err as Error).message);
      return { allowed: true, remaining: config.maxRequests, resetMs: 0 };
    }
  }

  private logFailureOnce(reason: string) {
    if (this.failureLogged) return;
    this.failureLogged = true;
    this.logger.error(`Rate limiting degraded (failing open): ${reason}`);
  }

  static readonly SEND_MESSAGE: RateLimitConfig = { windowMs: 1000, maxRequests: 20 };
  static readonly TYPING: RateLimitConfig = { windowMs: 1000, maxRequests: 10 };
  static readonly GET_MESSAGES: RateLimitConfig = { windowMs: 1000, maxRequests: 30 };
  static readonly REACTION: RateLimitConfig = { windowMs: 1000, maxRequests: 20 };
  static readonly CONNECTION_PER_IP: RateLimitConfig = { windowMs: 60_000, maxRequests: 120 };
}
