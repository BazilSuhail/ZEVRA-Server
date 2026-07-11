import { Injectable, Logger } from '@nestjs/common';
import { RedisClientType } from 'redis';

@Injectable()
export class RedisCacheService {
  private readonly logger = new Logger(RedisCacheService.name);
  private client: RedisClientType | null = null;

  setClient(client: RedisClientType | null) {
    this.client = client;
  }

  // ─── Recent Messages Cache ──────────────────────────────────────────────

  async cacheMessage(channelId: string, message: object, maxItems = 50): Promise<void> {
    if (!this.client) return;
    try {
      const key = `cache:messages:${channelId}`;
      await this.client.rPush(key, JSON.stringify(message));
      await this.client.lTrim(key, -maxItems, -1);
      await this.client.expire(key, 86400);
    } catch (err) {
      this.logger.warn(`cacheMessage failed: ${(err as Error).message}`);
    }
  }

  async getRecentMessages(channelId: string, limit = 50): Promise<object[]> {
    if (!this.client) return [];
    try {
      const key = `cache:messages:${channelId}`;
      const items = await this.client.lRange(key, 0, limit - 1);
      return items.map((item) => JSON.parse(item));
    } catch {
      return [];
    }
  }

  async invalidateMessages(channelId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(`cache:messages:${channelId}`);
    } catch {}
  }

  // ─── Unread Counts ─────────────────────────────────────────────────────

  async incrementUnread(userId: string, channelId: string): Promise<number> {
    if (!this.client) return 0;
    try {
      const key = `cache:unread:${userId}:${channelId}`;
      const count = await this.client.incr(key);
      await this.client.expire(key, 604800);
      return count;
    } catch {
      return 0;
    }
  }

  async getUnreadCount(userId: string, channelId: string): Promise<number> {
    if (!this.client) return 0;
    try {
      const val = await this.client.get(`cache:unread:${userId}:${channelId}`);
      return val ? parseInt(val, 10) : 0;
    } catch {
      return 0;
    }
  }

  async getUnreadCounts(userId: string, channelIds: string[]): Promise<Record<string, number>> {
    if (!this.client || channelIds.length === 0) return {};
    try {
      const keys = channelIds.map((id) => `cache:unread:${userId}:${id}`);
      const values = await this.client.mGet(keys);
      const result: Record<string, number> = {};
      for (let i = 0; i < channelIds.length; i++) {
        result[channelIds[i]] = values[i] ? parseInt(values[i]!, 10) : 0;
      }
      return result;
    } catch {
      return {};
    }
  }

  async resetUnread(userId: string, channelId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(`cache:unread:${userId}:${channelId}`);
    } catch {}
  }

  async resetUnreads(userId: string, channelIds: string[]): Promise<void> {
    if (!this.client || channelIds.length === 0) return;
    try {
      const keys = channelIds.map((id) => `cache:unread:${userId}:${id}`);
      await this.client.del(keys);
    } catch {}
  }

  // ─── Group Info Cache ──────────────────────────────────────────────────

  async cacheGroupInfo(groupId: string, info: object, ttl = 3600): Promise<void> {
    if (!this.client) return;
    try {
      const key = `cache:group:${groupId}`;
      await this.client.hSet(key, Object.entries(info).map(([k, v]) => [k, String(v)]));
      await this.client.expire(key, ttl);
    } catch {}
  }

  async getGroupInfo(groupId: string): Promise<Record<string, string> | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.hGetAll(`cache:group:${groupId}`);
      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  async invalidateGroupInfo(groupId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(`cache:group:${groupId}`);
    } catch {}
  }

  // ─── Typing Indicators ─────────────────────────────────────────────────

  async setTyping(channelId: string, userId: string, ttlSeconds = 5): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setEx(`typing:${channelId}:${userId}`, ttlSeconds, '1');
    } catch {}
  }

  async clearTyping(channelId: string, userId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(`typing:${channelId}:${userId}`);
    } catch {}
  }

  async getTypingUsers(channelId: string): Promise<string[]> {
    if (!this.client) return [];
    try {
      const pattern = `typing:${channelId}:*`;
      const keys: string[] = [];
      for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        keys.push(String(key));
      }
      return keys.map((key) => key.split(':').pop()!);
    } catch {
      return [];
    }
  }

  // ─── Read Receipts Cache ───────────────────────────────────────────────

  async cacheReadReceipt(channelId: string, userId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      const key = `cache:read_receipts:${channelId}`;
      await this.client.hSet(key, userId, messageId);
      await this.client.expire(key, 300);
    } catch {}
  }

  async getReadReceipts(channelId: string): Promise<Record<string, string>> {
    if (!this.client) return {};
    try {
      return await this.client.hGetAll(`cache:read_receipts:${channelId}`);
    } catch {
      return {};
    }
  }
}
