import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Inject } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messageReads, memberships } from '../database/schema';
import { eq, and } from 'drizzle-orm';

interface ReadReceiptJob {
  userId: string;
  channelId: string;
  messageId: string;
}

@Processor('read-receipts')
export class ReadReceiptProcessor extends WorkerHost {
  private readonly logger = new Logger(ReadReceiptProcessor.name);

  constructor(@Inject(DB) private db: NodePgDatabase) {
    super();
  }

  async process(job: Job<ReadReceiptJob>) {
    const { userId, channelId, messageId } = job.data;

    // 1. Verify membership
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
      return { success: false, reason: 'not_a_member' };
    }

    // 2. Insert read receipt (ignore if exists)
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
      await this.db.insert(messageReads).values({ messageId, userId });
    }

    // 3. Update membership position
    await this.db
      .update(memberships)
      .set({ lastReadMessageId: messageId, lastReadAt: new Date() })
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.channelId, channelId),
        ),
      );

    return { success: true };
  }
}
