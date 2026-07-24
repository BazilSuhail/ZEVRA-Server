import { WebSocketGateway, SubscribeMessage, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import { UseGuards } from '@nestjs/common';
import { Socket } from 'socket.io';
import { SocketAuthGuard, SocketUser } from '../socket/socket-auth.guard';
import { validatePayload } from '../socket/validate-payload';
import { ChatService } from './chat.service';
import { MessagesService } from '../modules/messages/messages.service';
import { ReactionsService } from '../modules/reactions/reactions.service';
import { ChannelsService } from '../modules/channels/channels.service';
import { RateLimitConfig, RateLimitService } from '../shared/rate-limit/rate-limit.service';
import { SendMessageDto, MAX_ENCRYPTED_CONTENT_BYTES } from '../modules/messages/dto/send-message.dto';
import { GetMessagesSocketDto } from '../modules/messages/dto/get-messages-query.dto';
import { MarkReadSocketDto } from '../modules/channels/dto/mark-read.dto';
import { ReactionDto } from '../modules/reactions/dto/add-reaction.dto';
import { SocketError, toSocketError } from '../common/errors/socket-error';
import { getCorsOrigins } from '../common/config';

@WebSocketGateway({ cors: { origin: getCorsOrigins(), credentials: true } })
@UseGuards(SocketAuthGuard)
export class ChatGateway {
  constructor(
    private chatService: ChatService,
    private messagesService: MessagesService,
    private reactionsService: ReactionsService,
    private channelsService: ChannelsService,
    private rateLimitService: RateLimitService,
  ) {}

  private async limit(key: string, config: RateLimitConfig, message = 'Too many requests') {
    const rl = await this.rateLimitService.checkRateLimit(key, config);
    if (!rl.allowed) throw new SocketError('RATE_LIMITED', message);
  }

  // ─── Send Message ──────────────────────────────────────────────────────

  @SubscribeMessage('send-message')
  async handleSendMessage(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      await this.limit(`send:${user.id}`, RateLimitService.SEND_MESSAGE, 'Too many messages');

      const content = (data as { encryptedContent?: unknown } | null)?.encryptedContent;
      if (typeof content === 'string' && Buffer.byteLength(content, 'utf-8') > MAX_ENCRYPTED_CONTENT_BYTES) {
        throw new SocketError('PAYLOAD_TOO_LARGE', 'Message exceeds 10KB limit');
      }
      const dto = validatePayload(SendMessageDto, data);

      // Same pipeline as REST POST /messages; the sending socket already has it
      const message = await this.messagesService.send(
        { userId: user.id, ...dto },
        { exceptSocketId: client.id },
      );
      return { success: true, message };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── Get Messages ──────────────────────────────────────────────────────

  @SubscribeMessage('get-messages')
  async handleGetMessages(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      await this.limit(`getmsg:${user.id}`, RateLimitService.GET_MESSAGES);
      const dto = validatePayload(GetMessagesSocketDto, data);
      const page = await this.messagesService.getMessages(
        dto.channelId,
        user.id,
        dto.limit ?? 50,
        dto.cursor,
        dto.mode,
      );
      return { success: true, ...page };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── Mark as Read ──────────────────────────────────────────────────────

  @SubscribeMessage('mark-read')
  async handleMarkRead(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      const dto = validatePayload(MarkReadSocketDto, data);
      return await this.channelsService.markRead(user.id, dto.channelId, dto.messageId);
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── Unread / Pending ──────────────────────────────────────────────────

  @SubscribeMessage('get-unread')
  async handleGetUnread(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    try {
      const counts = await this.chatService.getUnreadCounts(user.id);
      return { success: true, counts };
    } catch (err) {
      return toSocketError(err);
    }
  }

  /**
   * Offline messages are delivered only when the client asks (its listeners
   * are attached by then). Each call pops exactly the returned batch;
   * `hasMore` tells the client to call again.
   */
  @SubscribeMessage('get-pending')
  async handleGetPending(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    try {
      await this.limit(`pending:${user.id}`, RateLimitService.GET_MESSAGES);
      const { messages, remaining } = await this.chatService.deliverPendingMessages(user.id);
      return { success: true, count: messages.length, messages, hasMore: remaining > 0 };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── Reactions ─────────────────────────────────────────────────────────

  @SubscribeMessage('reaction:add')
  async handleReactionAdd(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      await this.limit(`reaction:${user.id}`, RateLimitService.REACTION);
      const dto = validatePayload(ReactionDto, data);
      return await this.reactionsService.addReaction(
        { id: user.id, username: user.username },
        dto.channelId,
        dto.messageId,
        dto.emoji,
      );
    } catch (err) {
      return toSocketError(err);
    }
  }

  @SubscribeMessage('reaction:remove')
  async handleReactionRemove(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      await this.limit(`reaction:${user.id}`, RateLimitService.REACTION);
      const dto = validatePayload(ReactionDto, data);
      return await this.reactionsService.removeReaction(
        { id: user.id, username: user.username },
        dto.channelId,
        dto.messageId,
        dto.emoji,
      );
    } catch (err) {
      return toSocketError(err);
    }
  }

  /** Legacy alias: older clients emit `reaction:removed` to remove a reaction. */
  @SubscribeMessage('reaction:removed')
  handleReactionRemoveLegacy(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    return this.handleReactionRemove(client, data);
  }
}
