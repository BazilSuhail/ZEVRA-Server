import type { PendingMessage, RedisSessionService } from '../../redis/redis-session.service';
import type { RedisCacheService } from '../../redis/redis-cache.service';

export const MESSAGE_DELIVERY_QUEUE = 'message-delivery';

export interface MessageDeliveryJob {
  message: PendingMessage;
  /** Every channel member except the sender (unread counters). */
  recipientIds: string[];
  /** Recipients with no live socket in the channel room at broadcast time. */
  offlineUserIds: string[];
}

/**
 * Offline queue + unread counters for one message. Used by the BullMQ
 * processor and as the inline fallback when the queue is unavailable.
 */
export async function runMessageDelivery(
  job: MessageDeliveryJob,
  session: RedisSessionService,
  cache: RedisCacheService,
): Promise<{ queued: number; recipients: number }> {
  await Promise.all([
    session.addPendingMessage(job.offlineUserIds, job.message),
    cache.incrementUnreadMany(job.recipientIds, job.message.channelId),
  ]);
  return { queued: job.offlineUserIds.length, recipients: job.recipientIds.length };
}
