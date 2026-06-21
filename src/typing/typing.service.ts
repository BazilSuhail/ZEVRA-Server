import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { REDIS } from '../redis/redis.module';
import Redis from 'ioredis';

@Injectable()
export class TypingService implements OnModuleDestroy {
  private readonly logger = new Logger(TypingService.name);
  private readonly PREFIX = 'typing:';
  private readonly TTL_SECONDS = 5;
  private subscriber: Redis;
  private channels = new Map<string, Set<(data: any) => void>>();

  constructor(@Inject(REDIS) private redis: Redis) {
    this.subscriber = this.redis.duplicate();
  }

  async startTyping(userId: string, channelId: string, username: string) {
    await this.redis.set(
      `${this.PREFIX}${channelId}:${userId}`,
      username,
      'EX',
      this.TTL_SECONDS,
    );
  }

  async stopTyping(userId: string, channelId: string) {
    await this.redis.del(`${this.PREFIX}${channelId}:${userId}`);
  }

  async getTypingUsers(channelId: string): Promise<{ userId: string; username: string }[]> {
    const pattern = `${this.PREFIX}${channelId}:*`;
    const keys: string[] = [];

    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.get(key);
    }
    const results = await pipeline.exec();

    return keys.map((key, i) => {
      const userId = key.split(':').pop()!;
      return {
        userId,
        username: (results?.[i]?.[1] as string) ?? 'unknown',
      };
    });
  }

  onModuleDestroy() {
    this.subscriber.disconnect();
  }
}
