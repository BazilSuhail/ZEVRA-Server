import { Inject, Injectable, ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { channels, memberships, messages, users, messageReads } from '../../database/schema';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { RedisSessionService } from '../../redis/redis-session.service';
import { RedisCacheService } from '../../redis/redis-cache.service';

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private sessionService: RedisSessionService,
    private cacheService: RedisCacheService,
  ) {}

  async create(userId: string, participantIds: string[], type: string, name?: string) {
    if (type === 'DIRECT' && participantIds.length !== 1) {
      throw new ForbiddenException('Direct message requires exactly 1 other participant');
    }

    if (type === 'DIRECT' && participantIds[0] === userId) {
      throw new ForbiddenException('Cannot create DM with yourself');
    }

    // DM: check for existing channel with same participants via memberships
    if (type === 'DIRECT') {
      const targetUserId = participantIds[0];

      // Find channels where both users are members
      const existingChannels = await this.db
        .select({ channelId: memberships.channelId })
        .from(memberships)
        .innerJoin(channels, eq(channels.id, memberships.channelId))
        .where(
          and(
            eq(channels.type, 'DIRECT'),
            sql`${memberships.userId} IN (${userId}, ${targetUserId})`,
          ),
        )
        .groupBy(memberships.channelId)
        .having(sql`COUNT(*) = 2`);

      if (existingChannels.length > 0) {
        const existingChannelId = existingChannels[0].channelId;

        // Ensure memberships exist
        for (const uid of [userId, targetUserId]) {
          const [hasMember] = await this.db
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.userId, uid),
                eq(memberships.channelId, existingChannelId),
              ),
            )
            .limit(1);

          if (!hasMember) {
            await this.db.insert(memberships).values({
              userId: uid,
              channelId: existingChannelId,
              role: uid === userId ? 'ADMIN' : 'MEMBER',
            });
          }
        }

        const [full] = await this.db
          .select({
            id: channels.id,
            type: channels.type,
            name: channels.name,
            createdAt: channels.createdAt,
          })
          .from(channels)
          .where(eq(channels.id, existingChannelId))
          .limit(1);
        return full;
      }
    }

    // Insert channel (no participantIds column)
    const allParticipantIds = [userId, ...participantIds];
    const [channel] = await this.db
      .insert(channels)
      .values({
        type,
        name: name ?? null,
      })
      .returning({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        createdAt: channels.createdAt,
      });

    // Create memberships for all participants
    const members = allParticipantIds.map((uid) => ({
      userId: uid,
      channelId: channel.id,
      role: uid === userId ? 'ADMIN' : 'MEMBER',
    }));

    await this.db.insert(memberships).values(members);

    // Denormalize into Redis
    for (const uid of allParticipantIds) {
      await this.sessionService.addChannelMember(channel.id, uid);
    }

    return channel;
  }

  async getInbox(userId: string) {
    // Get channel IDs where user is a member
    const memberChannels = await this.db
      .select({
        channelId: memberships.channelId,
        lastReadMessageId: memberships.lastReadMessageId,
      })
      .from(memberships)
      .where(eq(memberships.userId, userId));

    if (memberChannels.length === 0) return [];

    const channelIds = memberChannels.map((mc) => mc.channelId);

    // Get channels with last message info
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
        createdAt: channels.createdAt,
      })
      .from(channels)
      .leftJoin(messages, eq(channels.lastMessageId, messages.id))
      .leftJoin(users, eq(messages.senderId, users.id))
      .where(inArray(channels.id, channelIds))
      .orderBy(desc(channels.lastMessageAt));

    // Attach lastReadMessageId from membership data
    const membershipMap = new Map(memberChannels.map((mc) => [mc.channelId, mc.lastReadMessageId]));

    return result.map((channel) => ({
      ...channel,
      lastReadMessageId: membershipMap.get(channel.id) ?? null,
    }));
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

    // 4. Update membership watermark + insert read receipt
    await this.db.transaction(async (tx) => {
      await tx
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

      // Insert read receipt (upsert on unique constraint)
      await tx
        .insert(messageReads)
        .values({
          messageId: lastReadMessageId,
          userId,
        })
        .onConflictDoNothing();
    });

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

    // Update channel timestamp
    await this.db
      .update(channels)
      .set({ updatedAt: new Date() })
      .where(eq(channels.id, channelId));

    // Denormalize into Redis
    await this.sessionService.addChannelMember(channelId, newUserId);

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

    // Update channel timestamp
    await this.db
      .update(channels)
      .set({ updatedAt: new Date() })
      .where(eq(channels.id, channelId));

    // Remove from Redis
    await this.sessionService.removeChannelMember(channelId, targetUserId);

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

  // ─── Typing Users ──────────────────────────────────────────────────────

  async getTypingUsers(channelId: string, userId: string) {
    // Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id })
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

    const typingUserIds = await this.cacheService.getTypingUsers(channelId);
    // Exclude the requesting user
    return typingUserIds.filter((id) => id !== userId);
  }

  // ─── Read Receipts ────────────────────────────────────────────────────

  async getReadReceipts(channelId: string, userId: string) {
    // Verify membership
    const [membership] = await this.db
      .select({ id: memberships.id })
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

    return this.cacheService.getReadReceipts(channelId);
  }
}
