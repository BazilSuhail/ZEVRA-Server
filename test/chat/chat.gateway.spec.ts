import { ChatGateway } from '../../src/chat/chat.gateway';

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let mockChatService: any;
  let mockRateLimitService: any;
  let mockClient: any;

  beforeEach(() => {
    mockChatService = {
      sendMessage: jest.fn(),
      getMessages: jest.fn(),
      markAsRead: jest.fn(),
      getUnreadCounts: jest.fn(),
      deliverPendingMessages: jest.fn(),
    };
    mockRateLimitService = { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 100 }) };
    gateway = new ChatGateway(
      mockChatService,
      {},  // socketService
      {},  // reactionsService
      {},  // pubSubService
      mockRateLimitService,
    );

    mockClient = {
      id: 'socket-123',
      data: { user: { id: 'user-1', username: 'test' } },
      emit: jest.fn(),
    };
  });

  describe('send-message', () => {
    const baseMsg = {
      channelId: 'ch1',
      contentIv: 'iv',
      contentTag: 'tag',
      signature: 'sig',
      sequenceNumber: 1,
      senderKeyEpoch: 1,
    };

    it('rejects oversized messages (>10KB)', async () => {
      const result = await (gateway as any).handleSendMessage(mockClient, {
        ...baseMsg,
        encryptedContent: 'x'.repeat(10241),
      });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'PAYLOAD_TOO_LARGE' }));
    });

    it('accepts messages at exactly 10KB', async () => {
      mockChatService.sendMessage.mockResolvedValue({ id: 'msg-1' });
      const result = await (gateway as any).handleSendMessage(mockClient, {
        ...baseMsg,
        encryptedContent: 'x'.repeat(10240),
      });
      expect(result.success).toBe(true);
    });

    it('rate limits send-message', async () => {
      mockRateLimitService.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
      const result = await (gateway as any).handleSendMessage(mockClient, {
        ...baseMsg,
        encryptedContent: 'hello',
      });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'RATE_LIMITED' }));
    });

    it('returns NOT_MEMBER on ForbiddenException', async () => {
      mockChatService.sendMessage.mockRejectedValue({ status: 403, message: 'Not a member' });
      const result = await (gateway as any).handleSendMessage(mockClient, {
        ...baseMsg,
        encryptedContent: 'hi',
      });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'NOT_MEMBER' }));
    });
  });

  describe('get-messages', () => {
    it('rate limits get-messages', async () => {
      mockRateLimitService.checkRateLimit.mockResolvedValue({ allowed: false });
      const result = await (gateway as any).handleGetMessages(mockClient, { channelId: 'ch1' });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'RATE_LIMITED' }));
    });

    it('returns messages with correct params', async () => {
      mockChatService.getMessages.mockResolvedValue({ messages: [], hasMore: false });
      const result = await (gateway as any).handleGetMessages(mockClient, { channelId: 'ch1', limit: 25 });
      expect(result.success).toBe(true);
      expect(mockChatService.getMessages).toHaveBeenCalledWith('ch1', 'user-1', 25, undefined);
    });
  });

  describe('mark-read', () => {
    it('forwards to chat service', async () => {
      mockChatService.markAsRead.mockResolvedValue({ success: true, advanced: true });
      const result = await (gateway as any).handleMarkRead(mockClient, { channelId: 'ch1', messageId: 'msg-1' });
      expect(result.success).toBe(true);
      expect(mockChatService.markAsRead).toHaveBeenCalledWith('user-1', 'ch1', 'msg-1');
    });
  });

  describe('get-unread', () => {
    it('returns unread counts', async () => {
      mockChatService.getUnreadCounts.mockResolvedValue({ ch1: 3, ch2: 0 });
      const result = await (gateway as any).handleGetUnread(mockClient);
      expect(result).toEqual(expect.objectContaining({ success: true, counts: { ch1: 3, ch2: 0 } }));
    });
  });

  describe('get-pending', () => {
    it('delivers pending messages', async () => {
      mockChatService.deliverPendingMessages.mockResolvedValue([{ id: 'p1' }]);
      const result = await (gateway as any).handleGetPending(mockClient);
      expect(result).toEqual(expect.objectContaining({ success: true, count: 1 }));
    });
  });
});
