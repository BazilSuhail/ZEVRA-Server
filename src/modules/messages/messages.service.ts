import {
  Inject,
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  PayloadTooLargeException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, lt, gt, desc, asc, sql, inArray, ne } from 'drizzle-orm';
import { DB } from '../../database/database.module';
import { messages, memberships, channels, users, reactions } from '../../database/schema';
import { CryptoService } from '../../shared/crypto/crypto.service';
import { RedisCacheService } from '../../redis/redis-cache.service';
import { RedisSessionService } from '../../redis/redis-session.service';
import { ChannelMembersService } from '../../redis/channel-members.service';
import { MESSAGE_CACHE_SIZE } from '../../redis/redis-keys';
import { SocketService } from '../../socket/socket.service';
import {
  MESSAGE_DELIVERY_QUEUE,
  MessageDeliveryJob,
  runMessageDelivery,
} from '../../shared/queues/message-delivery.job';
import {
  MAX_ENCRYPTED_CONTENT_BYTES,
  MAX_METADATA_BYTES,
  MessageType,
} from './dto/send-message.dto';
import type { MessagePageMode } from './dto/get-messages-query.dto';
import {
  HistoryMessage,
  MessagePayload,
  MessageReaction,
  toMessagePayload,
} from './message-payload';

export interface SendMessageInput {
  userId: string;
  channelId: string;
  encryptedContent: string;
  contentIv: string;
  contentTag: string;
  signature: string;
  sequenceNumber?: number;
  senderKeyEpoch: number;
  messageType?: string;
  metadata?: Record<string, unknown>;
}

export interface MessagePage {
  messages: HistoryMessage[];
  nextCursor: number | null;
  hasMore: boolean;
  source: 'cache' | 'database';
}

const MESSAGE_TYPES = new Set<string>(Object.values(MessageType));
const MAX_SEQUENCE_RETRIES = 3;

