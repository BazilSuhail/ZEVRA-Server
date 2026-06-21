import { Inject, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages, memberships, channels, messageReads, users } from '../database/schema';
import { eq, and, lt, desc, sql, count } from 'drizzle-orm';
import { RealtimeService } from '../realtime/realtime.service';

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private realtime: RealtimeService,
  ) {}

  async send(params: {
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
  }) {
    // 1. Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, params.userId),
          eq(memberships.channelId, params.channelId),
        ),
      );

    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    // 2. Check for duplicate sequence number (replay protection)
    const [existing] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.senderId, params.userId),
          eq(messages.channelId, params.channelId),
          eq(messages.sequenceNumber, params.sequenceNumber),
        ),
      );

    if (existing) {
      throw new ForbiddenException('Duplicate sequence number');
    }

    // 3. Insert message
    const [msg] = await this.db
      .insert(messages)
      .values({
        senderId: params.userId,
        channelId: params.channelId,
        encryptedContent: params.encryptedContent,
        contentIv: params.contentIv,
        contentTag: params.contentTag,
        signature: params.signature,
        sequenceNumber: params.sequenceNumber,
        senderKeyEpoch: params.senderKeyEpoch,
        messageType: params.messageType ?? 'TEXT',
        metadata: (params.metadata as any) ?? null,
      })
      .returning({
        id: messages.id,
        sequenceNumber: messages.sequenceNumber,
        createdAt: messages.createdAt,
      });

    // 4. Update channel last message
    await this.db
      .update(channels)
      .set({
        lastMessageId: msg.id,
        lastMessageAt: msg.createdAt,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, params.channelId));

    // 5. Auto-mark sender's read position
    await this.db
      .update(memberships)
      .set({
        lastReadMessageId: msg.id,
        lastReadAt: new Date(),
      })
      .where(
        and(
          eq(memberships.userId, params.userId),
          eq(memberships.channelId, params.channelId),
        ),
      );

    // 6. Broadcast to channel subscribers
    this.realtime.broadcastMessage(params.channelId, {
      id: msg.id,
      senderId: params.userId,
      channelId: params.channelId,
      encryptedContent: params.encryptedContent,
      contentIv: params.contentIv,
      contentTag: params.contentTag,
      signature: params.signature,
      sequenceNumber: params.sequenceNumber,
      senderKeyEpoch: params.senderKeyEpoch,
      messageType: params.messageType ?? 'TEXT',
      createdAt: msg.createdAt,
    });

    return msg;
  }

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

    // Fetch messages (cursor-based pagination)
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
    };
  }

  async getUnreadCounts(userId: string) {
    const result = await this.db
      .select({
        channelId: memberships.channelId,
        lastReadMessageId: memberships.lastReadMessageId,
        lastReadAt: memberships.lastReadAt,
      })
      .from(memberships)
      .where(eq(memberships.userId, userId));

    const counts: Record<string, number> = {};

    for (const row of result) {
      const [unseen] = await this.db
        .select({ total: count() })
        .from(messages)
        .where(
          and(
            eq(messages.channelId, row.channelId),
            eq(messages.isDeleted, false),
            row.lastReadAt
              ? lt(messages.createdAt, row.lastReadAt)
              : sql`true`,
          ),
        );

      counts[row.channelId] = unseen.total;
    }

    return counts;
  }

  async markRead(userId: string, channelId: string, messageId: string) {
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

    // Upsert read receipt
    const [existing] = await this.db
      .select({ id: messageReads.id })
      .from(messageReads)
      .where(
        and(
          eq(messageReads.messageId, messageId),
          eq(messageReads.userId, userId),
        ),
      );

    if (!existing) {
      await this.db.insert(messageReads).values({
        messageId,
        userId,
      });
    }

    // Update membership last read
    await this.db
      .update(memberships)
      .set({
        lastReadMessageId: messageId,
        lastReadAt: new Date(),
      })
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.channelId, channelId),
        ),
      );

    // Broadcast read receipt
    this.realtime.broadcastReadReceipt(channelId, userId, messageId);

    return { success: true };
  }

  async deleteMessage(userId: string, messageId: string) {
    const [msg] = await this.db
      .select({ id: messages.id, senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.id, messageId));

    if (!msg) throw new NotFoundException('Message not found');
    if (msg.senderId !== userId) {
      throw new ForbiddenException('Can only delete your own messages');
    }

    await this.db
      .update(messages)
      .set({ isDeleted: true, updatedAt: new Date() })
      .where(eq(messages.id, messageId));

    return { success: true };
  }
}
