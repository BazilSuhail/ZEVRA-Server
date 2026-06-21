import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { REDIS } from '../redis/redis.module';
import Redis from 'ioredis';

@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly PREFIX = 'presence:';
  private readonly TTL_SECONDS = 300;

  constructor(
    @Inject(REDIS) private redis: Redis,
  ) {}

  async online(userId: string) {
    await this.redis.set(
      `${this.PREFIX}${userId}`,
      'online',
      'EX',
      this.TTL_SECONDS,
    );
  }

  async heartbeat(userId: string) {
    await this.redis.expire(`${this.PREFIX}${userId}`, this.TTL_SECONDS);
  }

  async offline(userId: string) {
    await this.redis.del(`${this.PREFIX}${userId}`);
  }

  async isOnline(userId: string): Promise<boolean> {
    const val = await this.redis.exists(`${this.PREFIX}${userId}`);
    return val === 1;
  }

  async getStatus(userIds: string[]): Promise<Record<string, string>> {
    if (userIds.length === 0) return {};

    const pipeline = this.redis.pipeline();
    for (const id of userIds) {
      pipeline.exists(`${this.PREFIX}${id}`);
    }
    const results = await pipeline.exec();

    const status: Record<string, string> = {};
    for (let i = 0; i < userIds.length; i++) {
      status[userIds[i]] = results?.[i]?.[1] === 1 ? 'ONLINE' : 'OFFLINE';
    }
    return status;
  }

  onModuleDestroy() {
    // Cleanup handled by Redis TTL
  }
}
