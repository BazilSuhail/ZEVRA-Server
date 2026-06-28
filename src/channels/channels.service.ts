import { Inject, Injectable, ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { channels, memberships, messages, users } from '../database/schema';
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
        // Ensure memberships exist for this DM
        const allIds = [userId, ...participantIds];
        for (const uid of allIds) {
          const [hasMember] = await this.db
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.userId, uid),
                eq(memberships.channelId, existing.id),
              ),
            )
            .limit(1);

          if (!hasMember) {
            await this.db.insert(memberships).values({
              userId: uid,
              channelId: existing.id,
              role: uid === userId ? 'ADMIN' : 'MEMBER',
            });
          }
        }

        const [full] = await this.db
          .select({
            id: channels.id,
            type: channels.type,
            name: channels.name,
            participantIds: channels.participantIds,
            createdAt: channels.createdAt,
          })
          .from(channels)
          .where(eq(channels.id, existing.id))
          .limit(1);
        return full;
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
      .returning({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        participantIds: channels.participantIds,
        createdAt: channels.createdAt,
      });

    // Create memberships for all participants
    const members = allParticipantIds.map((uid) => ({
      userId: uid,
      channelId: channel.id,
      role: uid === userId ? 'ADMIN' : 'MEMBER',
    }));

    await this.db.insert(memberships).values(members);

    return channel;
  }

  async getInbox(userId: string) {
    const result = await this.db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        isArchived: channels.isArchived,
        lastMessageId: channels.lastMessageId,
        lastMessageAt: channels.lastMessageAt,
        lastMessageContent: messages.encryptedContent,
        lastMessageSenderId: messages.senderId,
        lastMessageSenderName: users.username,
        lastMessageIv: messages.contentIv,
        lastMessageTag: messages.contentTag,
        lastMessageSenderKeyEpoch: messages.senderKeyEpoch,
        participantIds: channels.participantIds,
        createdAt: channels.createdAt,
        lastReadMessageId: memberships.lastReadMessageId,
      })
      .from(channels)
      .innerJoin(
        memberships,
        and(
          eq(memberships.channelId, channels.id),
          eq(memberships.userId, userId),
        ),
      )
      .leftJoin(messages, eq(channels.lastMessageId, messages.id))
      .leftJoin(users, eq(messages.senderId, users.id))
      .orderBy(desc(channels.lastMessageAt));

    return result;
  }

  async markRead(userId: string, channelId: string, lastReadMessageId: string) {
    // 1. Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id, lastReadMessageId: memberships.lastReadMessageId })
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

    // 2. Verify the message belongs to this channel
    const [msg] = await this.db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.id, lastReadMessageId),
          eq(messages.channelId, channelId),
        ),
      );

    if (!msg) {
      throw new NotFoundException('Message not found in this channel');
    }

    // 3. Only advance forward — never regress the read marker
    if (membership.lastReadMessageId) {
      const [current] = await this.db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, membership.lastReadMessageId));

      if (current && current.createdAt >= msg.createdAt) {
        return { success: true, advanced: false };
      }
    }

    await this.db
      .update(memberships)
      .set({
        lastReadMessageId,
        lastReadAt: new Date(),
      })
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.channelId, channelId),
        ),
      );

    return { success: true, advanced: true };
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

    // Get current state to toggle
    const [channel] = await this.db
      .select({ isArchived: channels.isArchived })
      .from(channels)
      .where(eq(channels.id, channelId));

    if (!channel) throw new NotFoundException('Channel not found');

    const newArchivedState = !channel.isArchived;

    await this.db
      .update(channels)
      .set({ isArchived: newArchivedState, updatedAt: new Date() })
      .where(eq(channels.id, channelId));

    return { isArchived: newArchivedState };
  }
}