@Injectable()
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private crypto: CryptoService,
    private cache: RedisCacheService,
    private session: RedisSessionService,
    private members: ChannelMembersService,
    private socket: SocketService,
    @InjectQueue(MESSAGE_DELIVERY_QUEUE) private deliveryQueue: Queue<MessageDeliveryJob>,
  ) {}

  onModuleInit() {
    let logged = false;
    this.deliveryQueue.on('error', (err: Error) => {
      if (logged) return;
      logged = true;
      this.logger.error(`Delivery queue error: ${err.message}`);
    });
  }

  // ─── Send (shared by socket `send-message` and REST POST /messages) ─────

  /**
   * Persists, broadcasts `message:new`, caches, and schedules offline
   * delivery + unread counters. Returns the `message:new` payload.
   */
  async send(input: SendMessageInput, options: { exceptSocketId?: string } = {}): Promise<MessagePayload> {
    this.assertSendLimits(input);

    // Membership + archived state + signing key + username in one query
    const [member] = await this.db
      .select({
        membershipId: memberships.id,
        publicKeySign: users.publicKeySign,
        username: users.username,
        isArchived: channels.isArchived,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(channels, eq(channels.id, memberships.channelId))
      .where(and(eq(memberships.userId, input.userId), eq(memberships.channelId, input.channelId)));

    if (!member) {
      throw new ForbiddenException('Not a member of this channel');
    }
    if (member.isArchived) {
      throw new BadRequestException('Channel is archived');
    }

    // The signature binds channel + ciphertext (the sequence number is
    // assigned server-side, so the client cannot sign it).
    if (input.signature && member.publicKeySign) {
      const valid = this.crypto.verify(
        Buffer.from(`${input.channelId}:${input.encryptedContent}`, 'utf-8'),
        Buffer.from(input.signature, 'base64'),
        Buffer.from(member.publicKeySign, 'base64'),
      );
      if (!valid) {
        throw new BadRequestException('Invalid message signature');
      }
    }

    const row = await this.insertWithSequence(input);
    const payload = toMessagePayload(row, member.username);
    await this.dispatchNewMessage(payload, options.exceptSocketId);
    return payload;
  }

  private assertSendLimits(input: SendMessageInput) {
    if (typeof input.encryptedContent !== 'string' || input.encryptedContent.length === 0) {
      throw new BadRequestException('encryptedContent is required');
    }
    if (Buffer.byteLength(input.encryptedContent, 'utf-8') > MAX_ENCRYPTED_CONTENT_BYTES) {
      throw new PayloadTooLargeException('Message exceeds 10KB limit');
    }
    if (!input.contentIv || input.contentIv.length > 32 || !input.contentTag || input.contentTag.length > 32) {
      throw new BadRequestException('contentIv and contentTag must be 1-32 characters');
    }
    if (input.messageType !== undefined && !MESSAGE_TYPES.has(input.messageType)) {
      throw new BadRequestException('Invalid messageType');
    }
    if (input.metadata !== undefined && input.metadata !== null) {
      if (typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
        throw new BadRequestException('metadata must be an object');
      }
      if (Buffer.byteLength(JSON.stringify(input.metadata), 'utf-8') > MAX_METADATA_BYTES) {
        throw new PayloadTooLargeException('metadata exceeds 64KB limit');
      }
    }
  }

  private async nextSequence(channelId: string, tx: NodePgDatabase): Promise<number> {
    // Lock the channel row so concurrent sends for this channel serialize.
    await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).for('update');
    const [{ maxSeq }] = await tx
      .select({ maxSeq: sql<number>`coalesce(max(${messages.sequenceNumber}), 0)` })
      .from(messages)
      .where(eq(messages.channelId, channelId));
    return Number(maxSeq) + 1;
  }

  private async insertWithSequence(input: SendMessageInput) {
    for (let attempt = 0; attempt < MAX_SEQUENCE_RETRIES; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const seq = await this.nextSequence(input.channelId, tx);
          const [msg] = await tx
            .insert(messages)
            .values({
              senderId: input.userId,
              channelId: input.channelId,
              encryptedContent: input.encryptedContent,
              contentIv: input.contentIv,
              contentTag: input.contentTag,
              signature: input.signature ?? '',
              sequenceNumber: seq,
              senderKeyEpoch: input.senderKeyEpoch,
              messageType: input.messageType ?? MessageType.TEXT,
              metadata: input.metadata ?? null,
            })
            .returning();

          await tx
            .update(channels)
            .set({ lastMessageId: msg.id, lastMessageAt: msg.createdAt, updatedAt: new Date() })
            .where(eq(channels.id, input.channelId));

          // The sender has read their own message
          await tx
            .update(memberships)
            .set({ lastReadMessageId: msg.id, lastReadAt: new Date() })
            .where(and(eq(memberships.userId, input.userId), eq(memberships.channelId, input.channelId)));

          return msg;
        });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === '23505' && attempt < MAX_SEQUENCE_RETRIES - 1) {
          this.logger.warn(`Sequence collision on channel ${input.channelId}, retrying`);
          continue;
        }
        throw err;
      }
    }
    throw new BadRequestException('Failed to assign sequence number');
  }

  /**
   * Broadcast + cache + offline delivery. Recipients without a live socket in
   * the channel room right now (cluster-wide, not the presence key) are
   * queued; if that cannot be determined every recipient is queued.
   */
  private async dispatchNewMessage(payload: MessagePayload, exceptSocketId?: string) {
    const [memberIds, connected] = await Promise.all([
      this.members.getMembers(payload.channelId),
      this.socket.getConnectedUserIds(payload.channelId),
    ]);

    this.socket.emitToChannel(payload.channelId, 'message:new', payload, { exceptSocketId });
    await this.cache.cacheMessage(payload.channelId, payload);

    const recipientIds = memberIds.filter((id) => id !== payload.senderId);
    const job: MessageDeliveryJob = {
      message: payload,
      recipientIds,
      offlineUserIds: recipientIds.filter((id) => !connected?.has(id)),
    };
    if (recipientIds.length === 0) return;

    try {
      await this.deliveryQueue.add('deliver', job, {
        priority: 1,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      });
    } catch (err) {
      this.logger.warn(`Delivery queue unavailable, delivering inline: ${(err as Error).message}`);
      await runMessageDelivery(job, this.session, this.cache);
    }
  }

  // ─── History (socket get-messages, REST GET /messages/channel/:id) ─────
  //
  // cursor = sequence number (per channel, contiguous from 1).
  //   'latest' / 'before' without cursor: newest `limit`, ascending
  //   'before' + cursor: older than cursor, ascending
  //   'since'  + cursor: newer than cursor, ascending
  // nextCursor = oldest seq in page ('before' paging) or newest ('since').

  async getMessages(
    channelId: string,
    userId: string,
    limit = 50,
    cursor?: number,
    mode: MessagePageMode = 'before',
  ): Promise<MessagePage> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100);

    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId)))
      .limit(1);
    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    if (cursor == null && mode !== 'since' && safeLimit <= MESSAGE_CACHE_SIZE) {
      const cached = await this.getCachedPage(channelId, safeLimit);
      if (cached) return cached;
    }

    const conditions = [eq(messages.channelId, channelId)];
    if (mode === 'before' && cursor != null) conditions.push(lt(messages.sequenceNumber, cursor));
    if (mode === 'since' && cursor != null) conditions.push(gt(messages.sequenceNumber, cursor));
    const descending = mode !== 'since';

    const rows = await this.db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        senderId: messages.senderId,
        senderUsername: users.username,
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
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .where(and(...conditions))
      .orderBy(descending ? desc(messages.sequenceNumber) : asc(messages.sequenceNumber))
      .limit(safeLimit + 1);

    const hasMore = rows.length > safeLimit;
    const page = hasMore ? rows.slice(0, safeLimit) : rows;
    const ordered = descending ? [...page].reverse() : page;
    const payloads = ordered.map((r) => toMessagePayload(r, r.senderUsername));

    let nextCursor: number | null = null;
    if (hasMore) {
      nextCursor = descending
        ? (payloads[0]?.sequenceNumber ?? null)
        : (payloads[payloads.length - 1]?.sequenceNumber ?? null);
    }

    return {
      messages: await this.attachReactions(payloads),
      nextCursor,
      hasMore,
      source: 'database',
    };
  }

  /**
   * Newest page from the Redis cache, only when it is complete: at least
   * `limit` well-formed entries with contiguous sequence numbers.
   */
  private async getCachedPage(channelId: string, limit: number): Promise<MessagePage | null> {
    const cached = await this.cache.getRecentMessages<MessagePayload>(channelId, limit);
    if (cached.length < limit) return null;

    const items = [...cached].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    for (let i = 0; i < items.length; i++) {
      const m = items[i];
      const wellFormed =
        typeof m?.id === 'string' &&
        typeof m.signature === 'string' &&
        typeof m.isDeleted === 'boolean' &&
        typeof m.sequenceNumber === 'number';
      if (!wellFormed || (i > 0 && m.sequenceNumber !== items[i - 1].sequenceNumber + 1)) {
        await this.cache.invalidateMessages(channelId);
        return null;
      }
    }

    const oldest = items[0].sequenceNumber;
    const hasMore = oldest > 1;
    return {
      messages: await this.attachReactions(items),
      nextCursor: hasMore ? oldest : null,
      hasMore,
      source: 'cache',
    };
  }

  /** One query for the whole page's reactions (with usernames). */
  private async attachReactions(items: MessagePayload[]): Promise<HistoryMessage[]> {
    const ids = items.filter((m) => !m.isDeleted).map((m) => m.id);
    const grouped = new Map<string, MessageReaction[]>();
    if (ids.length > 0) {
      const rows = await this.db
        .select({
          messageId: reactions.messageId,
          emoji: reactions.emoji,
          userId: reactions.userId,
          username: users.username,
        })
        .from(reactions)
        .leftJoin(users, eq(users.id, reactions.userId))
        .where(inArray(reactions.messageId, ids));
      for (const r of rows) {
        const list = grouped.get(r.messageId) ?? [];
        list.push({ emoji: r.emoji, userId: r.userId, username: r.username });
        grouped.set(r.messageId, list);
      }
    }
    return items.map((m) => ({ ...m, reactions: grouped.get(m.id) ?? [] }));
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  async deleteMessage(userId: string, messageId: string) {
    const [msg] = await this.db
      .select({
        id: messages.id,
        senderId: messages.senderId,
        channelId: messages.channelId,
        isDeleted: messages.isDeleted,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!msg) throw new NotFoundException('Message not found');
    if (msg.senderId !== userId) {
      throw new ForbiddenException('Can only delete your own messages');
    }

    if (!msg.isDeleted) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(messages)
          .set({ isDeleted: true, encryptedContent: '', metadata: null, updatedAt: new Date() })
          .where(eq(messages.id, messageId));

        await tx.delete(reactions).where(eq(reactions.messageId, messageId));

        // If this was the channel's last message, point the preview at the
        // newest remaining message instead.
        const [channel] = await tx
          .select({ lastMessageId: channels.lastMessageId })
          .from(channels)
          .where(eq(channels.id, msg.channelId))
          .for('update');
        if (channel?.lastMessageId === messageId) {
          const [prev] = await tx
            .select({ id: messages.id, createdAt: messages.createdAt })
            .from(messages)
            .where(
              and(
                eq(messages.channelId, msg.channelId),
                eq(messages.isDeleted, false),
                ne(messages.id, messageId),
              ),
            )
            .orderBy(desc(messages.sequenceNumber))
            .limit(1);
          await tx
            .update(channels)
            .set({
              lastMessageId: prev?.id ?? null,
              lastMessageAt: prev?.createdAt ?? null,
              updatedAt: new Date(),
            })
            .where(eq(channels.id, msg.channelId));
        }
      });
    }

    await this.cache.invalidateMessages(msg.channelId);
    this.socket.emitToChannel(msg.channelId, 'message:deleted', {
      messageId,
      channelId: msg.channelId,
    });

    return { success: true, messageId, channelId: msg.channelId };
  }
}
