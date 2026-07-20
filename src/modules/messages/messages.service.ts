import { Inject, Injectable, ForbiddenException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages, memberships, channels, users } from '../../database/schema';
import { eq, and, lt, gt, desc, asc, sql } from 'drizzle-orm';
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
    // 1. Verify membership + get signing key in one query
    const [member] = await this.db
      .select({
        membershipId: memberships.id,
        publicKeySign: users.publicKeySign,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.userId, params.userId),
          eq(memberships.channelId, params.channelId),
        ),
      );

    if (!member) {
      throw new ForbiddenException('Not a member of this channel');
    }

    // 2. Verify Ed25519 signature (if provided).
    //    The signature binds the channel + ciphertext. It cannot bind the
    //    sequence number because that is assigned server-side inside the
    //    transaction below — the client never knows it in advance.
    if (params.signature && params.signature !== '' && member.publicKeySign) {
      const messageBytes = Buffer.from(
        `${params.channelId}:${params.encryptedContent}`,
        'utf-8',
      );
      const signatureBytes = Buffer.from(params.signature, 'base64');
      const publicKeyBytes = Buffer.from(member.publicKeySign, 'base64');

      const valid = this.crypto.verify(messageBytes, signatureBytes, publicKeyBytes);
      if (!valid) {
        throw new BadRequestException('Invalid message signature');
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

  async getMessages(
    channelId: string,
    userId: string,
    limit = 50,
    cursor?: number,
    mode: 'latest' | 'before' | 'since' = 'before',
  ) {
    // Build message query conditions (cursor = sequence_number)
    const conditions = [eq(messages.channelId, channelId)];
    if (mode === 'before' && cursor != null) {
      conditions.push(lt(messages.sequenceNumber, cursor));
    } else if (mode === 'since' && cursor != null) {
      conditions.push(gt(messages.sequenceNumber, cursor));
    }

    const descending = mode !== 'since';

    // Run membership check + message fetch in parallel
    const [membership, result] = await Promise.all([
      this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.channelId, channelId),
          ),
        ),
      this.db
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
        .limit(limit + 1),
    ]);

    if (membership.length === 0) {
      throw new ForbiddenException('Not a member of this channel');
    }

    const hasMore = result.length > limit;
    const page = hasMore ? result.slice(0, limit) : result;
    const data = descending ? [...page].reverse() : page;

    let nextCursor: number | null = null;
    if (hasMore) {
      nextCursor = descending
        ? data[0]?.sequenceNumber ?? null
        : data[data.length - 1]?.sequenceNumber ?? null;
    }

    return {
      messages: data,
      nextCursor,
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
