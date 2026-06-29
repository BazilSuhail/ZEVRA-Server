import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages, memberships, users, pendingMessages } from '../database/schema';
import { eq, and, lt, desc, sql } from 'drizzle-orm';
import { MessagesService } from '../modules/messages/messages.service';
import { RedisCacheService } from '../redis/redis-cache.service';
import { RedisSessionService } from '../redis/redis-session.service';
import { RedisPubSubService } from '../redis/redis-pubsub.service';
import { SocketService } from '../socket/socket.service';

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

interface PendingMessagePayload {
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
  ) {}

  // ─── Send Message ──────────────────────────────────────────────────────

  async sendMessage(input: SendMessageInput) {
    // 1. Persist to Postgres via MessagesService (handles membership + signature + sequence)
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

    // 4. Get channel members (from Redis or fallback to Postgres)
    let members = await this.sessionService.getChannelMembers(input.channelId);
    if (members.length === 0) {
      // Fallback: load from Postgres and denormalize
      const dbMembers = await this.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.channelId, input.channelId));
      members = dbMembers.map((m) => m.userId);
      for (const uid of members) {
        await this.sessionService.addChannelMember(input.channelId, uid);
      }
    }

    // 5. Process each member (skip sender)
    const onlineUsers = await this.sessionService.getOnlineUsers(members);

    const memberPromises = members.map(async (memberId) => {
      if (memberId === input.userId) return;

      if (onlineUsers.has(memberId)) {
        // Online: deliver via Socket.io
        await this.socketService.emitToUser(memberId, 'message:new', payload);
      } else {
        // Offline: queue for later delivery
        await this.sessionService.addPendingMessage(memberId, payload);
      }

      // Increment unread count for all members (including offline)
      await this.cacheService.incrementUnread(memberId, input.channelId);
    });

    await Promise.allSettled(memberPromises);

    // 6. Broadcast to channel room (for users who have joined the Socket.io room)
    this.socketService.broadcastToChannel(input.channelId, 'message:new', payload);

    // 7. Publish to Redis PubSub (for cross-node fan-out)
    await this.pubSubService.publishToGroup(input.channelId, JSON.stringify({
      event: 'message:new',
      data: payload,
    }));

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

  // ─── Mark as Read ──────────────────────────────────────────────────────

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

    // 4. Update membership + read receipt
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

    // 6. Broadcast read receipt to channel
    const readReceipt = { userId, messageId, channelId, readAt: new Date().toISOString() };
    this.socketService.broadcastToChannel(channelId, 'message:read', readReceipt);

    // 7. Publish via PubSub
    await this.pubSubService.publishToGroup(channelId, JSON.stringify({
      event: 'message:read',
      data: readReceipt,
    }));

    return { success: true, advanced: true };
  }

  // ─── Get Unread Counts ────────────────────────────────────────────────

  async getUnreadCounts(userId: string) {
    // Get all channels user belongs to
    const memberChannels = await this.db
      .select({ channelId: memberships.channelId })
      .from(memberships)
      .where(eq(memberships.userId, userId));

    const channelIds = memberChannels.map((mc) => mc.channelId);
    if (channelIds.length === 0) return {};

    // Get cached unread counts
    const counts = await this.cacheService.getUnreadCounts(userId, channelIds);
    return counts;
  }

  // ─── Deliver Pending Messages ──────────────────────────────────────────

  async deliverPendingMessages(userId: string) {
    const pending = await this.sessionService.getPendingMessages(userId);
    if (pending.length === 0) return [];

    // Deliver to user
    await this.socketService.emitToUser(userId, 'messages:pending', pending);

    // Clear after delivery
    await this.sessionService.clearPendingMessages(userId);

    return pending;
  }

  // ─── Join Channel (Socket.io room + Redis) ────────────────────────────

  async onUserJoinChannel(userId: string, channelId: string) {
    // Ensure user is a member
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

    // Denormalize in Redis
    await this.sessionService.addChannelMember(channelId, userId);
  }

  // ─── Handle Incoming PubSub Message (cross-node) ──────────────────────

  async handlePubSubMessage(channelId: string, message: string) {
    try {
      const parsed = JSON.parse(message);
      const { event, data } = parsed;

      if (event === 'message:new') {
        // Broadcast to local Socket.io room
        this.socketService.broadcastToChannel(channelId, event, data);
      } else if (event === 'message:read') {
        this.socketService.broadcastToChannel(channelId, event, data);
      }
    } catch (err) {
      this.logger.warn(`handlePubSubMessage failed: ${(err as Error).message}`);
    }
  }
}
