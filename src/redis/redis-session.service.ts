import { Injectable, Logger } from '@nestjs/common';
import { RedisClientType } from 'redis';

export interface PendingMessage {
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

@Injectable()
export class RedisSessionService {
  private readonly logger = new Logger(RedisSessionService.name);
  private client: RedisClientType | null = null;

  setClient(client: RedisClientType | null) {
    this.client = client;
  }

  // ─── User Session (1:1 mapping) ────────────────────────────────────────

  async registerSession(userId: string, socketId: string): Promise<void> {
    if (!this.client) return;
    try {
      const pipeline = this.client.multi();
      pipeline.setEx(`session:${userId}`, 600, socketId);
      pipeline.setEx(`socket:${socketId}`, 600, userId);
      await pipeline.exec();
    } catch (err) {
      this.logger.warn(`registerSession failed: ${(err as Error).message}`);
    }
  }

  async getSession(userId: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(`session:${userId}`);
    } catch {
      return null;
    }
  }

  async getUserIdBySocket(socketId: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(`socket:${socketId}`);
    } catch {
      return null;
    }
  }

  async removeSession(userId: string, socketId: string): Promise<void> {
    if (!this.client) return;
    try {
      const pipeline = this.client.multi();
      pipeline.del(`session:${userId}`);
      pipeline.del(`socket:${socketId}`);
      await pipeline.exec();
    } catch {}
  }

  async renewSession(userId: string, socketId: string): Promise<void> {
    if (!this.client) return;
    try {
      const pipeline = this.client.multi();
      pipeline.expire(`session:${userId}`, 600);
      pipeline.expire(`socket:${socketId}`, 600);
      await pipeline.exec();
    } catch {}
  }

  // ─── Presence ──────────────────────────────────────────────────────────

  async setOnline(userId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setEx(`presence:${userId}`, 90, 'online');
    } catch {}
  }

  async setOffline(userId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(`presence:${userId}`);
    } catch {}
  }

  async isOnline(userId: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const val = await this.client.get(`presence:${userId}`);
      return val === 'online';
    } catch {
      return false;
    }
  }

  async getOnlineUsers(userIds: string[]): Promise<Set<string>> {
    if (!this.client || userIds.length === 0) return new Set();
    try {
      const keys = userIds.map((id) => `presence:${id}`);
      const values = await this.client.mGet(keys);
      const online = new Set<string>();
      for (let i = 0; i < userIds.length; i++) {
        if (values[i] === 'online') online.add(userIds[i]);
      }
      return online;
    } catch {
      return new Set();
    }
  }

  // ─── Channel Members (Redis denormalization) ───────────────────────────

  async addChannelMember(channelId: string, userId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sAdd(`channel:members:${channelId}`, userId);
    } catch {}
  }

  async removeChannelMember(channelId: string, userId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sRem(`channel:members:${channelId}`, userId);
    } catch {}
  }

  async getChannelMembers(channelId: string): Promise<string[]> {
    if (!this.client) return [];
    try {
      return await this.client.sMembers(`channel:members:${channelId}`);
    } catch {
      return [];
    }
  }

  async isChannelMember(channelId: string, userId: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      return !!(await this.client.sIsMember(`channel:members:${channelId}`, userId));
    } catch {
      return false;
    }
  }

  // ─── Pending Messages (offline queue) ──────────────────────────────────

  async addPendingMessage(userId: string, message: PendingMessage): Promise<void> {
    if (!this.client) return;
    try {
      const key = `pending:${userId}`;
      const score = message.sequenceNumber;
      await this.client.zAdd(key, { score, value: JSON.stringify(message) });
      await this.client.expire(key, 604800);
    } catch (err) {
      this.logger.warn(`addPendingMessage failed: ${(err as Error).message}`);
    }
  }

  async getPendingMessages(userId: string): Promise<PendingMessage[]> {
    if (!this.client) return [];
    try {
      const key = `pending:${userId}`;
      const items = await this.client.zRangeWithScores(key, 0, -1);
      return items.map((item) => JSON.parse(item.value));
    } catch {
      return [];
    }
  }

  async clearPendingMessages(userId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(`pending:${userId}`);
    } catch {}
  }

  async getPendingCount(userId: string): Promise<number> {
    if (!this.client) return 0;
    try {
      return await this.client.zCard(`pending:${userId}`);
    } catch {
      return 0;
    }
  }
}
