import {
  Injectable,
  Inject,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, ne, sql } from 'drizzle-orm';
import { DB } from '../../database/database.module';
import { reactions, memberships, messages } from '../../database/schema';
import { SocketService } from '../../socket/socket.service';

export interface ReactionActor {
  id: string;
  username: string;
}

export interface AddReactionResult {
  success: true;
  action: 'added' | 'already_exists';
  replaced: string[];
}

export interface RemoveReactionResult {
  success: true;
  action: 'removed' | 'not_found';
}

@Injectable()
export class ReactionsService {
  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private socket: SocketService,
  ) {}

  /**
   * Message must exist in the claimed channel and the user must be a
   * member. Cross-channel ids are reported as not found.
   */
  private async loadTarget(userId: string, channelId: string, messageId: string) {
    const [row] = await this.db
      .select({
        channelId: messages.channelId,
        isDeleted: messages.isDeleted,
        membershipId: memberships.id,
      })
      .from(messages)
      .leftJoin(
        memberships,
        and(eq(memberships.channelId, messages.channelId), eq(memberships.userId, userId)),
      )
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!row || row.channelId !== channelId) {
      throw new NotFoundException('Message not found');
    }
    if (!row.membershipId) {
      throw new ForbiddenException('Not a member of this channel');
    }
    return row;
  }

  /**
   * One reaction per user per message: a new emoji atomically replaces the
   * user's previous one. Broadcasts `reaction:removed` for each replaced emoji,
   * then `reaction:added`, to the channel room excluding the actor.
   */
  async addReaction(
    actor: ReactionActor,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<AddReactionResult> {
    const target = await this.loadTarget(actor.id, channelId, messageId);
    if (target.isDeleted) {
      throw new BadRequestException('Message has been deleted');
    }

    const result = await this.db.transaction(async (tx) => {
      // Serialise rapid toggles by the same user on the same message
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${messageId}), hashtext(${actor.id}))`,
      );

      const removed = await tx
        .delete(reactions)
        .where(
          and(
            eq(reactions.messageId, messageId),
            eq(reactions.userId, actor.id),
            ne(reactions.emoji, emoji),
          ),
        )
        .returning({ emoji: reactions.emoji });

      const inserted = await tx
        .insert(reactions)
        .values({ messageId, userId: actor.id, emoji })
        .onConflictDoNothing({ target: [reactions.messageId, reactions.userId, reactions.emoji] })
        .returning({ id: reactions.id });

      return {
        success: true as const,
        action: inserted.length > 0 ? ('added' as const) : ('already_exists' as const),
        replaced: removed.map((r) => r.emoji),
      };
    });

    for (const replacedEmoji of result.replaced) {
      this.broadcast('reaction:removed', actor, channelId, messageId, replacedEmoji);
    }
    if (result.action === 'added') {
      this.broadcast('reaction:added', actor, channelId, messageId, emoji);
    }
    return result;
  }

  async removeReaction(
    actor: ReactionActor,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<RemoveReactionResult> {
    await this.loadTarget(actor.id, channelId, messageId);

    const [deleted] = await this.db
      .delete(reactions)
      .where(
        and(
          eq(reactions.messageId, messageId),
          eq(reactions.userId, actor.id),
          eq(reactions.emoji, emoji),
        ),
      )
      .returning({ id: reactions.id });

    if (deleted) {
      this.broadcast('reaction:removed', actor, channelId, messageId, emoji);
    }
    return { success: true, action: deleted ? 'removed' : 'not_found' };
  }

  async getReactions(messageId: string, userId: string, channelId: string) {
    await this.loadTarget(userId, channelId, messageId);

    const rows = await this.db
      .select({ emoji: reactions.emoji, userId: reactions.userId })
      .from(reactions)
      .where(eq(reactions.messageId, messageId));

    const grouped: Record<string, { emoji: string; userIds: string[]; count: number }> = {};
    for (const row of rows) {
      const entry = (grouped[row.emoji] ??= { emoji: row.emoji, userIds: [], count: 0 });
      entry.userIds.push(row.userId);
      entry.count++;
    }
    return Object.values(grouped);
  }

  private broadcast(
    event: 'reaction:added' | 'reaction:removed',
    actor: ReactionActor,
    channelId: string,
    messageId: string,
    emoji: string,
  ) {
    this.socket.emitToChannel(
      channelId,
      event,
      { userId: actor.id, username: actor.username, messageId, emoji, channelId },
      { exceptUserId: actor.id },
    );
  }
}
