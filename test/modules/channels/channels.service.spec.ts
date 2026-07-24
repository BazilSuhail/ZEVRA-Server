import { ChannelsService } from '../../../src/modules/channels/channels.service';

describe('ChannelsService', () => {
  let service: ChannelsService;
  let mockDb: any;
  let members: any;
  let cache: any;
  let socket: any;

  beforeEach(() => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
    };
    members = { setMembers: jest.fn(), invalidate: jest.fn() };
    cache = {
      getTypingUsers: jest.fn().mockResolvedValue([]),
      getUnreadCounts: jest.fn().mockResolvedValue({}),
      resetUnread: jest.fn(),
    };
    socket = {
      emitToChannel: jest.fn(),
      emitToUsers: jest.fn(),
      emitToChannelAndUsers: jest.fn(),
      joinUsersToChannel: jest.fn(),
      removeUserFromChannel: jest.fn(),
    };
    service = new ChannelsService(mockDb, members, cache, socket);
  });

  describe('create', () => {
    it('rejects DM with wrong participant count', async () => {
      await expect(service.create('u1', ['u2', 'u3'], 'DIRECT')).rejects.toThrow(
        'Direct message requires exactly 1 other participant',
      );
    });

    it('rejects DM with self', async () => {
      await expect(service.create('u1', ['u1'], 'DIRECT')).rejects.toThrow('Cannot create DM with yourself');
    });

    it('rejects a group with only the creator', async () => {
      await expect(service.create('u1', ['u1'], 'GROUP')).rejects.toThrow(
        'At least one other participant is required',
      );
    });

    it('rejects unknown participants', async () => {
      mockDb.where.mockResolvedValueOnce([{ id: 'u2' }]);
      await expect(service.create('u1', ['u2', 'u3'], 'GROUP')).rejects.toThrow(
        'One or more participants do not exist',
      );
    });
  });

  describe('getTypingUsers', () => {
    it('excludes requesting user from typing list', async () => {
      mockDb.limit.mockResolvedValue([{ role: 'MEMBER' }]);
      cache.getTypingUsers.mockResolvedValue(['u1', 'u2', 'u3']);
      expect(await service.getTypingUsers('ch1', 'u1')).toEqual(['u2', 'u3']);
    });

    it('throws for non-member', async () => {
      mockDb.limit.mockResolvedValue([]);
      await expect(service.getTypingUsers('ch1', 'u1')).rejects.toThrow('Not a member of this channel');
    });
  });

  describe('getReadReceipts', () => {
    it('returns watermarks from memberships', async () => {
      mockDb.limit.mockResolvedValue([{ role: 'MEMBER' }]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          { userId: 'u1', lastReadMessageId: 'msg-1' },
          { userId: 'u2', lastReadMessageId: null },
        ]);
      expect(await service.getReadReceipts('ch1', 'u1')).toEqual({ u1: 'msg-1' });
    });

    it('throws for non-member', async () => {
      mockDb.limit.mockResolvedValue([]);
      await expect(service.getReadReceipts('ch1', 'u1')).rejects.toThrow('Not a member of this channel');
    });
  });

  describe('markRead', () => {
    it('throws for non-member', async () => {
      mockDb.limit.mockResolvedValue([]);
      await expect(service.markRead('u1', 'ch1', 'm1')).rejects.toThrow('Not a member of this channel');
    });

    it('throws when the message is not in the channel', async () => {
      mockDb.limit.mockResolvedValue([{ membershipId: 'mem', targetSeq: null, currentSeq: null }]);
      await expect(service.markRead('u1', 'ch1', 'm1')).rejects.toThrow('Message not found in this channel');
    });

    it('does not regress but still resets the unread counter', async () => {
      mockDb.limit.mockResolvedValue([{ membershipId: 'mem', targetSeq: 3, currentSeq: 9 }]);
      mockDb.execute = jest.fn();
      expect(await service.markRead('u1', 'ch1', 'm1')).toEqual({ success: true, advanced: false });
      expect(mockDb.execute).not.toHaveBeenCalled();
      expect(cache.resetUnread).toHaveBeenCalledWith('u1', 'ch1');
      expect(socket.emitToChannel).not.toHaveBeenCalled();
    });

    it('advances by sequence number and emits message:read', async () => {
      mockDb.limit.mockResolvedValue([{ membershipId: 'mem', targetSeq: 10, currentSeq: 9 }]);
      mockDb.execute = jest.fn().mockResolvedValue({ rowCount: 1 });
      mockDb.insert = jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }),
      });
      expect(await service.markRead('u1', 'ch1', 'm1')).toEqual({ success: true, advanced: true });
      expect(cache.resetUnread).toHaveBeenCalledWith('u1', 'ch1');
      expect(socket.emitToChannel).toHaveBeenCalledWith(
        'ch1',
        'message:read',
        expect.objectContaining({ userId: 'u1', messageId: 'm1', channelId: 'ch1', readAt: expect.any(String) }),
      );
    });
  });
});
