import { RateLimitService } from '../../../src/shared/rate-limit/rate-limit.service';

const serviceWith = (client: unknown) =>
  new RateLimitService({ getClient: () => client } as any);

describe('RateLimitService', () => {
  it('fails open when Redis is unavailable', async () => {
    const result = await serviceWith(null).checkRateLimit('test:u1', { windowMs: 1000, maxRequests: 5 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
  });

  it('fails open when Redis throws', async () => {
    const client = { eval: jest.fn().mockRejectedValue(new Error('Redis down')) };
    const result = await serviceWith(client).checkRateLimit('test:u1', { windowMs: 1000, maxRequests: 5 });
    expect(result.allowed).toBe(true);
  });

  it('uses one atomic script call on a zevra:ratelimit key', async () => {
    const client = { eval: jest.fn().mockResolvedValue([1, 1000]) };
    const result = await serviceWith(client).checkRateLimit('send:user1', { windowMs: 1000, maxRequests: 5 });
    expect(result).toEqual(expect.objectContaining({ allowed: true, remaining: 4 }));
    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ['zevra:ratelimit:send:user1'],
      arguments: ['1000'],
    });
  });

  it('blocks once the count exceeds the limit', async () => {
    const client = { eval: jest.fn().mockResolvedValue([6, 400]) };
    const result = await serviceWith(client).checkRateLimit('send:user1', { windowMs: 1000, maxRequests: 5 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('uses different keys for different users', async () => {
    const client = { eval: jest.fn().mockResolvedValue([1, 1000]) };
    const service = serviceWith(client);
    await service.checkRateLimit('send:user1', { windowMs: 1000, maxRequests: 5 });
    await service.checkRateLimit('send:user2', { windowMs: 1000, maxRequests: 5 });
    const keys = client.eval.mock.calls.map((c: any[]) => c[1].keys[0]);
    expect(keys).toEqual(['zevra:ratelimit:send:user1', 'zevra:ratelimit:send:user2']);
  });

  it('exposes presets', () => {
    expect(RateLimitService.SEND_MESSAGE.maxRequests).toBeGreaterThan(0);
    expect(RateLimitService.CONNECTION_PER_IP.windowMs).toBe(60_000);
  });
});
