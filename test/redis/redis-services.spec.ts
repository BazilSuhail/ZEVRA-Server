import { RedisCacheService } from '../../src/redis/redis-cache.service';
import { RedisSessionService, PendingMessage } from '../../src/redis/redis-session.service';
/**
 * Minimal in-memory stand-in for the node-redis client methods used by the
 * realtime services (strings, lists, sets, sorted sets, MULTI).
 */
type ZEntry = { score: number; value: string };

const toScore = (v: number | string) =>
  v === '-inf' ? -Infinity : v === '+inf' ? Infinity : Number(v);

class FakeRedis {
  strings = new Map<string, string>();
  lists = new Map<string, string[]>();
  sets = new Map<string, Set<string>>();
  zsets = new Map<string, ZEntry[]>();
  ttls = new Map<string, number>();
  isReady = true;

  private exists_(key: string) {
    return this.strings.has(key) || this.lists.has(key) || this.sets.has(key) || this.zsets.has(key);
  }

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }
  async setEx(key: string, ttl: number, value: string) {
    this.strings.set(key, value);
    this.ttls.set(key, ttl);
    return 'OK';
  }
  async del(keys: string | string[]) {
    let n = 0;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.exists_(key)) n++;
      this.strings.delete(key);
      this.lists.delete(key);
      this.sets.delete(key);
      this.zsets.delete(key);
      this.ttls.delete(key);
    }
    return n;
  }
  async exists(key: string) {
    return this.exists_(key) ? 1 : 0;
  }
  async expire(key: string, ttl: number) {
    if (!this.exists_(key)) return 0;
    this.ttls.set(key, ttl);
    return 1;
  }
  async mGet(keys: string[]) {
    return keys.map((k) => this.strings.get(k) ?? null);
  }
  async incr(key: string) {
    const v = parseInt(this.strings.get(key) ?? '0', 10) + 1;
    this.strings.set(key, String(v));
    return v;
  }

  async rPush(key: string, value: string) {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }
  async lTrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    this.lists.set(key, list.slice(s, e + 1));
    return 'OK';
  }
  async lRange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    return list.slice(s, e + 1);
  }

  async sAdd(key: string, values: string | string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const v of Array.isArray(values) ? values : [values]) set.add(v);
    this.sets.set(key, set);
    return set.size;
  }
  async sMembers(key: string) {
    return Array.from(this.sets.get(key) ?? []);
  }
  async sIsMember(key: string, value: string) {
    return this.sets.get(key)?.has(value) ? 1 : 0;
  }

  private z(key: string) {
    const z = this.zsets.get(key) ?? [];
    this.zsets.set(key, z);
    return z;
  }
  private zClean(key: string) {
    if ((this.zsets.get(key) ?? []).length === 0) this.zsets.delete(key);
  }
  async zAdd(key: string, entry: ZEntry) {
    const z = this.z(key);
    const existing = z.find((e) => e.value === entry.value);
    if (existing) existing.score = entry.score;
    else z.push({ ...entry });
    z.sort((a, b) => a.score - b.score);
    return existing ? 0 : 1;
  }
  async zRem(key: string, values: string | string[]) {
    const remove = new Set(Array.isArray(values) ? values : [values]);
    const z = this.z(key);
    const kept = z.filter((e) => !remove.has(e.value));
    this.zsets.set(key, kept);
    this.zClean(key);
    return z.length - kept.length;
  }
  async zRemRangeByScore(key: string, min: number | string, max: number | string) {
    const z = this.z(key);
    const kept = z.filter((e) => e.score < toScore(min) || e.score > toScore(max));
    this.zsets.set(key, kept);
    this.zClean(key);
    return z.length - kept.length;
  }
  async zRangeByScore(key: string, min: number | string, max: number | string) {
    return (this.zsets.get(key) ?? [])
      .filter((e) => e.score >= toScore(min) && e.score <= toScore(max))
      .map((e) => e.value);
  }
  async zRange(key: string, start: number, stop: number) {
    const z = this.zsets.get(key) ?? [];
    return z.slice(start, stop < 0 ? undefined : stop + 1).map((e) => e.value);
  }
  async zCard(key: string) {
    return (this.zsets.get(key) ?? []).length;
  }

  multi() {
    const ops: (() => Promise<unknown>)[] = [];
    const proxy: any = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'exec') {
            return async () => {
              const out: unknown[] = [];
              for (const op of ops) out.push(await op());
              return out;
            };
          }
          return (...args: unknown[]) => {
            ops.push(() => (this as any)[prop](...args));
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
}

