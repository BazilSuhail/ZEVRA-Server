import { RateLimitService } from '../../../src/shared/rate-limit/rate-limit.service';

describe('RateLimitService', () => {
  let service: RateLimitService;

  beforeEach(() => {
    service = new RateLimitService({ getClient: () => null } as any);
  });

  it('allows all requests when Redis is null (degraded mode)', async () => {
    const result = await service.checkRateLimit('test', { windowMs: 1000, maxRequests: 5 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
  });

  it('returns correct config presets', () => {
    expect(RateLimitService.SEND_MESSAGE.maxRequests).toBe(500);
    expect(RateLimitService.TYPING.maxRequests).toBe(200);
    expect(RateLimitService.GET_MESSAGES.maxRequests).toBe(1000);
    expect(RateLimitService.CONNECTION_PER_IP.maxRequests).toBe(2000);
  });

  it('allows requests when Redis throws (fail open)', async () => {
    const mockRedis = {
      getClient: jest.fn().mockReturnValue({
        multi: jest.fn().mockReturnValue({
          ZREMRANGEBYSCORE: jest.fn(),
          ZADD: jest.fn(),
          ZCARD: jest.fn(),
          PEXPIRE: jest.fn(),
          exec: jest.fn().mockRejectedValue(new Error('Redis down')),
        }),
      }),
    };
    service = new RateLimitService(mockRedis as any);

    const result = await service.checkRateLimit('test', { windowMs: 1000, maxRequests: 5 });
    expect(result.allowed).toBe(true);
  });

  it('generates unique window keys per time slot', () => {
    const windowMs = 1000;
    const slot1 = Math.floor(1787854458000 / windowMs);
    const slot2 = Math.floor(1787854458500 / windowMs);
    const slot3 = Math.floor(1787854459000 / windowMs);

    expect(slot1).toBe(slot2); // Same window
    expect(slot3).toBe(slot1 + 1); // Next window
  });

  it('should allow within limit with Redis', async () => {
    const mockMulti = {
      ZREMRANGEBYSCORE: jest.fn().mockReturnThis(),
      ZADD: jest.fn().mockReturnThis(),
      ZCARD: jest.fn().mockReturnThis(),
      PEXPIRE: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([0, 'OK', 1, 'OK']),
    };
    const mockRedis = { getClient: jest.fn().mockReturnValue({ multi: () => mockMulti }) };
    service = new RateLimitService(mockRedis as any);

    const result = await service.checkRateLimit('test:user1', { windowMs: 1000, maxRequests: 5 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should block when exceeding limit with Redis', async () => {
    const mockMulti = {
      ZREMRANGEBYSCORE: jest.fn().mockReturnThis(),
      ZADD: jest.fn().mockReturnThis(),
      ZCARD: jest.fn().mockReturnThis(),
      PEXPIRE: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([0, 'OK', 6, 'OK']),
    };
    const mockRedis = { getClient: jest.fn().mockReturnValue({ multi: () => mockMulti }) };
    service = new RateLimitService(mockRedis as any);

    const result = await service.checkRateLimit('test:user1', { windowMs: 1000, maxRequests: 5 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('should use different keys for different users', async () => {
    const mockMulti = {
      ZREMRANGEBYSCORE: jest.fn().mockReturnThis(),
      ZADD: jest.fn().mockReturnThis(),
      ZCARD: jest.fn().mockReturnThis(),
      PEXPIRE: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([0, 'OK', 0, 'OK']),
    };
    const mockRedis = { getClient: jest.fn().mockReturnValue({ multi: () => mockMulti }) };
    service = new RateLimitService(mockRedis as any);

    await service.checkRateLimit('test:user1', { windowMs: 1000, maxRequests: 5 });
    await service.checkRateLimit('test:user2', { windowMs: 1000, maxRequests: 5 });
    expect(mockMulti.ZADD).toHaveBeenCalledTimes(2);
  });
});
