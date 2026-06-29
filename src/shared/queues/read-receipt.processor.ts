import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RedisPubSubService } from '../../redis/redis-pubsub.service';
import { RedisCacheService } from '../../redis/redis-cache.service';
import { SocketService } from '../../socket/socket.service';

export interface ReadReceiptJob {
  userId: string;
  channelId: string;
  messageId: string;
  readAt: string;
}

@Processor('read-receipt', {
  concurrency: 5,
  stalledInterval: 15_000,
  removeOnComplete: { age: 1800 },
  removeOnFail: { age: 3600 },
})
export class ReadReceiptProcessor extends WorkerHost {
  private readonly logger = new Logger(ReadReceiptProcessor.name);

  constructor(
    private cacheService: RedisCacheService,
    private pubSubService: RedisPubSubService,
    private socketService: SocketService,
  ) {
    super();
  }

  async process(job: Job<ReadReceiptJob>) {
    const { userId, channelId, messageId, readAt } = job.data;

    this.logger.debug(`Processing read receipt: user=${userId} channel=${channelId} msg=${messageId}`);

    const readReceipt = { userId, messageId, channelId, readAt };

    // 1. Cache in Redis
    await this.cacheService.cacheReadReceipt(channelId, userId, messageId);

    // 2. Broadcast to channel room (local Socket.io)
    this.socketService.broadcastToChannel(channelId, 'message:read', readReceipt);

    // 3. Publish to Redis PubSub (cross-node)
    await this.pubSubService.publishToGroup(channelId, JSON.stringify({
      event: 'message:read',
      data: readReceipt,
    }));

    return { success: true };
  }
}
