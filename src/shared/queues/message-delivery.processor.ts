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
import { RedisPubSubService } from '../../redis/redis-pubsub.service';
import { SocketService } from '../../socket/socket.service';

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
    private pubSubService: RedisPubSubService,
    private socketService: SocketService,
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

    // 3. Deliver to each member (skip sender)
    let delivered = 0;
    let queued = 0;

    const deliveryPromises = members.map(async (memberId) => {
      if (memberId === senderId) return;

      if (onlineUsers.has(memberId)) {
        // Online: emit directly via Socket.io
        const sent = await this.socketService.emitToUser(memberId, 'message:new', payload);
        if (sent) delivered++;
      } else {
        // Offline: queue for later delivery
        await this.sessionService.addPendingMessage(memberId, payload);
        queued++;
      }

      // Increment unread count (non-blocking)
      await this.cacheService.incrementUnread(memberId, channelId);
    });

    await Promise.allSettled(deliveryPromises);

    // 4. Publish to Redis PubSub (cross-node fan-out)
    //    Note: No broadcastToChannel here — emitToUser already handles online users on this node.
    //    Cross-node delivery is handled by PubSub → handlePubSubMessage → broadcastToChannel on remote nodes.
    await this.pubSubService.publishToGroup(channelId, JSON.stringify({
      event: 'message:new',
      data: payload,
    }));

    this.logger.debug(
      `Delivery complete for ${messageId}: ${delivered} delivered, ${queued} queued, ${members.length} total members`,
    );

    return { delivered, queued, totalMembers: members.length };
  }
}
