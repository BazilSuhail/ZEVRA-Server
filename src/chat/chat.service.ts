import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages, memberships, messageReads, channels, reactions, users } from '../database/schema';
import { eq, and, lt, gt, desc, asc, sql, inArray } from 'drizzle-orm';
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
  metadata?: Record<string, unknown> | null;
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
      metadata: (msg.metadata as Record<string, unknown>) ?? null,
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
      metadata: (msg.metadata as Record<string, unknown>) ?? null,
      createdAt: msg.createdAt.toISOString(),
    }, {
      priority: 1, // High priority for message delivery
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    }).catch((err) => this.logger.warn(`Delivery queue add failed: ${err.message}`));

    return msg;
  }

  // ─── Get Messages (cache-first) ────────────────────────────────────────
  //
  // Contract: cursor = sequence_number (per-channel, monotonic).
  //   mode 'latest' (default, no cursor): newest `limit`, returned ascending
  //   mode 'before' (cursor): older than cursor, newest `limit`, ascending
  //   mode 'since'  (cursor): newer than cursor, oldest `limit`, ascending
  // nextCursor = sequence_number of the oldest message in the page (for
  // 'before' paging) or the newest (for 'since' paging); null when no more.

  /**
   * Batch-load reactions for a page of messages (one query, usernames
   * included) so history responses are reaction-complete.
   */
  private async getReactionsForMessages(messageIds: string[]) {
    if (messageIds.length === 0) return {} as Record<
      string,
      { emoji: string; userId: string; username: string | null }[]
    >;

    const rows = await this.db
      .select({
        messageId: reactions.messageId,
        emoji: reactions.emoji,
        userId: reactions.userId,
        username: users.username,
      })
      .from(reactions)
      .leftJoin(users, eq(users.id, reactions.userId))
      .where(inArray(reactions.messageId, messageIds));

    const grouped: Record<
      string,
      { emoji: string; userId: string; username: string | null }[]
    > = {};
    for (const row of rows) {
      (grouped[row.messageId] ||= []).push({
        emoji: row.emoji,
        userId: row.userId,
        username: row.username,
      });
    }
    return grouped;
  }

  async getMessages(
    channelId: string,
    userId: string,
    limit = 50,
    cursor?: number,
    mode: 'latest' | 'before' | 'since' = 'before',
  ) {
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

    // Try cache first — only for the latest page
    if (mode === 'latest' && cursor == null) {
      const cached = await this.cacheService.getRecentMessages(channelId, limit);
      if (cached.length >= limit) {
        // Cache payloads are keyed `messageId`; the response contract is `id`
        const items = (cached as PendingMessagePayload[]).map((m) => ({
          ...m,
          id: m.messageId,
        }));
        const reactionMap = await this.getReactionsForMessages(
          items.map((m) => m.id),
        );
        return {
          messages: items.map((m) => ({
            ...m,
            reactions: reactionMap[m.id] ?? [],
          })),
          nextCursor: items[0]?.sequenceNumber ?? null,
          hasMore: true,
          source: 'cache',
        };
      }
    }

    // Fallback to Postgres
    const conditions = [eq(messages.channelId, channelId)];
    if (mode === 'before' && cursor != null) {
      conditions.push(lt(messages.sequenceNumber, cursor));
    } else if (mode === 'since' && cursor != null) {
      conditions.push(gt(messages.sequenceNumber, cursor));
    }

    const descending = mode !== 'since';

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
      .orderBy(descending ? desc(messages.sequenceNumber) : asc(messages.sequenceNumber))
      .limit(limit + 1);

    const hasMore = result.length > limit;
    const page = hasMore ? result.slice(0, limit) : result;
    const data = descending ? [...page].reverse() : page;

    // Attach reactions for the whole page in one query
    const reactionMap = await this.getReactionsForMessages(
      data.map((m) => m.id),
    );
    const withReactions = data.map((m) => ({
      ...m,
      reactions: reactionMap[m.id] ?? [],
    }));

    let nextCursor: number | null = null;
    if (hasMore) {
      nextCursor = descending
        ? data[0]?.sequenceNumber ?? null // oldest → fetch 'before' from here
        : data[data.length - 1]?.sequenceNumber ?? null; // newest → fetch 'since'
    }

    return {
      messages: withReactions,
      nextCursor,
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
      .insert(messageReads)
      .values({ messageId, userId, readAt: new Date() })
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

  // ─── Get Unread Counts ─────────────────────────────────────────────────

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

  // ─── Handle Incoming PubSub Message (cross-node) ───────────────────────

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

  async getUserDMPeers(userId: string): Promise<string[]> {
    const dmChannels = await this.db
      .select({ channelId: memberships.channelId })
      .from(memberships)
      .innerJoin(channels, eq(channels.id, memberships.channelId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(channels.type, 'DIRECT'),
        ),
      );

    if (dmChannels.length === 0) return [];

    const dmChannelIds = dmChannels.map((c) => c.channelId);

    const dmPeers = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          inArray(memberships.channelId, dmChannelIds),
          sql`${memberships.userId} != ${userId}`,
        ),
      );

    return [...new Set(dmPeers.map((p) => p.userId))];
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
