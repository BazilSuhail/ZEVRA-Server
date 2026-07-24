import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { MESSAGE_CACHE_SIZE, RedisKeys, RedisTtl } from './redis-keys';

@Injectable()
export class RedisCacheService {
  private readonly logger = new Logger(RedisCacheService.name);

  constructor(private readonly redis: RedisService) {}

  private get client() {
    return this.redis.getClient();
  }

  // ─── Recent Messages Cache ──────────────────────────────────────────────

  async cacheMessage(channelId: string, message: object): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const key = RedisKeys.messageCache(channelId);
      await client
        .multi()
        .rPush(key, JSON.stringify(message))
        .lTrim(key, -MESSAGE_CACHE_SIZE, -1)
        .expire(key, RedisTtl.messageCacheSeconds)
        .exec();
    } catch (err) {
      this.logger.warn(`cacheMessage failed: ${(err as Error).message}`);
    }
  }

  /** Last `limit` cached items (newest page) in insertion order. */
  async getRecentMessages<T = unknown>(channelId: string, limit = MESSAGE_CACHE_SIZE): Promise<T[]> {
    const client = this.client;
    if (!client) return [];
    try {
      const items = await client.lRange(RedisKeys.messageCache(channelId), -limit, -1);
      return items.map((item) => JSON.parse(item) as T);
    } catch {
      return [];
    }
  }

  async invalidateMessages(channelId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.del(RedisKeys.messageCache(channelId));
    } catch (err) {
      this.logger.warn(`invalidateMessages failed: ${(err as Error).message}`);
    }
  }

  // ─── Unread Counts ─────────────────────────────────────────────────────

  async incrementUnread(userId: string, channelId: string): Promise<number> {
    const client = this.client;
    if (!client) return 0;
    try {
      const key = RedisKeys.unread(userId, channelId);
      const [count] = await client.multi().incr(key).expire(key, RedisTtl.unreadSeconds).exec();
      return Number(count ?? 0);
    } catch {
      return 0;
    }
  }

  /** Increments the channel's unread counter for many users in one round trip. */
  async incrementUnreadMany(userIds: string[], channelId: string): Promise<void> {
    const client = this.client;
    if (!client || userIds.length === 0) return;
    try {
      const multi = client.multi();
      for (const userId of userIds) {
        const key = RedisKeys.unread(userId, channelId);
        multi.incr(key);
        multi.expire(key, RedisTtl.unreadSeconds);
      }
      await multi.exec();
    } catch (err) {
      this.logger.warn(`incrementUnreadMany failed: ${(err as Error).message}`);
    }
  }

  async getUnreadCount(userId: string, channelId: string): Promise<number> {
    const client = this.client;
    if (!client) return 0;
    try {
      const val = await client.get(RedisKeys.unread(userId, channelId));
      return val ? parseInt(String(val), 10) || 0 : 0;
    } catch {
      return 0;
    }
  }

  /** One MGET for all channels; absent keys count as 0. */
  async getUnreadCounts(userId: string, channelIds: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const id of channelIds) result[id] = 0;
    const client = this.client;
    if (!client || channelIds.length === 0) return result;
    try {
      const values = await client.mGet(channelIds.map((id) => RedisKeys.unread(userId, id)));
      channelIds.forEach((id, i) => {
        const v = values[i];
        result[id] = v ? parseInt(String(v), 10) || 0 : 0;
      });
    } catch (err) {
      this.logger.warn(`getUnreadCounts failed: ${(err as Error).message}`);
    }
    return result;
  }

  async resetUnread(userId: string, channelId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.del(RedisKeys.unread(userId, channelId));
    } catch (err) {
      this.logger.warn(`resetUnread failed: ${(err as Error).message}`);
    }
  }

  // ─── Typing Indicators (per-channel sorted set, score = expiry ms) ─────

  async setTyping(channelId: string, userId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const key = RedisKeys.typing(channelId);
      await client
        .multi()
        .zAdd(key, { score: Date.now() + RedisTtl.typingEntryMs, value: userId })
        .expire(key, RedisTtl.typingSeconds)
        .exec();
    } catch {
      // Typing state is best-effort
    }
  }

  async clearTyping(channelId: string, userId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.zRem(RedisKeys.typing(channelId), userId);
    } catch {
      // Typing state is best-effort
    }
  }

  async getTypingUsers(channelId: string): Promise<string[]> {
    const client = this.client;
    if (!client) return [];
    try {
      const key = RedisKeys.typing(channelId);
      const now = Date.now();
      const results = await client
        .multi()
        .zRemRangeByScore(key, '-inf', now)
        .zRangeByScore(key, now, '+inf')
        .exec();
      const users = results[1];
      return Array.isArray(users) ? users.map(String) : [];
    } catch {
      return [];
    }
  }
}
