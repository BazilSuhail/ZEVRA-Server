import { RedisCacheService } from '../../src/redis/redis-cache.service';

describe('RedisCacheService', () => {
  let service: RedisCacheService;

  beforeEach(() => {
    service = new RedisCacheService();
  });

  describe('null client (degraded mode)', () => {
    beforeEach(() => service.setClient(null));

    it('cacheMessage is no-op', async () => {
      await expect(service.cacheMessage('ch1', { id: '1' })).resolves.toBeUndefined();
    });

    it('getRecentMessages returns empty', async () => {
      expect(await service.getRecentMessages('ch1')).toEqual([]);
    });

    it('incrementUnread returns 0', async () => {
      expect(await service.incrementUnread('u1', 'ch1')).toBe(0);
    });

    it('getUnreadCount returns 0', async () => {
      expect(await service.getUnreadCount('u1', 'ch1')).toBe(0);
    });

    it('getUnreadCounts returns empty for empty input', async () => {
      expect(await service.getUnreadCounts('u1', [])).toEqual({});
    });

    it('getUnreadCounts returns empty object', async () => {
      expect(await service.getUnreadCounts('u1', ['ch1', 'ch2'])).toEqual({});
    });

    it('getTypingUsers returns empty', async () => {
      expect(await service.getTypingUsers('ch1')).toEqual([]);
    });

    it('getReadReceipts returns empty', async () => {
      expect(await service.getReadReceipts('ch1')).toEqual({});
    });

    it('getGroupInfo returns null', async () => {
      expect(await service.getGroupInfo('g1')).toBeNull();
    });

    it('invalidateMessages is no-op', async () => {
      await expect(service.invalidateMessages('ch1')).resolves.toBeUndefined();
    });

    it('setTyping is no-op', async () => {
      await expect(service.setTyping('ch1', 'u1')).resolves.toBeUndefined();
    });

    it('clearTyping is no-op', async () => {
      await expect(service.clearTyping('ch1', 'u1')).resolves.toBeUndefined();
    });
  });

  describe('message caching', () => {
    let mockClient: any;

    beforeEach(() => {
      const listStore = new Map<string, string[]>();
      mockClient = {
        lPush: jest.fn(async (key: string, val: string) => {
          if (!listStore.has(key)) listStore.set(key, []);
          listStore.get(key)!.unshift(val);
        }),
        rPush: jest.fn(async (key: string, val: string) => {
          if (!listStore.has(key)) listStore.set(key, []);
          listStore.get(key)!.push(val);
        }),
        lRange: jest.fn(async (key: string, start: number, stop: number) => {
          const list = listStore.get(key) ?? [];
          return list.slice(start, stop === -1 ? undefined : stop + 1);
        }),
        lTrim: jest.fn(),
        expire: jest.fn(),
        del: jest.fn(async (key: string) => { listStore.delete(key); }),
      };
      service.setClient(mockClient);
    });

    it('caches and retrieves messages (oldest first)', async () => {
      await service.cacheMessage('ch1', { id: '1', content: 'hello' });
      await service.cacheMessage('ch1', { id: '2', content: 'world' });
      const msgs = await service.getRecentMessages('ch1', 10);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toEqual({ id: '1', content: 'hello' });
      expect(msgs[1]).toEqual({ id: '2', content: 'world' });
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) await service.cacheMessage('ch1', { id: String(i) });
      const msgs = await service.getRecentMessages('ch1', 3);
      expect(msgs).toHaveLength(3);
    });

    it('invalidates messages', async () => {
      await service.cacheMessage('ch1', { id: '1' });
      await service.invalidateMessages('ch1');
      expect(await service.getRecentMessages('ch1')).toHaveLength(0);
    });

    it('handles Redis error gracefully', async () => {
      mockClient.lRange.mockRejectedValue(new Error('connection lost'));
      expect(await service.getRecentMessages('ch1')).toEqual([]);
    });
  });

  describe('unread counts', () => {
    let mockClient: any;

    beforeEach(() => {
      const store = new Map<string, string>();
      mockClient = {
        incr: jest.fn(async (key: string) => {
          const val = parseInt(store.get(key) ?? '0', 10) + 1;
          store.set(key, String(val));
          return val;
        }),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        mGet: jest.fn(async (keys: string[]) => keys.map(k => store.get(k) ?? null)),
        del: jest.fn(),
        expire: jest.fn(),
      };
      service.setClient(mockClient);
    });

    it('increments and reads unread count', async () => {
      expect(await service.incrementUnread('u1', 'ch1')).toBe(1);
      expect(await service.incrementUnread('u1', 'ch1')).toBe(2);
      expect(await service.getUnreadCount('u1', 'ch1')).toBe(2);
    });

    it('getUnreadCounts returns multiple counts', async () => {
      await service.incrementUnread('u1', 'ch1');
      await service.incrementUnread('u1', 'ch1');
      await service.incrementUnread('u1', 'ch2');
      const counts = await service.getUnreadCounts('u1', ['ch1', 'ch2', 'ch3']);
      expect(counts['ch1']).toBe(2);
      expect(counts['ch2']).toBe(1);
      expect(counts['ch3']).toBe(0);
    });

    it('resets unread count via service', async () => {
      await service.incrementUnread('u1', 'ch1');
      await service.incrementUnread('u1', 'ch1');
      await service.resetUnread('u1', 'ch1');
      mockClient.get.mockResolvedValueOnce(null);
      const count = await service.getUnreadCount('u1', 'ch1');
      expect(count).toBe(0);
    });

    it('handles Redis error in incrementUnread', async () => {
      mockClient.incr.mockRejectedValue(new Error('connection lost'));
      expect(await service.incrementUnread('u1', 'ch1')).toBe(0);
    });
  });

  describe('typing indicators', () => {
    let mockClient: any;

    beforeEach(() => {
      const store = new Map<string, string>();
      mockClient = {
        setEx: jest.fn(async (key: string, _ttl: number, val: string) => { store.set(key, val); }),
        del: jest.fn(async (...args: any[]) => { for (const key of (Array.isArray(args[0]) ? args[0] : args)) store.delete(key); }),
        keys: jest.fn(async (pattern: string) => {
          const prefix = pattern.replace('*', '');
          return Array.from(store.keys()).filter(k => k.startsWith(prefix));
        }),
      };
      service.setClient(mockClient);
    });

    it('sets and gets typing users', async () => {
      await service.setTyping('ch1', 'user1');
      await service.setTyping('ch1', 'user2');
      const users = await service.getTypingUsers('ch1');
      expect(users).toContain('user1');
      expect(users).toContain('user2');
    });

    it('clears typing indicator', async () => {
      await service.setTyping('ch1', 'user1');
      await service.clearTyping('ch1', 'user1');
      const users = await service.getTypingUsers('ch1');
      expect(users).not.toContain('user1');
    });
  });

  describe('read receipts', () => {
    let mockClient: any;

    beforeEach(() => {
      const hashStore = new Map<string, Record<string, string>>();
      mockClient = {
        hSet: jest.fn(async (key: string, field: string, value: string) => {
          if (!hashStore.has(key)) hashStore.set(key, {});
          hashStore.get(key)![field] = value;
        }),
        hGetAll: jest.fn(async (key: string) => hashStore.get(key) ?? {}),
        expire: jest.fn(),
      };
      service.setClient(mockClient);
    });

    it('caches and retrieves read receipts', async () => {
      await service.cacheReadReceipt('ch1', 'user1', 'msg1');
      await service.cacheReadReceipt('ch1', 'user2', 'msg2');
      const receipts = await service.getReadReceipts('ch1');
      expect(receipts['user1']).toBe('msg1');
      expect(receipts['user2']).toBe('msg2');
    });
  });

  describe('group info cache', () => {
    let mockClient: any;

    beforeEach(() => {
      const hashStore = new Map<string, Record<string, string>>();
      mockClient = {
        hSet: jest.fn(async (key: string, arg2: any) => {
          if (!hashStore.has(key)) hashStore.set(key, {});
          if (Array.isArray(arg2)) for (const [k, v] of arg2) hashStore.get(key)![k] = v;
        }),
        hGetAll: jest.fn(async (key: string) => hashStore.get(key) ?? {}),
        del: jest.fn(async (key: string) => { hashStore.delete(key); }),
        expire: jest.fn(),
      };
      service.setClient(mockClient);
    });

    it('caches and retrieves group info', async () => {
      await service.cacheGroupInfo('g1', { name: 'Test Group', memberCount: '5' });
      const info = await service.getGroupInfo('g1');
      expect(info?.name).toBe('Test Group');
    });

    it('returns null for non-existent group', async () => {
      expect(await service.getGroupInfo('nonexistent')).toBeNull();
    });

    it('invalidates group info', async () => {
      await service.cacheGroupInfo('g1', { name: 'Test' });
      await service.invalidateGroupInfo('g1');
      expect(await service.getGroupInfo('g1')).toBeNull();
    });
  });
});
