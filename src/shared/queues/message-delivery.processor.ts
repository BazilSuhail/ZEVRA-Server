import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Inject } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { memberships } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { RedisSessionService } from '../../redis/redis-session.service';
import { RedisCacheService } from '../../redis/redis-cache.service';

const BATCH_SIZE = 100;

export interface MessageDeliveryJob {
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

@Processor('message-delivery', {
  concurrency: 10,
  stalledInterval: 30_000,
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86400 },
})
export class MessageDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageDeliveryProcessor.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private sessionService: RedisSessionService,
    private cacheService: RedisCacheService,
  ) {
    super();
  }

  async process(job: Job<MessageDeliveryJob>) {
    const {
      messageId,
      channelId,
      senderId,
      encryptedContent,
      contentIv,
      contentTag,
      sequenceNumber,
      senderKeyEpoch,
      messageType,
      createdAt,
    } = job.data;

    const payload = {
      messageId,
      channelId,
      senderId,
      encryptedContent,
      contentIv,
      contentTag,
      sequenceNumber,
      senderKeyEpoch,
      messageType,
      createdAt,
    };

    this.logger.debug(`Processing delivery for message ${messageId} in channel ${channelId}`);

    // 1. Get channel members (Redis first, Postgres fallback)
    let members = await this.sessionService.getChannelMembers(channelId);
    if (members.length === 0) {
      const dbMembers = await this.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.channelId, channelId));
      members = dbMembers.map((m) => m.userId);
      // Denormalize for next time
      for (const uid of members) {
        await this.sessionService.addChannelMember(channelId, uid);
      }
    }

    // 2. Check online status for all members
    const onlineUsers = await this.sessionService.getOnlineUsers(members);

    // 3. Handle offline users + unread counts (online delivery is handled by gateway room broadcast)
    let queued = 0;

    const recipients = members.filter((id) => id !== senderId);

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (memberId) => {
          if (!onlineUsers.has(memberId)) {
            // Queue for delivery when user comes online
            await this.sessionService.addPendingMessage(memberId, payload);
            queued++;
          }
          await this.cacheService.incrementUnread(memberId, channelId);
        }),
      );

      this.logger.debug(
        `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} members processed`,
      );
    }

    this.logger.debug(
      `Delivery complete for ${messageId}: ${queued} queued (offline), ${members.length} total members`,
    );

    return { queued, totalMembers: members.length };
  }
}
