import { Injectable, Inject, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { reactions, memberships } from '../../database/schema';
import { eq, and } from 'drizzle-orm';

@Injectable()
export class ReactionsService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async addReaction(userId: string, channelId: string, messageId: string, emoji: string) {
    // Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId)));

    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    // Upsert reaction (ignore if already exists)
    const [existing] = await this.db
      .select({ id: reactions.id })
      .from(reactions)
      .where(
        and(
          eq(reactions.messageId, messageId),
          eq(reactions.userId, userId),
          eq(reactions.emoji, emoji),
        ),
      );

    if (existing) {
      return { success: true, action: 'already_exists' };
    }

    await this.db.insert(reactions).values({ messageId, userId, emoji });

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
    // Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId)));

    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    const rows = await this.db
      .select({
        id: reactions.id,
        emoji: reactions.emoji,
        userId: reactions.userId,
        messageId: reactions.messageId,
        createdAt: reactions.createdAt,
      })
      .from(reactions)
      .where(eq(reactions.messageId, messageId));

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
