import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS } from '../redis/redis.module';

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly PREFIX = 'presence:';
  private readonly TTL_SECONDS = 300;

  constructor(@Inject(REDIS) private redis: any) {}

  async online(userId: string) {
    if (!this.redis) return;
    try {
      await this.redis.setEx(`${this.PREFIX}${userId}`, this.TTL_SECONDS, 'online');
    } catch {}
  }

  async heartbeat(userId: string) {
    if (!this.redis) return;
    try {
      await this.redis.expire(`${this.PREFIX}${userId}`, this.TTL_SECONDS);
    } catch {}
  }

  async offline(userId: string) {
    if (!this.redis) return;
    try {
      await this.redis.del(`${this.PREFIX}${userId}`);
    } catch {}
  }

  async isOnline(userId: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const val = await this.redis.exists(`${this.PREFIX}${userId}`);
      return val === 1;
    } catch {
      return false;
    }
  }

  async getStatus(userIds: string[]): Promise<Record<string, string>> {
    if (!this.redis || userIds.length === 0) return {};

    try {
      const status: Record<string, string> = {};
      for (const id of userIds) {
        const exists = await this.redis.exists(`${this.PREFIX}${id}`);
        status[id] = exists === 1 ? 'ONLINE' : 'OFFLINE';
      }
      return status;
    } catch {
      return {};
    }
  }
}
