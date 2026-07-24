import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { ChatGateway } from '../../src/chat/chat.gateway';

const CH = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let chatService: any;
  let messagesService: any;
  let reactionsService: any;
  let channelsService: any;
  let rateLimitService: any;
  let client: any;

  beforeEach(() => {
    chatService = {
      getUnreadCounts: jest.fn(),
      deliverPendingMessages: jest.fn(),
    };
    messagesService = { send: jest.fn(), getMessages: jest.fn() };
    reactionsService = { addReaction: jest.fn(), removeReaction: jest.fn() };
    channelsService = { markRead: jest.fn() };
    rateLimitService = { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 100 }) };
    gateway = new ChatGateway(chatService, messagesService, reactionsService, channelsService, rateLimitService);

    client = {
      id: 'socket-123',
      data: { user: { id: 'user-1', username: 'test' } },
      emit: jest.fn(),
    };
  });

  describe('send-message', () => {
    const baseMsg = {
      channelId: CH,
      contentIv: 'iv',
      contentTag: 'tag',
      signature: 'sig',
      sequenceNumber: 1,
      senderKeyEpoch: 1,
    };

    it('rejects oversized messages (>10KB)', async () => {
      const result = await gateway.handleSendMessage(client, { ...baseMsg, encryptedContent: 'x'.repeat(10241) });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'PAYLOAD_TOO_LARGE' }));
      expect(messagesService.send).not.toHaveBeenCalled();
    });

    it('accepts messages at exactly 10KB and excludes the sending socket', async () => {
      messagesService.send.mockResolvedValue({ id: 'msg-1' });
      const result: any = await gateway.handleSendMessage(client, { ...baseMsg, encryptedContent: 'x'.repeat(10240) });
      expect(result.success).toBe(true);
      expect(result.message).toEqual({ id: 'msg-1' });
      expect(messagesService.send).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', channelId: CH }),
        { exceptSocketId: 'socket-123' },
      );
    });

    it('validates payload (uuid, iv length, enum)', async () => {
      for (const bad of [
        { ...baseMsg, channelId: 'nope', encryptedContent: 'x' },
        { ...baseMsg, contentIv: 'i'.repeat(33), encryptedContent: 'x' },
        { ...baseMsg, messageType: 'VIDEO', encryptedContent: 'x' },
        null,
      ]) {
        const result = await gateway.handleSendMessage(client, bad);
        expect(result).toEqual(expect.objectContaining({ success: false, error: 'VALIDATION_ERROR' }));
      }
      expect(messagesService.send).not.toHaveBeenCalled();
    });

    it('rate limits send-message', async () => {
      rateLimitService.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
      const result = await gateway.handleSendMessage(client, { ...baseMsg, encryptedContent: 'hello' });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'RATE_LIMITED' }));
    });

    it('maps ForbiddenException to NOT_MEMBER', async () => {
      messagesService.send.mockRejectedValue(new ForbiddenException('Not a member'));
      const result = await gateway.handleSendMessage(client, { ...baseMsg, encryptedContent: 'hi' });
      expect(result).toEqual({ success: false, error: 'NOT_MEMBER', message: 'Not a member' });
    });

    it('maps archived channel to VALIDATION_ERROR', async () => {
      messagesService.send.mockRejectedValue(new BadRequestException('Channel is archived'));
      const result = await gateway.handleSendMessage(client, { ...baseMsg, encryptedContent: 'hi' });
      expect(result).toEqual({ success: false, error: 'VALIDATION_ERROR', message: 'Channel is archived' });
    });

    it('never leaks raw database errors', async () => {
      messagesService.send.mockRejectedValue(Object.assign(new Error('relation "x" violates'), { code: '42P01' }));
      const result: any = await gateway.handleSendMessage(client, { ...baseMsg, encryptedContent: 'hi' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INTERNAL_ERROR');
      expect(result.message).not.toContain('relation');
    });
  });

  describe('get-messages', () => {
    it('rate limits get-messages', async () => {
      rateLimitService.checkRateLimit.mockResolvedValue({ allowed: false });
      const result = await gateway.handleGetMessages(client, { channelId: CH });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'RATE_LIMITED' }));
    });

    it('returns messages with correct params', async () => {
      messagesService.getMessages.mockResolvedValue({ messages: [], hasMore: false });
      const result: any = await gateway.handleGetMessages(client, { channelId: CH, limit: 25 });
      expect(result.success).toBe(true);
      expect(messagesService.getMessages).toHaveBeenCalledWith(CH, 'user-1', 25, undefined, undefined);
    });

    it('rejects invalid limit', async () => {
      const result = await gateway.handleGetMessages(client, { channelId: CH, limit: 1000 });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'VALIDATION_ERROR' }));
    });
  });

  describe('mark-read', () => {
    it('forwards to the shared channels service', async () => {
      channelsService.markRead.mockResolvedValue({ success: true, advanced: true });
      const result: any = await gateway.handleMarkRead(client, { channelId: CH, messageId: MSG });
      expect(result.success).toBe(true);
      expect(channelsService.markRead).toHaveBeenCalledWith('user-1', CH, MSG);
    });
  });

  describe('get-unread', () => {
    it('returns unread counts', async () => {
      chatService.getUnreadCounts.mockResolvedValue({ ch1: 3, ch2: 0 });
      const result = await gateway.handleGetUnread(client);
      expect(result).toEqual({ success: true, counts: { ch1: 3, ch2: 0 } });
    });
  });

  describe('get-pending', () => {
    it('returns the popped batch and whether more remain', async () => {
      chatService.deliverPendingMessages.mockResolvedValue({ messages: [{ id: 'p1' }], remaining: 4 });
      const result = await gateway.handleGetPending(client);
      expect(result).toEqual({ success: true, count: 1, messages: [{ id: 'p1' }], hasMore: true });
    });
  });

  describe('reactions', () => {
    it('validates emoji length', async () => {
      const result = await gateway.handleReactionAdd(client, { channelId: CH, messageId: MSG, emoji: 'x'.repeat(17) });
      expect(result).toEqual(expect.objectContaining({ success: false, error: 'VALIDATION_ERROR' }));
    });

    it('adds a reaction as the socket user', async () => {
      reactionsService.addReaction.mockResolvedValue({ success: true, action: 'added', replaced: [] });
      const result = await gateway.handleReactionAdd(client, { channelId: CH, messageId: MSG, emoji: '👍' });
      expect(result).toEqual({ success: true, action: 'added', replaced: [] });
      expect(reactionsService.addReaction).toHaveBeenCalledWith({ id: 'user-1', username: 'test' }, CH, MSG, '👍');
    });

    it('accepts the legacy reaction:removed alias', async () => {
      reactionsService.removeReaction.mockResolvedValue({ success: true, action: 'removed' });
      const result = await gateway.handleReactionRemoveLegacy(client, { channelId: CH, messageId: MSG, emoji: '👍' });
      expect(result).toEqual({ success: true, action: 'removed' });
    });
  });
});