/** RedisService stand-in returning the given client (or null for degraded mode). */
const redisServiceFor = (client: unknown) => ({ getClient: () => client }) as any;


describe('RedisCacheService', () => {
  describe('null client (degraded mode)', () => {
    const service = new RedisCacheService(redisServiceFor(null));

    it('cacheMessage is no-op', async () => {
      await expect(service.cacheMessage('ch1', { id: '1' })).resolves.toBeUndefined();
    });

    it('getRecentMessages returns empty', async () => {
      expect(await service.getRecentMessages('ch1')).toEqual([]);
    });

    it('incrementUnread returns 0', async () => {
      expect(await service.incrementUnread('u1', 'ch1')).toBe(0);
    });

    it('getUnreadCounts returns zeros for every channel', async () => {
      expect(await service.getUnreadCounts('u1', ['ch1', 'ch2'])).toEqual({ ch1: 0, ch2: 0 });
      expect(await service.getUnreadCounts('u1', [])).toEqual({});
    });

    it('typing helpers are no-ops', async () => {
      await expect(service.setTyping('ch1', 'u1')).resolves.toBeUndefined();
      await expect(service.clearTyping('ch1', 'u1')).resolves.toBeUndefined();
      expect(await service.getTypingUsers('ch1')).toEqual([]);
    });
  });

  describe('with redis', () => {
    let redis: FakeRedis;
    let service: RedisCacheService;

    beforeEach(() => {
      redis = new FakeRedis();
      service = new RedisCacheService(redisServiceFor(redis));
    });

    it('caches messages under zevra: key with TTL, oldest first', async () => {
      await service.cacheMessage('ch1', { id: '1' });
      await service.cacheMessage('ch1', { id: '2' });
      expect(await service.getRecentMessages('ch1', 10)).toEqual([{ id: '1' }, { id: '2' }]);
      expect(redis.ttls.get('zevra:cache:messages:ch1')).toBeGreaterThan(0);
    });

    it('keeps only the newest 50 and respects limit', async () => {
      for (let i = 0; i < 60; i++) await service.cacheMessage('ch1', { id: String(i) });
      expect(redis.lists.get('zevra:cache:messages:ch1')).toHaveLength(50);
      const page = await service.getRecentMessages<{ id: string }>('ch1', 3);
      expect(page.map((m) => m.id)).toEqual(['57', '58', '59']);
    });

    it('invalidates messages', async () => {
      await service.cacheMessage('ch1', { id: '1' });
      await service.invalidateMessages('ch1');
      expect(await service.getRecentMessages('ch1')).toHaveLength(0);
    });

    it('handles Redis errors gracefully', async () => {
      redis.lRange = jest.fn().mockRejectedValue(new Error('down')) as any;
      expect(await service.getRecentMessages('ch1')).toEqual([]);
    });

    it('increments, batches and resets unread counters', async () => {
      expect(await service.incrementUnread('u1', 'ch1')).toBe(1);
      await service.incrementUnreadMany(['u1', 'u2'], 'ch1');
      expect(await service.getUnreadCounts('u1', ['ch1', 'ch2'])).toEqual({ ch1: 2, ch2: 0 });
      expect(await service.getUnreadCount('u2', 'ch1')).toBe(1);
      expect(redis.ttls.get('zevra:unread:u1:ch1')).toBeGreaterThan(0);

      await service.resetUnread('u1', 'ch1');
      expect(await service.getUnreadCount('u1', 'ch1')).toBe(0);
    });

    it('tracks typing users in a per-channel sorted set (no SCAN)', async () => {
      await service.setTyping('ch1', 'user1');
      await service.setTyping('ch1', 'user2');
      expect((await service.getTypingUsers('ch1')).sort()).toEqual(['user1', 'user2']);
      expect(redis.ttls.get('zevra:typing:ch1')).toBeGreaterThan(0);

      await service.clearTyping('ch1', 'user1');
      expect(await service.getTypingUsers('ch1')).toEqual(['user2']);
    });

    it('drops expired typing entries', async () => {
      await redis.zAdd('zevra:typing:ch1', { score: Date.now() - 1, value: 'stale' });
      expect(await service.getTypingUsers('ch1')).toEqual([]);
    });
  });
});


