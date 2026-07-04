import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages, memberships, pendingMessages, channels } from '../database/schema';
import { eq, and, lt, desc, asc, sql } from 'drizzle-orm';
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
      .orderBy(asc(messages.createdAt))
      .limit(limit + 1);

    const hasMore = result.length > limit;
    const data = hasMore ? result.slice(0, limit) : result;

    return {
      messages: data,
      nextCursor: hasMore ? data[0].createdAt.toISOString() : null,
      hasMore,
      source: 'database',
    };
  }

  // ─── Mark as Read (sync persist + async broadcast) ─────────────────────

  async markAsRead(userId: string, channelId: string, messageId: string) {
    // Single CTE: verify membership + message exists + only advance forward + update
    const result = await this.db.execute(sql`
      WITH membership AS (
        SELECT id, last_read_message_id
        FROM memberships
        WHERE user_id = ${userId} AND channel_id = ${channelId}
      ),
      target_msg AS (
        SELECT id, created_at
        FROM messages
        WHERE id = ${messageId} AND channel_id = ${channelId}
      ),
      should_advance AS (
        SELECT m.id AS membership_id
        FROM membership m
        JOIN target_msg t ON true
        WHERE m.last_read_message_id IS NULL
           OR (
             SELECT created_at FROM messages WHERE id = m.last_read_message_id
           ) < t.created_at
      )
      UPDATE memberships
      SET last_read_message_id = ${messageId},
          last_read_at = now()
      FROM should_advance sa
      WHERE memberships.id = sa.membership_id
      RETURNING memberships.id
    `);

    if (result.rowCount === 0) {
      // Not a member, message not found, or already read past this point
      return { success: true, advanced: false };
    }

    // Insert read receipt (non-blocking, idempotent)
    await this.db
      .insert(pendingMessages)
      .values({ messageId, userId })
      .onConflictDoNothing();

    // Reset unread count
    await this.cacheService.resetUnread(userId, channelId);

    // Enqueue async read receipt broadcast
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

      if (
        event === 'message:new' ||
        event === 'message:read' ||
        event === 'reaction:added' ||
        event === 'reaction:removed'
      ) {
        this.socketService.broadcastToChannel(channelId, event, data);
      }
    } catch (err) {
      this.logger.warn(`handlePubSubMessage failed: ${(err as Error).message}`);
    }
  }

  async getUserChannelIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ channelId: memberships.channelId })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    return rows.map((r) => r.channelId);
  }

  async createOrJoinChannel(userId: string, participantIds: string[], type: string, name?: string) {
    if (type === 'DIRECT' && participantIds.length !== 1) {
      throw new ForbiddenException('Direct message requires exactly 1 other participant');
    }
    if (type === 'DIRECT' && participantIds[0] === userId) {
      throw new ForbiddenException('Cannot DM yourself');
    }

    // DM: find existing channel with both users
    if (type === 'DIRECT') {
      const targetUserId = participantIds[0];
      const existing = await this.db
        .select({ channelId: memberships.channelId })
        .from(memberships)
        .innerJoin(channels, eq(channels.id, memberships.channelId))
        .where(
          and(
            eq(channels.type, 'DIRECT'),
            sql`${memberships.userId} IN (${userId}, ${targetUserId})`,
          ),
        )
        .groupBy(memberships.channelId)
        .having(sql`COUNT(*) = 2`);

      if (existing.length > 0) {
        return { channelId: existing[0].channelId, created: false };
      }
    }

    // Create channel
    const allParticipants = [userId, ...participantIds];
    const [channel] = await this.db
      .insert(channels)
      .values({ type, name: name ?? null })
      .returning({ id: channels.id });

    // Create memberships
    await this.db.insert(memberships).values(
      allParticipants.map((uid) => ({
        userId: uid,
        channelId: channel.id,
        role: uid === userId ? 'ADMIN' : 'MEMBER',
      })),
    );

    // Cache in Redis
    for (const uid of allParticipants) {
      await this.sessionService.addChannelMember(channel.id, uid);
    }

    return { channelId: channel.id, created: true };
  }
}
