import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RedisSessionService } from '../../redis/redis-session.service';
import { RedisCacheService } from '../../redis/redis-cache.service';
import {
  MESSAGE_DELIVERY_QUEUE,
  MessageDeliveryJob,
  runMessageDelivery,
} from './message-delivery.job';

export type { MessageDeliveryJob } from './message-delivery.job';

/**
 * Offline queue + unread counters. Online delivery already happened via the
 * `channel:{id}` room broadcast; the job carries the recipients that had no
 * live socket in that room at broadcast time.
 */
@Processor(MESSAGE_DELIVERY_QUEUE, { concurrency: 10, stalledInterval: 30_000 })
export class MessageDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageDeliveryProcessor.name);

  constructor(
    private sessionService: RedisSessionService,
    private cacheService: RedisCacheService,
  ) {
    super();
  }

  async process(job: Job<MessageDeliveryJob>) {
    const data = job.data;
    if (!data?.message || !Array.isArray(data.recipientIds) || !Array.isArray(data.offlineUserIds)) {
      // Jobs enqueued by an older server version carry a different shape
      this.logger.warn(`Skipping malformed delivery job ${job.id}`);
      return { queued: 0, recipients: 0 };
    }
    return runMessageDelivery(data, this.sessionService, this.cacheService);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<MessageDeliveryJob> | undefined, err: Error) {
    this.logger.warn(`Delivery job ${job?.id} failed: ${err.message}`);
  }

  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.error(`Delivery worker error: ${err.message}`);
  }
}
