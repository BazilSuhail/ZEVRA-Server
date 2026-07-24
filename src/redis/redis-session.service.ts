import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RedisKeys, RedisTtl } from './redis-keys';

/** Stored offline-delivery payload: identical to the `message:new` event payload. */
export interface PendingMessage {
  id: string;
  messageId: string;
  channelId: string;
  senderId: string;
  senderUsername: string | null;
  encryptedContent: string;
  contentIv: string;
  contentTag: string;
  signature: string;
  sequenceNumber: number;
  senderKeyEpoch: number;
  messageType: string;
  metadata: Record<string, unknown> | null;
  isDeleted: boolean;
  createdAt: string;
}

@Injectable()
export class RedisSessionService {
  private readonly logger = new Logger(RedisSessionService.name);

  constructor(private readonly redis: RedisService) {}

  private get client() {
    return this.redis.getClient();
  }

  // ─── Socket registry (multiple sockets per user) ──────────────────────

  /** Registers a socket; returns the number of live sockets for the user (or null if unknown). */
  async addSocket(userId: string, socketId: string): Promise<number | null> {
    const client = this.client;
    if (!client) return null;
    try {
      const key = RedisKeys.sockets(userId);
      const now = Date.now();
      const res = await client
        .multi()
        .zRemRangeByScore(key, '-inf', now - RedisTtl.socketStaleMs)
        .zAdd(key, { score: now, value: socketId })
        .expire(key, RedisTtl.socketsSeconds)
        .zCard(key)
        .exec();
      return Number(res[3] ?? 0);
    } catch (err) {
      this.logger.warn(`addSocket failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Heartbeat: refresh this socket's liveness and the key TTL. */
  async refreshSocket(userId: string, socketId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const key = RedisKeys.sockets(userId);
      await client
        .multi()
        .zAdd(key, { score: Date.now(), value: socketId })
        .expire(key, RedisTtl.socketsSeconds)
        .exec();
    } catch {
      // Next heartbeat retries
    }
  }

  /** Unregisters a socket; returns remaining live sockets (or null if unknown). */
  async removeSocket(userId: string, socketId: string): Promise<number | null> {
    const client = this.client;
    if (!client) return null;
    try {
      const key = RedisKeys.sockets(userId);
      const res = await client
        .multi()
        .zRem(key, socketId)
        .zRemRangeByScore(key, '-inf', Date.now() - RedisTtl.socketStaleMs)
        .zCard(key)
        .exec();
      return Number(res[2] ?? 0);
    } catch (err) {
      this.logger.warn(`removeSocket failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Presence ──────────────────────────────────────────────────────────

  async setOnline(userId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.setEx(RedisKeys.presence(userId), RedisTtl.presenceSeconds, 'online');
    } catch {
      // Presence is refreshed by the next heartbeat
    }
  }

  async setOffline(userId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.del(RedisKeys.presence(userId));
    } catch {
      // Key expires on its own
    }
  }

  async isOnline(userId: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    try {
      return (await client.get(RedisKeys.presence(userId))) === 'online';
    } catch {
      return false;
    }
  }

  async getOnlineUsers(userIds: string[]): Promise<Set<string>> {
    const online = new Set<string>();
    const client = this.client;
    if (!client || userIds.length === 0) return online;
    try {
      const values = await client.mGet(userIds.map((id) => RedisKeys.presence(id)));
      userIds.forEach((id, i) => {
        if (values[i] === 'online') online.add(id);
      });
    } catch {
      // Degraded: report nobody online
    }
    return online;
  }

  // ─── Pending Messages (offline queue) ──────────────────────────────────

  /** Queues one payload for many users in a single round trip. */
  async addPendingMessage(userIds: string[], message: PendingMessage): Promise<void> {
    const client = this.client;
    if (!client || userIds.length === 0) return;
    try {
      const value = JSON.stringify(message);
      const score = Date.parse(message.createdAt) || Date.now();
      const multi = client.multi();
      for (const userId of userIds) {
        const key = RedisKeys.pending(userId);
        multi.zAdd(key, { score, value });
        multi.expire(key, RedisTtl.pendingSeconds);
      }
      await multi.exec();
    } catch (err) {
      this.logger.warn(`addPendingMessage failed: ${(err as Error).message}`);
    }
  }

  /**
   * Returns the oldest `limit` pending messages and removes exactly those
   * entries (by member), so anything queued concurrently is kept.
   */
  async popPendingMessages(
    userId: string,
    limit = 100,
  ): Promise<{ messages: PendingMessage[]; remaining: number }> {
    const client = this.client;
    if (!client) return { messages: [], remaining: 0 };
    try {
      const key = RedisKeys.pending(userId);
      const raw = (await client.zRange(key, 0, limit - 1)).map(String);
      if (raw.length === 0) return { messages: [], remaining: 0 };

      const res = await client.multi().zRem(key, raw).zCard(key).exec();
      const messages: PendingMessage[] = [];
      for (const item of raw) {
        try {
          messages.push(JSON.parse(item) as PendingMessage);
        } catch {
          // Skip corrupt entries
        }
      }
      return { messages, remaining: Number(res[1] ?? 0) };
    } catch (err) {
      this.logger.warn(`popPendingMessages failed: ${(err as Error).message}`);
      return { messages: [], remaining: 0 };
    }
  }
}
