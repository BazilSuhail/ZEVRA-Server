import { Inject, Injectable, ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { channels, memberships, users } from '../database/schema';
import { eq, and, sql, desc } from 'drizzle-orm';

@Injectable()
export class ChannelsService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async create(userId: string, participantIds: string[], type: string, name?: string) {
    // DM: require exactly 1 other participant
    if (type === 'DIRECT' && participantIds.length !== 1) {
      throw new ForbiddenException('Direct message requires exactly 1 other participant');
    }

    // Prevent self-DM
    if (type === 'DIRECT' && participantIds[0] === userId) {
      throw new ForbiddenException('Cannot create DM with yourself');
    }

    // Check for existing DM with same participants
    if (type === 'DIRECT') {
      const allIds = [userId, ...participantIds].sort();
      const [existing] = await this.db
        .select({ id: channels.id, participantIds: channels.participantIds })
        .from(channels)
        .where(
          and(
            eq(channels.type, 'DIRECT'),
            sql`${channels.participantIds} @> ARRAY[${allIds[0]}, ${allIds[1]}]::text[]`,
          ),
        )
        .limit(1);

      if (existing) {
        return { channelId: existing.id, existing: true };
      }
    }

    // Insert channel
    const allParticipantIds = [userId, ...participantIds];
    const [channel] = await this.db
      .insert(channels)
      .values({
        type,
        name: name ?? null,
        participantIds: allParticipantIds,
      })
      .returning({ id: channels.id, createdAt: channels.createdAt });

    // Create memberships for all participants
    const members = allParticipantIds.map((uid) => ({
      userId: uid,
      channelId: channel.id,
      role: uid === userId ? 'ADMIN' : 'MEMBER',
    }));

    await this.db.insert(memberships).values(members);

    return { channelId: channel.id, existing: false };
  }

  async getInbox(userId: string) {
    const result = await this.db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        lastMessageId: channels.lastMessageId,
        lastMessageAt: channels.lastMessageAt,
        participantIds: channels.participantIds,
        createdAt: channels.createdAt,
        lastReadAt: memberships.lastReadAt,
      })
      .from(channels)
      .innerJoin(
        memberships,
        and(
          eq(memberships.channelId, channels.id),
          eq(memberships.userId, userId),
        ),
      )
      .orderBy(desc(channels.lastMessageAt));

    // Get unread counts in batch
    const channelIds = result.map((c) => c.id);
    const unreadCounts = await this.getUnreadBatch(userId, channelIds);

    return result.map((c) => ({
      ...c,
      unreadCount: unreadCounts[c.id] ?? 0,
    }));
  }

  private async getUnreadBatch(userId: string, channelIds: string[]) {
    if (channelIds.length === 0) return {};

    // Fetch all memberships with lastReadAt for these channels
    const memberRows = await this.db
      .select({
        channelId: memberships.channelId,
        lastReadAt: memberships.lastReadAt,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          sql`${memberships.channelId} = ANY(${channelIds})`,
        ),
      );

    const counts: Record<string, number> = {};

    for (const row of memberRows) {
      const [unseen] = await this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(channels)
        .where(
          and(
            eq(channels.id, row.channelId),
            row.lastReadAt
              ? sql`${channels.lastMessageAt} > ${row.lastReadAt}`
              : sql`true`,
          ),
        );

      counts[row.channelId] = unseen.total;
    }

    return counts;
  }

  async getChannel(channelId: string, userId: string) {
    // Verify membership
    const [membership] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.channelId, channelId),
        ),
      );

    if (!membership) {
      throw new ForbiddenException('Not a member of this channel');
    }

    // Get channel
    const [channel] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId));

    if (!channel) throw new NotFoundException('Channel not found');

    // Get members
    const members = await this.db
      .select({
        id: users.id,
        username: users.username,
        status: users.status,
        role: memberships.role,
        joinedAt: memberships.joinedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.channelId, channelId));

    return {
      ...channel,
      role: membership.role,
      members,
    };
  }

  async addMember(channelId: string, requesterId: string, newUserId: string, role?: string) {
    // Verify requester is admin
    const [requester] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, requesterId),
          eq(memberships.channelId, channelId),
        ),
      );

    if (!requester || requester.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can add members');
    }

    // Check if already a member
    const [existing] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, newUserId),
          eq(memberships.channelId, channelId),
        ),
      );

    if (existing) {
      throw new ConflictException('User is already a member');
    }

    // Add membership
    const [newMember] = await this.db
      .insert(memberships)
      .values({
        userId: newUserId,
        channelId,
        role: role ?? 'MEMBER',
      })
      .returning({ id: memberships.id });

    // Update channel participantIds
    const [channel] = await this.db
      .select({ participantIds: channels.participantIds })
      .from(channels)
      .where(eq(channels.id, channelId));

    if (channel) {
      await this.db
        .update(channels)
        .set({
          participantIds: [...channel.participantIds, newUserId],
          updatedAt: new Date(),
        })
        .where(eq(channels.id, channelId));
    }

    // Return new member info
    const [user] = await this.db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, newUserId));

    return { membershipId: newMember.id, user };
  }

  async removeMember(channelId: string, requesterId: string, targetUserId: string) {
    // Verify requester is admin (or removing self)
    if (requesterId !== targetUserId) {
      const [requester] = await this.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, requesterId),
            eq(memberships.channelId, channelId),
          ),
        );

      if (!requester || requester.role !== 'ADMIN') {
        throw new ForbiddenException('Only admins can remove members');
      }
    }

    // Remove membership
    const [removed] = await this.db
      .delete(memberships)
      .where(
        and(
          eq(memberships.userId, targetUserId),
          eq(memberships.channelId, channelId),
        ),
      )
      .returning({ id: memberships.id });

    if (!removed) {
      throw new NotFoundException('Member not found in channel');
    }

    // Update channel participantIds
    const [channel] = await this.db
      .select({ participantIds: channels.participantIds })
      .from(channels)
      .where(eq(channels.id, channelId));

    if (channel) {
      await this.db
        .update(channels)
        .set({
          participantIds: channel.participantIds.filter((id) => id !== targetUserId),
          updatedAt: new Date(),
        })
        .where(eq(channels.id, channelId));
    }

    return { success: true };
  }

  async archive(channelId: string, userId: string) {
    const [membership] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.channelId, channelId),
        ),
      );

    if (!membership || membership.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can archive channels');
    }

    await this.db
      .update(channels)
      .set({ isArchived: true, updatedAt: new Date() })
      .where(eq(channels.id, channelId));

    return { success: true };
  }
}