const makeMsg = (id: string, createdAt: number): PendingMessage => ({
  id,
  messageId: id,
  channelId: 'ch1',
  senderId: 'sender',
  senderUsername: 'alice',
  encryptedContent: 'enc',
  contentIv: 'iv',
  contentTag: 'tag',
  signature: 'sig',
  sequenceNumber: 1,
  senderKeyEpoch: 0,
  messageType: 'TEXT',
  metadata: null,
  isDeleted: false,
  createdAt: new Date(createdAt).toISOString(),
});

describe('RedisSessionService', () => {
  describe('null client (degraded mode)', () => {
    const service = new RedisSessionService(redisServiceFor(null));

    it('socket registry reports unknown', async () => {
      expect(await service.addSocket('u1', 's1')).toBeNull();
      expect(await service.removeSocket('u1', 's1')).toBeNull();
    });

    it('presence reports offline', async () => {
      expect(await service.isOnline('u1')).toBe(false);
      expect((await service.getOnlineUsers(['u1'])).size).toBe(0);
    });

    it('pending queue is empty', async () => {
      expect(await service.popPendingMessages('u1')).toEqual({ messages: [], remaining: 0 });
    });
  });

  describe('with redis', () => {
    let redis: FakeRedis;
    let service: RedisSessionService;

    beforeEach(() => {
      redis = new FakeRedis();
      service = new RedisSessionService(redisServiceFor(redis));
    });

    it('tracks multiple sockets per user and reports the last one leaving', async () => {
      expect(await service.addSocket('u1', 's1')).toBe(1);
      expect(await service.addSocket('u1', 's2')).toBe(2);
      expect(redis.ttls.get('zevra:sockets:u1')).toBeGreaterThan(0);

      expect(await service.removeSocket('u1', 's1')).toBe(1);
      expect(await service.removeSocket('u1', 's2')).toBe(0);
    });

    it('ignores stale sockets that stopped heartbeating', async () => {
      await redis.zAdd('zevra:sockets:u1', { score: Date.now() - 10 * 60_000, value: 'dead' });
      expect(await service.addSocket('u1', 's1')).toBe(1);
      expect(await service.removeSocket('u1', 's1')).toBe(0);
    });

    it('refreshes a socket on heartbeat', async () => {
      await service.addSocket('u1', 's1');
      await service.refreshSocket('u1', 's1');
      expect(await redis.zCard('zevra:sockets:u1')).toBe(1);
    });

    it('presence on/off with TTL', async () => {
      await service.setOnline('user1');
      await service.setOnline('user3');
      expect(await service.isOnline('user1')).toBe(true);
      expect(redis.ttls.get('zevra:presence:user1')).toBe(90);
      const online = await service.getOnlineUsers(['user1', 'user2', 'user3']);
      expect([...online].sort()).toEqual(['user1', 'user3']);

      await service.setOffline('user1');
      expect(await service.isOnline('user1')).toBe(false);
    });

    it('queues one message for many users with TTL', async () => {
      await service.addPendingMessage(['u1', 'u2'], makeMsg('m1', 1000));
      expect(redis.ttls.get('zevra:pending:u1')).toBeGreaterThan(0);
      expect((await service.popPendingMessages('u2')).messages.map((m) => m.id)).toEqual(['m1']);
    });

    it('pops exactly the delivered batch, oldest first, and keeps the rest', async () => {
      for (let i = 0; i < 5; i++) {
        await service.addPendingMessage(['u1'], makeMsg(`m${i}`, 1000 + i));
      }
      const first = await service.popPendingMessages('u1', 2);
      expect(first.messages.map((m) => m.id)).toEqual(['m0', 'm1']);
      expect(first.remaining).toBe(3);

      // A message queued between pops is not lost
      await service.addPendingMessage(['u1'], makeMsg('late', 500));
      const second = await service.popPendingMessages('u1', 10);
      expect(second.messages.map((m) => m.id)).toEqual(['late', 'm2', 'm3', 'm4']);
      expect(second.remaining).toBe(0);
    });
  });
});
