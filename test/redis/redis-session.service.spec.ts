import { RedisSessionService } from '../../src/redis/redis-session.service';

describe('RedisSessionService', () => {
  let service: RedisSessionService;

  beforeEach(() => {
    service = new RedisSessionService();
  });

  describe('null client (degraded mode)', () => {
    it('registerSession is no-op', async () => {
      await service.registerSession('user1', 'socket1');
      expect(await service.getSession('user1')).toBeNull();
    });

    it('getSession returns null', async () => {
      expect(await service.getSession('nonexistent')).toBeNull();
    });

    it('setOnline/isOnline returns false', async () => {
      expect(await service.isOnline('u1')).toBe(false);
    });

    it('getOnlineUsers returns empty', async () => {
      expect((await service.getOnlineUsers(['u1'])).size).toBe(0);
    });

    it('addChannelMember/getChannelMembers is no-op', async () => {
      await service.addChannelMember('ch1', 'u1');
      expect(await service.getChannelMembers('ch1')).toEqual([]);
    });

    it('getPendingMessages returns empty', async () => {
      expect(await service.getPendingMessages('u1')).toEqual([]);
    });

    it('getPendingCount returns 0', async () => {
      expect(await service.getPendingCount('u1')).toBe(0);
    });
  });

  describe('registerSession / getSession', () => {
    let mockClient: any;

    beforeEach(() => {
      const store: Record<string, string> = {};
      const pipelineOps: (() => Promise<any>)[] = [];
      mockClient = {
        store,
        get: jest.fn(async (key: string) => store[key] ?? null),
        setEx: jest.fn(async (key: string, _ttl: number, val: string) => { store[key] = val; }),
        del: jest.fn(async (...args: string[]) => { for (const key of args) delete store[key]; }),
        expire: jest.fn(async () => true),
        multi: jest.fn(function () {
          pipelineOps.length = 0;
          const self = this;
          return {
            setEx: jest.fn((...args: any[]) => { pipelineOps.push(() => self.setEx(...args)); return this; }),
            del: jest.fn((...args: any[]) => { pipelineOps.push(() => self.del(...args)); return this; }),
            expire: jest.fn((...args: any[]) => { pipelineOps.push(() => self.expire(...args)); return this; }),
            exec: jest.fn(async () => { for (const op of pipelineOps) await op(); return pipelineOps.map(() => true); }),
          };
        }),
      };
      service.setClient(mockClient);
    });

    it('registers and retrieves a session', async () => {
      await service.registerSession('user1', 'socket1');
      expect(await service.getSession('user1')).toBe('socket1');
    });

    it('returns null for non-existent session', async () => {
      expect(await service.getSession('nonexistent')).toBeNull();
    });

    it('removes session mapping', async () => {
      await service.registerSession('user1', 'socket1');
      await service.removeSession('user1', 'socket1');
      expect(await service.getSession('user1')).toBeNull();
    });

    it('handles removeSession for non-existent session', async () => {
      await expect(service.removeSession('nonexistent', 'nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('renewSession', () => {
    it('renews session TTL without changing values', async () => {
      const store: Record<string, string> = {};
      const pipelineOps: (() => Promise<any>)[] = [];
      const mockClient: any = {
        store,
        get: jest.fn(async (key: string) => store[key] ?? null),
        setEx: jest.fn(async (key: string, _ttl: number, val: string) => { store[key] = val; }),
        del: jest.fn(),
        expire: jest.fn(async () => true),
        multi: jest.fn(function () {
          pipelineOps.length = 0;
          const self = this;
          return {
            setEx: jest.fn((...args: any[]) => { pipelineOps.push(() => self.setEx(...args)); return this; }),
            del: jest.fn((...args: any[]) => { pipelineOps.push(() => self.del(...args)); return this; }),
            expire: jest.fn((...args: any[]) => { pipelineOps.push(() => self.expire(...args)); return this; }),
            exec: jest.fn(async () => { for (const op of pipelineOps) await op(); return pipelineOps.map(() => true); }),
          };
        }),
      };
      service.setClient(mockClient);

      await service.registerSession('user1', 'socket1');
      await service.renewSession('user1', 'socket1');
      expect(await service.getSession('user1')).toBe('socket1');
    });
  });

  describe('presence', () => {
    let mockClient: any;

    beforeEach(() => {
      const store: Record<string, string> = {};
      mockClient = {
        setEx: jest.fn(async (key: string, _ttl: number, val: string) => { store[key] = val; }),
        get: jest.fn(async (key: string) => store[key] ?? null),
        del: jest.fn(async (...args: string[]) => { for (const key of args) delete store[key]; }),
        mGet: jest.fn(async (keys: string[]) => keys.map(k => store[k] ?? null)),
      };
      service.setClient(mockClient);
    });

    it('sets user online', async () => {
      await service.setOnline('user1');
      expect(await service.isOnline('user1')).toBe(true);
    });

    it('sets user offline', async () => {
      await service.setOnline('user1');
      await service.setOffline('user1');
      expect(await service.isOnline('user1')).toBe(false);
    });

    it('returns false for non-existent user', async () => {
      expect(await service.isOnline('nonexistent')).toBe(false);
    });

    it('getOnlineUsers returns only online users', async () => {
      await service.setOnline('user1');
      await service.setOnline('user3');
      const online = await service.getOnlineUsers(['user1', 'user2', 'user3']);
      expect(online.has('user1')).toBe(true);
      expect(online.has('user2')).toBe(false);
      expect(online.has('user3')).toBe(true);
    });

    it('getOnlineUsers returns empty set for empty input', async () => {
      expect((await service.getOnlineUsers([])).size).toBe(0);
    });
  });

  describe('channel members', () => {
    let mockClient: any;

    beforeEach(() => {
      const sets: Record<string, Set<string>> = {};
      mockClient = {
        sAdd: jest.fn(async (key: string, val: string) => {
          if (!sets[key]) sets[key] = new Set();
          sets[key].add(val);
        }),
        sRem: jest.fn(async (key: string, val: string) => { sets[key]?.delete(val); }),
        sMembers: jest.fn(async (key: string) => Array.from(sets[key] ?? [])),
        sIsMember: jest.fn(async (key: string, val: string) => sets[key]?.has(val) ?? false),
      };
      service.setClient(mockClient);
    });

    it('adds and retrieves members', async () => {
      await service.addChannelMember('ch1', 'user1');
      await service.addChannelMember('ch1', 'user2');
      const members = await service.getChannelMembers('ch1');
      expect(members).toContain('user1');
      expect(members).toContain('user2');
    });

    it('isChannelMember returns true for member', async () => {
      await service.addChannelMember('ch1', 'user1');
      expect(await service.isChannelMember('ch1', 'user1')).toBe(true);
    });

    it('isChannelMember returns false for non-member', async () => {
      expect(await service.isChannelMember('ch1', 'user1')).toBe(false);
    });

    it('removes member', async () => {
      await service.addChannelMember('ch1', 'user1');
      await service.removeChannelMember('ch1', 'user1');
      expect(await service.isChannelMember('ch1', 'user1')).toBe(false);
    });
  });

  describe('pending messages', () => {
    let mockClient: any;

    const makeMsg = (id: string, seq: number) => ({
      messageId: id,
      channelId: 'ch1',
      senderId: 'user1',
      encryptedContent: 'encrypted',
      contentIv: 'iv',
      contentTag: 'tag',
      sequenceNumber: seq,
      senderKeyEpoch: 1,
      messageType: 'TEXT',
      createdAt: new Date().toISOString(),
    });

    beforeEach(() => {
      const sortedSets: Record<string, { score: number; value: string }[]> = {};
      mockClient = {
        zAdd: jest.fn(async (key: string, item: { score: number; value: string }) => {
          if (!sortedSets[key]) sortedSets[key] = [];
          sortedSets[key].push(item);
        }),
        zRangeWithScores: jest.fn(async (key: string) => sortedSets[key] ?? []),
        zCard: jest.fn(async (key: string) => sortedSets[key]?.length ?? 0),
        del: jest.fn(async (...args: string[]) => { for (const key of args) delete sortedSets[key]; }),
        expire: jest.fn(async () => true),
      };
      service.setClient(mockClient);
    });

    it('adds and retrieves pending messages', async () => {
      await service.addPendingMessage('user1', makeMsg('msg1', 1));
      const pending = await service.getPendingMessages('user1');
      expect(pending).toHaveLength(1);
      expect(pending[0].messageId).toBe('msg1');
    });

    it('clears pending messages', async () => {
      await service.addPendingMessage('user1', makeMsg('msg1', 1));
      await service.clearPendingMessages('user1');
      expect(await service.getPendingMessages('user1')).toHaveLength(0);
    });

    it('returns empty for no pending messages', async () => {
      expect(await service.getPendingMessages('nonexistent')).toHaveLength(0);
    });

    it('getPendingCount returns correct count', async () => {
      await service.addPendingMessage('user1', makeMsg('msg1', 1));
      expect(await service.getPendingCount('user1')).toBe(1);
    });
  });
});
