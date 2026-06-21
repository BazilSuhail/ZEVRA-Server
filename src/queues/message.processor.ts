import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Inject } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages, channels, memberships } from '../database/schema';
import { eq, and } from 'drizzle-orm';

interface MessageJob {
  senderId: string;
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

@Processor('messages')
export class MessageProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(@Inject(DB) private db: NodePgDatabase) {
    super();
  }

  async process(job: Job<MessageJob>) {
    const {
      senderId,
      channelId,
      encryptedContent,
      contentIv,
      contentTag,
      signature,
      sequenceNumber,
      senderKeyEpoch,
      messageType,
      metadata,
    } = job.data;

    // 1. Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, senderId),
          eq(memberships.channelId, channelId),
        ),
      );

    if (!membership) {
      this.logger.warn(`User ${senderId} not member of channel ${channelId}`);
      return { success: false, reason: 'not_a_member' };
    }

    // 2. Check duplicate sequence
    const [existing] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.senderId, senderId),
          eq(messages.channelId, channelId),
          eq(messages.sequenceNumber, sequenceNumber),
        ),
      );

    if (existing) {
      this.logger.warn(`Duplicate sequence ${sequenceNumber} for user ${senderId}`);
      return { success: false, reason: 'duplicate_sequence' };
    }

    // 3. Insert message
    const [msg] = await this.db
      .insert(messages)
      .values({
        senderId,
        channelId,
        encryptedContent,
        contentIv,
        contentTag,
        signature,
        sequenceNumber,
        senderKeyEpoch,
        messageType: messageType ?? 'TEXT',
        metadata: (metadata as any) ?? null,
      })
      .returning({
        id: messages.id,
        sequenceNumber: messages.sequenceNumber,
        createdAt: messages.createdAt,
      });

    // 4. Update channel
    await this.db
      .update(channels)
      .set({
        lastMessageId: msg.id,
        lastMessageAt: msg.createdAt,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId));

    // 5. Auto-mark sender read
    await this.db
      .update(memberships)
      .set({ lastReadMessageId: msg.id, lastReadAt: new Date() })
      .where(
        and(
          eq(memberships.userId, senderId),
          eq(memberships.channelId, channelId),
        ),
      );

    this.logger.log(`Message ${msg.id} stored in channel ${channelId}`);

    return { success: true, messageId: msg.id, createdAt: msg.createdAt };
  }
}
