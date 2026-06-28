import { Inject, Injectable } from '@nestjs/common';
import { REDIS } from '../redis/redis.module';

@Injectable()
export class PresenceService {
  private readonly PREFIX = 'presence:';
  private readonly TTL_SECONDS = 300;

  constructor(@Inject(REDIS) private redis: any) {}

  async online(userId: string) {
    if (!this.redis) return;
    try {
      await this.redis.setEx(`${this.PREFIX}${userId}`, this.TTL_SECONDS, 'online');
    } catch {}
  }

  async offline(userId: string) {
    if (!this.redis) return;
    try {
      await this.redis.del(`${this.PREFIX}${userId}`);
    } catch {}
  }

}
