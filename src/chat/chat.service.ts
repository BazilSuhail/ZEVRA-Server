import { Injectable, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, inArray, ne } from 'drizzle-orm';
import { DB } from '../database/database.module';
import { memberships, channels } from '../database/schema';
import { RedisCacheService } from '../redis/redis-cache.service';
import { RedisSessionService, PendingMessage } from '../redis/redis-session.service';

export const PENDING_BATCH_SIZE = 100;

/** Membership / unread / offline-queue lookups used by the socket gateways. */
@Injectable()
export class ChatService {
  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private cacheService: RedisCacheService,
    private sessionService: RedisSessionService,
  ) {}

  async getUserChannelIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ channelId: memberships.channelId })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    return rows.map((r) => r.channelId);
  }

  async getUserDMPeers(userId: string): Promise<string[]> {
    const mine = this.db
      .select({ channelId: memberships.channelId })
      .from(memberships)
      .innerJoin(channels, eq(channels.id, memberships.channelId))
      .where(and(eq(memberships.userId, userId), eq(channels.type, 'DIRECT')));

    const peers = await this.db
      .selectDistinct({ userId: memberships.userId })
      .from(memberships)
      .where(and(inArray(memberships.channelId, mine), ne(memberships.userId, userId)));
    return peers.map((p) => p.userId);
  }

  async getUnreadCounts(userId: string): Promise<Record<string, number>> {
    const channelIds = await this.getUserChannelIds(userId);
    return this.cacheService.getUnreadCounts(userId, channelIds);
  }

  /**
   * Pops (exactly) the oldest batch of offline messages. Called when the
   * client asks via `get-pending`, i.e. once its listeners are attached.
   */
  async deliverPendingMessages(
    userId: string,
  ): Promise<{ messages: PendingMessage[]; remaining: number }> {
    return this.sessionService.popPendingMessages(userId, PENDING_BATCH_SIZE);
  }
}
