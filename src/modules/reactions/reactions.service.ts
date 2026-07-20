import { Injectable, Inject, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { reactions, memberships, messages } from '../../database/schema';
import { eq, and, ne, sql } from 'drizzle-orm';

@Injectable()
export class ReactionsService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  /**
   * Ensure the message exists and actually belongs to the claimed channel,
   * preventing cross-channel reaction injection.
   */
  private async assertMessageInChannel(messageId: string, channelId: string) {
    const [msg] = await this.db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!msg) {
      throw new NotFoundException('Message not found');
    }
    if (msg.channelId !== channelId) {
      throw new ForbiddenException('Message does not belong to this channel');
    }
    return msg;
  }

  /**
   * One reaction per user per message: adding a new emoji atomically
   * replaces whatever that user already had on this message. Returns the
   * emojis that were displaced so the gateway can broadcast removals.
   */
  async addReaction(userId: string, channelId: string, messageId: string, emoji: string) {
    await this.assertMessageInChannel(messageId, channelId);

    // Membership check
    const [membership] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId)));
    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    return this.db.transaction(async (tx) => {
      // Serialize concurrent reactions from the same user on the same
      // message — rapid toggling would otherwise race delete/insert pairs
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${messageId}), hashtext(${userId}))`,
      );

      // Displace this user's previous reaction(s) on the message (if any)
      const removed = await tx
        .delete(reactions)
        .where(
          and(
            eq(reactions.messageId, messageId),
            eq(reactions.userId, userId),
            ne(reactions.emoji, emoji),
          ),
        )
        .returning({ emoji: reactions.emoji });

      // Insert the new one (no-op if they're re-clicking the same emoji)
      const inserted = await tx
        .insert(reactions)
        .values({ messageId, userId, emoji })
        .onConflictDoNothing({
          target: [reactions.messageId, reactions.userId, reactions.emoji],
        })
        .returning({ id: reactions.id });

      if (inserted.length === 0) {
        // Same emoji already active — no new reaction, but still report any
        // legacy extra reactions that were displaced so they get broadcast
        return {
          success: true,
          action: 'already_exists',
          replaced: removed.map((r) => r.emoji),
        };
      }

      return {
        success: true,
        action: 'added',
        replaced: removed.map((r) => r.emoji),
      };
    });
  }

  async removeReaction(userId: string, channelId: string, messageId: string, emoji: string) {
    await this.assertMessageInChannel(messageId, channelId);

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
    await this.assertMessageInChannel(messageId, channelId);

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
