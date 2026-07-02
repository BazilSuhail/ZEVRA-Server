import { Injectable, Inject, ForbiddenException } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { reactions, memberships } from '../../database/schema';
import { eq, and, sql } from 'drizzle-orm';

@Injectable()
export class ReactionsService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async addReaction(userId: string, channelId: string, messageId: string, emoji: string) {
    // Verify membership + insert in one query
    const result = await this.db.execute(sql`
      WITH member_check AS (
        SELECT 1 FROM memberships
        WHERE user_id = ${userId} AND channel_id = ${channelId}
      )
      INSERT INTO reactions (message_id, user_id, emoji)
      SELECT ${messageId}, ${userId}, ${emoji}
      FROM member_check
      ON CONFLICT (message_id, user_id, emoji) DO NOTHING
      RETURNING id
    `);

    if (result.rowCount === 0) {
      // Either not a member or reaction already exists
      const [membership] = await this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId)));

      if (!membership) {
        throw new ForbiddenException('Not a member of this channel');
      }
      return { success: true, action: 'already_exists' };
    }

    return { success: true, action: 'added' };
  }

  async removeReaction(userId: string, channelId: string, messageId: string, emoji: string) {
    // Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId)));

    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    const [deleted] = await this.db
      .delete(reactions)
      .where(
        and(
          eq(reactions.messageId, messageId),
          eq(reactions.userId, userId),
          eq(reactions.emoji, emoji),
        ),
      )
      .returning({ id: reactions.id });

    return { success: true, action: deleted ? 'removed' : 'not_found' };
  }

  async getReactions(messageId: string, userId: string, channelId: string) {
    // Verify membership + get reactions in parallel
    const [membership, rows] = await Promise.all([
      this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId))),
      this.db
        .select({
          emoji: reactions.emoji,
          userId: reactions.userId,
        })
        .from(reactions)
        .where(eq(reactions.messageId, messageId)),
    ]);

    if (membership.length === 0) {
      throw new ForbiddenException('Not a member of this channel');
    }

    // Group by emoji
    const grouped: Record<string, { emoji: string; userIds: string[]; count: number }> = {};
    for (const row of rows) {
      if (!grouped[row.emoji]) {
        grouped[row.emoji] = { emoji: row.emoji, userIds: [], count: 0 };
      }
      grouped[row.emoji].userIds.push(row.userId);
      grouped[row.emoji].count++;
    }

    return Object.values(grouped);
  }
}
