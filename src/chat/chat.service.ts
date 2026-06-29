import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages, memberships, pendingMessages } from '../database/schema';
import { eq, and, lt, desc } from 'drizzle-orm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MessagesService } from '../modules/messages/messages.service';
import { RedisCacheService } from '../redis/redis-cache.service';
import { RedisSessionService } from '../redis/redis-session.service';
import { RedisPubSubService } from '../redis/redis-pubsub.service';
import { SocketService } from '../socket/socket.service';
import { MessageDeliveryJob } from '../shared/queues/message-delivery.processor';
import { ReadReceiptJob } from '../shared/queues/read-receipt.processor';

interface SendMessageInput {
  userId: string;
  channelId: string;
  encryptedContent: string;
  contentIv: string;
  contentTag: string;
  signature: string;
  sequenceNumber: number;
  senderKeyEpoch: number;
  messageType?: string;
  metadata?: Record<string, unknown>;
}

export interface PendingMessagePayload {
  messageId: string;
  channelId: string;
  senderId: string;
  encryptedContent: string;
  contentIv: string;
  contentTag: string;
  sequenceNumber: number;
  senderKeyEpoch: number;
  messageType: string;
  createdAt: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private messagesService: MessagesService,
    private cacheService: RedisCacheService,
    private sessionService: RedisSessionService,
    private pubSubService: RedisPubSubService,
    private socketService: SocketService,
    @InjectQueue('message-delivery') private deliveryQueue: Queue<MessageDeliveryJob>,
    @InjectQueue('read-receipt') private readReceiptQueue: Queue<ReadReceiptJob>,
  ) {}

  // ─── Send Message (sync persist + async delivery) ──────────────────────

  async sendMessage(input: SendMessageInput) {
    // 1. Persist to Postgres (handles membership + signature + sequence)
    const msg = await this.messagesService.send(input);

    // 2. Build payload for distribution
    const payload: PendingMessagePayload = {
      messageId: msg.id,
      channelId: msg.channelId,
      senderId: msg.senderId,
      encryptedContent: msg.encryptedContent,
      contentIv: msg.contentIv,
      contentTag: msg.contentTag,
      sequenceNumber: msg.sequenceNumber,
      senderKeyEpoch: msg.senderKeyEpoch,
      messageType: msg.messageType,
      createdAt: msg.createdAt.toISOString(),
    };

    // 3. Cache in Redis (recent 50 messages per channel)
    await this.cacheService.cacheMessage(input.channelId, payload);

    // 4. Enqueue async delivery via BullMQ (non-blocking)
    this.deliveryQueue.add('deliver', {
      messageId: msg.id,
      channelId: msg.channelId,
      senderId: msg.senderId,
      encryptedContent: msg.encryptedContent,
      contentIv: msg.contentIv,
      contentTag: msg.contentTag,
      sequenceNumber: msg.sequenceNumber,
      senderKeyEpoch: msg.senderKeyEpoch,
      messageType: msg.messageType,
      createdAt: msg.createdAt.toISOString(),
    }, {
      priority: 1, // High priority for message delivery
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    }).catch((err) => this.logger.warn(`Delivery queue add failed: ${err.message}`));

    return msg;
  }

  // ─── Get Messages (cache-first) ────────────────────────────────────────

  async getMessages(channelId: string, userId: string, limit = 50, cursor?: string) {
    // Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.channelId, channelId),
        ),
      );

    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    // Try cache first (only for most recent messages without cursor)
    if (!cursor) {
      const cached = await this.cacheService.getRecentMessages(channelId, limit);
      if (cached.length >= limit) {
        return { messages: cached, nextCursor: null, hasMore: false, source: 'cache' };
      }
    }

    // Fallback to Postgres
    const conditions = [eq(messages.channelId, channelId)];
    if (cursor) {
      conditions.push(lt(messages.createdAt, new Date(cursor)));
    }

    const result = await this.db
      .select({
        id: messages.id,
        messageType: messages.messageType,
        encryptedContent: messages.encryptedContent,
        contentIv: messages.contentIv,
        contentTag: messages.contentTag,
        signature: messages.signature,
        sequenceNumber: messages.sequenceNumber,
        senderKeyEpoch: messages.senderKeyEpoch,
        metadata: messages.metadata,
        isDeleted: messages.isDeleted,
        createdAt: messages.createdAt,
        senderId: messages.senderId,
      })
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);

    const hasMore = result.length > limit;
    const data = hasMore ? result.slice(0, limit) : result;

    return {
      messages: data,
      nextCursor: hasMore ? data[data.length - 1].createdAt.toISOString() : null,
      hasMore,
      source: 'database',
    };
  }

  // ─── Mark as Read (sync persist + async broadcast) ─────────────────────

  async markAsRead(userId: string, channelId: string, messageId: string) {
    // 1. Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id, lastReadMessageId: memberships.lastReadMessageId })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.channelId, channelId),
        ),
      );

    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    // 2. Verify message exists in channel
    const [msg] = await this.db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.channelId, channelId),
        ),
      );

    if (!msg) return { success: true, advanced: false };

    // 3. Only advance forward
    if (membership.lastReadMessageId) {
      const [current] = await this.db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, membership.lastReadMessageId));

      if (current && current.createdAt >= msg.createdAt) {
        return { success: true, advanced: false };
      }
    }

    // 4. Update membership + read receipt in transaction
    await this.db.transaction(async (tx) => {
      await tx
        .update(memberships)
        .set({ lastReadMessageId: messageId, lastReadAt: new Date() })
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.channelId, channelId),
          ),
        );

      await tx
        .insert(pendingMessages)
        .values({ messageId, userId })
        .onConflictDoNothing();
    });

    // 5. Reset unread count
    await this.cacheService.resetUnread(userId, channelId);

    // 6. Enqueue async read receipt broadcast via BullMQ
    this.readReceiptQueue.add('broadcast', {
      userId,
      channelId,
      messageId,
      readAt: new Date().toISOString(),
    }).catch((err) => this.logger.warn(`Read receipt queue add failed: ${err.message}`));

    return { success: true, advanced: true };
  }

  // ─── Get Unread Counts ────────────────────────────────────────────────

  async getUnreadCounts(userId: string) {
    const memberChannels = await this.db
      .select({ channelId: memberships.channelId })
      .from(memberships)
      .where(eq(memberships.userId, userId));

    const channelIds = memberChannels.map((mc) => mc.channelId);
    if (channelIds.length === 0) return {};

    const counts = await this.cacheService.getUnreadCounts(userId, channelIds);
    return counts;
  }

  // ─── Deliver Pending Messages ──────────────────────────────────────────

  async deliverPendingMessages(userId: string) {
    const pending = await this.sessionService.getPendingMessages(userId);
    if (pending.length === 0) return [];

    await this.socketService.emitToUser(userId, 'messages:pending', pending);
    await this.sessionService.clearPendingMessages(userId);

    return pending;
  }

  // ─── Join Channel ──────────────────────────────────────────────────────

  async onUserJoinChannel(userId: string, channelId: string) {
    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.channelId, channelId),
        ),
      );

    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    await this.sessionService.addChannelMember(channelId, userId);
  }

  // ─── Handle Incoming PubSub Message (cross-node) ──────────────────────

  async handlePubSubMessage(channelId: string, message: string) {
    try {
      const parsed = JSON.parse(message);
      const { event, data } = parsed;

      if (event === 'message:new') {
        this.socketService.broadcastToChannel(channelId, event, data);
      } else if (event === 'message:read') {
        this.socketService.broadcastToChannel(channelId, event, data);
      }
    } catch (err) {
      this.logger.warn(`handlePubSubMessage failed: ${(err as Error).message}`);
    }
  }
}
