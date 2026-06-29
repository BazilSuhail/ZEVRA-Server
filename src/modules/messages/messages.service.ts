import { Inject, Injectable, ForbiddenException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages, memberships, channels, users } from '../../database/schema';
import { eq, and, lt, desc, sql } from 'drizzle-orm';
import { CryptoService } from '../../shared/crypto/crypto.service';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private crypto: CryptoService,
  ) {}

  private async nextSequence(channelId: string, tx: NodePgDatabase): Promise<number> {
    // Lock the channel row so concurrent sends for this channel serialize.
    await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');

    const [{ maxSeq }] = await tx
      .select({ maxSeq: sql<number>`coalesce(max(${messages.sequenceNumber}), 0)` })
      .from(messages)
      .where(eq(messages.channelId, channelId));

    return maxSeq + 1;
  }

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

    // 2. Verify Ed25519 signature (if provided)
    if (params.signature && params.signature !== '') {
      const [sender] = await this.db
        .select({ publicKeySign: users.publicKeySign })
        .from(users)
        .where(eq(users.id, params.userId));

      if (sender?.publicKeySign) {
        const messageBytes = Buffer.from(
          `${params.channelId}:${params.encryptedContent}:${params.sequenceNumber}`,
          'utf-8',
        );
        const signatureBytes = Buffer.from(params.signature, 'base64');
        const publicKeyBytes = Buffer.from(sender.publicKeySign, 'base64');

        const valid = this.crypto.verify(messageBytes, signatureBytes, publicKeyBytes);
        if (!valid) {
          throw new BadRequestException('Invalid message signature');
        }
      }
    }

    // 3. Insert message with retry on unique constraint collision
    //    The unique index idx_messages_channel_seq prevents duplicate sequence numbers.
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await this.db.transaction(async (tx) => {
          const seq = await this.nextSequence(params.channelId, tx);

          const [msg] = await tx
            .insert(messages)
            .values({
              senderId: params.userId,
              channelId: params.channelId,
              encryptedContent: params.encryptedContent,
              contentIv: params.contentIv,
              contentTag: params.contentTag,
              signature: params.signature,
              sequenceNumber: seq,
              senderKeyEpoch: params.senderKeyEpoch,
              messageType: params.messageType ?? 'TEXT',
              metadata: (params.metadata as any) ?? null,
            })
            .returning({
              id: messages.id,
              senderId: messages.senderId,
              channelId: messages.channelId,
              encryptedContent: messages.encryptedContent,
              contentIv: messages.contentIv,
              contentTag: messages.contentTag,
              signature: messages.signature,
              sequenceNumber: messages.sequenceNumber,
              senderKeyEpoch: messages.senderKeyEpoch,
              messageType: messages.messageType,
              metadata: messages.metadata,
              isDeleted: messages.isDeleted,
              createdAt: messages.createdAt,
            });

          // Update channel last message
          await tx
            .update(channels)
            .set({
              lastMessageId: msg.id,
              lastMessageAt: msg.createdAt,
              updatedAt: new Date(),
            })
            .where(eq(channels.id, params.channelId));

          // Auto-mark sender's read position
          await tx
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

          return msg;
        });

        return result;
      } catch (err: any) {
        // Unique constraint violation on sequence number — retry
        if (err?.code === '23505' && attempt < MAX_RETRIES - 1) {
          this.logger.warn(`Sequence collision on channel ${params.channelId}, retrying (attempt ${attempt + 1})`);
          continue;
        }
        throw err;
      }
    }

    // Unreachable: loop always returns or throws
    throw new BadRequestException('Failed to assign sequence number');
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
