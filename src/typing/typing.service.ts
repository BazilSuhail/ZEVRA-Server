import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS } from '../redis/redis.module';

@Injectable()
export class TypingService {
  private readonly logger = new Logger(TypingService.name);
  private readonly PREFIX = 'typing:';
  private readonly TTL_SECONDS = 5;

  constructor(@Inject(REDIS) private redis: any) {}

  async startTyping(userId: string, channelId: string, username: string) {
    if (!this.redis) return;
    try {
      await this.redis.setEx(
        `${this.PREFIX}${channelId}:${userId}`,
        this.TTL_SECONDS,
        username,
      );
    } catch {}
  }

  async stopTyping(userId: string, channelId: string) {
    if (!this.redis) return;
    try {
      await this.redis.del(`${this.PREFIX}${channelId}:${userId}`);
    } catch {}
  }

  async getTypingUsers(channelId: string): Promise<{ userId: string; username: string }[]> {
    if (!this.redis) return [];

    try {
      const pattern = `${this.PREFIX}${channelId}:*`;
      const keys: string[] = [];

      let cursor = '0';
      do {
        const result = await this.redis.scan(Number(cursor), {
          MATCH: pattern,
          COUNT: 100,
        });
        cursor = String(result.cursor);
        keys.push(...result.keys);
      } while (cursor !== '0');

      const results: { userId: string; username: string }[] = [];
      for (const key of keys) {
        const username = await this.redis.get(key);
        const userId = key.split(':').pop()!;
        results.push({ userId, username: username ?? 'unknown' });
      }

      return results;
    } catch {
      return [];
    }
  }
}
