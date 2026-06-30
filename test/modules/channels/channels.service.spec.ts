import { ChannelsService } from '../../../src/modules/channels/channels.service';

describe('ChannelsService', () => {
  let service: ChannelsService;
  let mockDb: any;
  let mockSessionService: any;
  let mockCacheService: any;

  beforeEach(() => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      transaction: jest.fn(async (fn: any) => fn(mockDb)),
      onConflictDoNothing: jest.fn().mockReturnThis(),
    };
    mockSessionService = { addChannelMember: jest.fn(), removeChannelMember: jest.fn() };
    mockCacheService = { getTypingUsers: jest.fn().mockResolvedValue([]), getReadReceipts: jest.fn().mockResolvedValue({}) };
    service = new ChannelsService(mockDb, mockSessionService, mockCacheService);
  });

  describe('create', () => {
    it('rejects DM with wrong participant count', async () => {
      await expect(service.create('u1', ['u2', 'u3'], 'DIRECT'))
        .rejects.toThrow('Direct message requires exactly 1 other participant');
    });

    it('rejects DM with self', async () => {
      await expect(service.create('u1', ['u1'], 'DIRECT'))
        .rejects.toThrow('Cannot create DM with yourself');
    });
  });

  describe('getTypingUsers', () => {
    it('excludes requesting user from typing list', async () => {
      mockDb.where.mockResolvedValue([{ id: 'mem-1' }]);
      mockCacheService.getTypingUsers.mockResolvedValue(['u1', 'u2', 'u3']);
      expect(await service.getTypingUsers('ch1', 'u1')).toEqual(['u2', 'u3']);
    });

    it('throws for non-member', async () => {
      mockDb.where.mockResolvedValue([]);
      await expect(service.getTypingUsers('ch1', 'u1')).rejects.toThrow('Not a member of this channel');
    });
  });

  describe('getReadReceipts', () => {
    it('returns receipts for members', async () => {
      mockDb.where.mockResolvedValue([{ id: 'mem-1' }]);
      mockCacheService.getReadReceipts.mockResolvedValue({ u1: 'msg-1' });
      expect(await service.getReadReceipts('ch1', 'u1')).toEqual({ u1: 'msg-1' });
    });

    it('throws for non-member', async () => {
      mockDb.where.mockResolvedValue([]);
      await expect(service.getReadReceipts('ch1', 'u1')).rejects.toThrow('Not a member of this channel');
    });
  });
});
