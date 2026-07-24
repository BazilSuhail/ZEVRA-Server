import { Inject, Injectable, Logger } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { DB } from '../database/database.module';
import { memberships } from '../database/schema';
import { RedisService } from './redis.service';
import { RedisKeys, RedisTtl } from './redis-keys';

/**
 * Channel membership lookups backed by Postgres with a Redis set cache
 * (`zevra:channel:members:{channelId}`, TTL 1h). The set is only ever
 * written as a complete snapshot, so a present key is authoritative; on any
 * membership change the key is dropped and rebuilt on the next read.
 */
@Injectable()
export class ChannelMembersService {
  private readonly logger = new Logger(ChannelMembersService.name);

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    private readonly redis: RedisService,
  ) {}

  async getMembers(channelId: string): Promise<string[]> {
    const client = this.redis.getClient();
    if (client) {
      try {
        const key = RedisKeys.channelMembers(channelId);
        const members = (await client.sMembers(key)).map(String);
        if (members.length > 0) return members;
      } catch (err) {
        this.logger.warn(`getMembers cache read failed: ${(err as Error).message}`);
      }
    }
    const rows = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.channelId, channelId));
    const members = rows.map((r) => r.userId);
    await this.setMembers(channelId, members);
    return members;
  }

  async isMember(channelId: string, userId: string): Promise<boolean> {
    const client = this.redis.getClient();
    if (client) {
      try {
        const key = RedisKeys.channelMembers(channelId);
        const [exists, isMember] = await client.multi().exists(key).sIsMember(key, userId).exec();
        if (Number(exists) === 1) return Number(isMember) === 1;
      } catch (err) {
        this.logger.warn(`isMember cache read failed: ${(err as Error).message}`);
      }
      const members = await this.getMembers(channelId);
      return members.includes(userId);
    }
    const [row] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.channelId, channelId), eq(memberships.userId, userId)))
      .limit(1);
    return !!row;
  }

  /** Writes a full membership snapshot atomically. */
  async setMembers(channelId: string, userIds: string[]): Promise<void> {
    const client = this.redis.getClient();
    if (!client || userIds.length === 0) return;
    try {
      const key = RedisKeys.channelMembers(channelId);
      await client
        .multi()
        .del(key)
        .sAdd(key, userIds)
        .expire(key, RedisTtl.channelMembersSeconds)
        .exec();
    } catch (err) {
      this.logger.warn(`setMembers failed: ${(err as Error).message}`);
    }
  }

  async invalidate(channelId: string): Promise<void> {
    const client = this.redis.getClient();
    if (!client) return;
    try {
      await client.del(RedisKeys.channelMembers(channelId));
    } catch (err) {
      this.logger.warn(`invalidate members failed: ${(err as Error).message}`);
    }
  }
}
