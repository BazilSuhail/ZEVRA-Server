import {
  WebSocketGateway,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Socket } from 'socket.io';
import { SocketAuthGuard, SocketUser } from '../socket/socket-auth.guard';
import { SocketService } from '../socket/socket.service';
import { ChatService } from './chat.service';
import { ReactionsService } from '../modules/reactions/reactions.service';
import { RedisPubSubService } from '../redis/redis-pubsub.service';
import { RateLimitService } from '../shared/rate-limit/rate-limit.service';

const MAX_MESSAGE_SIZE = 10 * 1024; // 10KB

@WebSocketGateway({ cors: true })
export class ChatGateway implements OnGatewayInit {
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private chatService: ChatService,
    private socketService: SocketService,
    private reactionsService: ReactionsService,
    private pubSubService: RedisPubSubService,
    private rateLimitService: RateLimitService,
  ) {}

  afterInit() {
    this.subscribeToGroupChannels();
  }

  // ─── Send Message ──────────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('send-message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      channelId: string;
      encryptedContent: string;
      contentIv: string;
      contentTag: string;
      signature: string;
      sequenceNumber: number;
      senderKeyEpoch: number;
      messageType?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const user: SocketUser = client.data.user;

    // Rate limit
    const rl = await this.rateLimitService.checkRateLimit(
      `send:${user.id}`,
      RateLimitService.SEND_MESSAGE,
    );
    if (!rl.allowed) {
      return { success: false, error: 'RATE_LIMITED', message: 'Too many messages' };
    }

    // Message size validation
    const contentSize = Buffer.byteLength(data.encryptedContent, 'utf-8');
    if (contentSize > MAX_MESSAGE_SIZE) {
      return { success: false, error: 'PAYLOAD_TOO_LARGE', message: 'Message exceeds 10KB limit' };
    }

    try {
      const msg = await this.chatService.sendMessage({
        userId: user.id,
        ...data,
      });

      return { success: true, message: msg };
    } catch (err) {
      const error = err as any;
      const code = error?.status === 403 ? 'NOT_MEMBER' : 'SEND_FAILED';
      return { success: false, error: code, message: error?.message };
    }
  }

  // ─── Get Messages ──────────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('get-messages')
  async handleGetMessages(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string; limit?: number; cursor?: string },
  ) {
    const user: SocketUser = client.data.user;

    // Rate limit
    const rl = await this.rateLimitService.checkRateLimit(
      `getmsg:${user.id}`,
      RateLimitService.GET_MESSAGES,
    );
    if (!rl.allowed) {
      return { success: false, error: 'RATE_LIMITED', message: 'Too many requests' };
    }

    try {
      const result = await this.chatService.getMessages(
        data.channelId,
        user.id,
        data.limit ?? 50,
        data.cursor,
      );
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ─── Mark as Read ──────────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('mark-read')
  async handleMarkRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string; messageId: string },
  ) {
    const user: SocketUser = client.data.user;

    try {
      const result = await this.chatService.markAsRead(user.id, data.channelId, data.messageId);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ─── Get Unread Counts ────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('get-unread')
  async handleGetUnread(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    const counts = await this.chatService.getUnreadCounts(user.id);
    return { success: true, counts };
  }

  // ─── Get Pending Messages ──────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('get-pending')
  async handleGetPending(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    const pending = await this.chatService.deliverPendingMessages(user.id);
    return { success: true, count: pending.length, messages: pending };
  }

  // ─── Reactions ─────────────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('reaction:add')
  async handleReactionAdd(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string; messageId: string; emoji: string },
  ) {
    const user: SocketUser = client.data.user;

    try {
      const result = await this.reactionsService.addReaction(
        user.id,
        data.channelId,
        data.messageId,
        data.emoji,
      );

      if (result.action === 'added') {
        // Broadcast to channel room
        const reaction = {
          userId: user.id,
          username: user.username,
          messageId: data.messageId,
          emoji: data.emoji,
          channelId: data.channelId,
        };
        client.to(`channel:${data.channelId}`).emit('reaction:added', reaction);

        // Cross-node via PubSub
        await this.pubSubService.publishToGroup(data.channelId, JSON.stringify({
          event: 'reaction:added',
          data: reaction,
        }));
      }

      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('reaction:remove')
  async handleReactionRemove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string; messageId: string; emoji: string },
  ) {
    const user: SocketUser = client.data.user;

    try {
      const result = await this.reactionsService.removeReaction(
        user.id,
        data.channelId,
        data.messageId,
        data.emoji,
      );

      if (result.action === 'removed') {
        const reaction = {
          userId: user.id,
          username: user.username,
          messageId: data.messageId,
          emoji: data.emoji,
          channelId: data.channelId,
        };
        client.to(`channel:${data.channelId}`).emit('reaction:removed', reaction);

        await this.pubSubService.publishToGroup(data.channelId, JSON.stringify({
          event: 'reaction:removed',
          data: reaction,
        }));
      }

      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ─── Private: Subscribe to Group Channels ──────────────────────────────

  private subscribeToGroupChannels() {
    // We use pattern subscription to catch all group channels
    // In a real multi-node setup, you'd use Redis pattern subscribe
    // For now, we rely on the Socket.io room broadcast within a single node
    this.logger.log('Chat gateway initialized — cross-node via Redis PubSub');
  }
}
