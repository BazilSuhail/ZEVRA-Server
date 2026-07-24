import {
  Inject,
  Injectable,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { eq, and, sql, desc, asc, inArray, ne } from 'drizzle-orm';
import { DB } from '../../database/database.module';
import { channels, memberships, messages, users, messageReads } from '../../database/schema';
import { ChannelMembersService } from '../../redis/channel-members.service';
import { RedisCacheService } from '../../redis/redis-cache.service';
import { SocketService } from '../../socket/socket.service';
import { MAX_CHANNEL_PARTICIPANTS } from './dto/create-channel.dto';

export interface ChannelSummary {
  id: string;
  type: string;
  name: string | null;
  createdAt: Date;
}

export interface CreateChannelResult {
  channel: ChannelSummary;
  created: boolean;
}

const channelSummaryColumns = {
  id: channels.id,
  type: channels.type,
  name: channels.name,
  createdAt: channels.createdAt,
};

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private members: ChannelMembersService,
    private cacheService: RedisCacheService,
    private socket: SocketService,
  ) {}

  private async getRole(channelId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId)))
      .limit(1);
    return row?.role ?? null;
  }

  private async assertMember(channelId: string, userId: string) {
    const role = await this.getRole(channelId, userId);
    if (!role) throw new ForbiddenException('Not a member of this channel');
    return role;
  }

  // ─── Create (REST POST /channels and socket create-or-join) ───────────

  async create(
    userId: string,
    participantIds: string[],
    type: string,
    name?: string,
  ): Promise<CreateChannelResult> {
    const unique = [...new Set(participantIds ?? [])];

    if (type === 'DIRECT') {
      if (unique.length !== 1) {
        throw new BadRequestException('Direct message requires exactly 1 other participant');
      }
      if (unique[0] === userId) {
        throw new BadRequestException('Cannot create DM with yourself');
      }
    } else if (type === 'GROUP') {
      if (unique.length > MAX_CHANNEL_PARTICIPANTS) {
        throw new BadRequestException(`A channel can have at most ${MAX_CHANNEL_PARTICIPANTS} participants`);
      }
    } else {
      throw new BadRequestException('Invalid channel type');
    }

    const others = unique.filter((id) => id !== userId);
    if (others.length === 0) {
      throw new BadRequestException('At least one other participant is required');
    }

    const found = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, others), eq(users.isActive, true)));
    if (found.length !== others.length) {
      throw new NotFoundException('One or more participants do not exist');
    }

    const result =
      type === 'DIRECT'
        ? await this.createDirect(userId, others[0])
        : await this.insertChannel(userId, others, 'GROUP', name || null);

    const memberIds = [userId, ...others];
    if (result.created) {
      await this.members.setMembers(result.channel.id, memberIds);
      this.socket.joinUsersToChannel(memberIds, result.channel.id);
      this.socket.emitToUsers(memberIds, 'channel:created', {
        channel: {
          id: result.channel.id,
          type: result.channel.type,
          name: result.channel.name,
          createdAt: result.channel.createdAt.toISOString(),
        },
        memberIds,
        createdBy: userId,
      });
    } else {
      this.socket.joinUsersToChannel([userId], result.channel.id);
    }
    return result;
  }

  /**
   * Idempotent DM creation: a transaction-scoped advisory lock on the sorted
   * user pair serialises concurrent requests, so a pair can only ever get
   * one DIRECT channel.
   */
  private async createDirect(userId: string, targetId: string): Promise<CreateChannelResult> {
    const [a, b] = [userId, targetId].sort();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`zevra:dm:${a}:${b}`}))`);

      const [existing] = await tx
        .select({ channelId: memberships.channelId })
        .from(memberships)
        .innerJoin(channels, eq(channels.id, memberships.channelId))
        .where(and(eq(channels.type, 'DIRECT'), inArray(memberships.userId, [a, b])))
        .groupBy(memberships.channelId)
        .having(sql`COUNT(DISTINCT ${memberships.userId}) = 2`)
        .limit(1);

      if (existing) {
        const [channel] = await tx
          .select(channelSummaryColumns)
          .from(channels)
          .where(eq(channels.id, existing.channelId))
          .limit(1);
        return { channel, created: false };
      }

      return this.insertChannel(userId, [targetId], 'DIRECT', null, tx);
    });
  }

  private async insertChannel(
    creatorId: string,
    others: string[],
    type: string,
    name: string | null,
    tx?: NodePgDatabase,
  ): Promise<CreateChannelResult> {
    const run = async (db: NodePgDatabase) => {
      const [channel] = await db.insert(channels).values({ type, name }).returning(channelSummaryColumns);
      await db.insert(memberships).values([
        { userId: creatorId, channelId: channel.id, role: 'ADMIN' },
        ...others.map((uid) => ({ userId: uid, channelId: channel.id, role: 'MEMBER' })),
      ]);
      return { channel, created: true };
    };
    return tx ? run(tx) : this.db.transaction((t) => run(t));
  }

  // ─── Inbox ─────────────────────────────────────────────────────────────

  async getInbox(userId: string) {
    const memberChannels = await this.db
      .select({ channelId: memberships.channelId, lastReadMessageId: memberships.lastReadMessageId })
      .from(memberships)
      .where(eq(memberships.userId, userId));

    if (memberChannels.length === 0) return [];
    const channelIds = memberChannels.map((mc) => mc.channelId);

    const [result, dmMembers, unread] = await Promise.all([
      this.db
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
          lastMessageMetadata: messages.metadata,
          lastMessageSenderKeyEpoch: messages.senderKeyEpoch,
          createdAt: channels.createdAt,
        })
        .from(channels)
        .leftJoin(messages, eq(channels.lastMessageId, messages.id))
        .leftJoin(users, eq(messages.senderId, users.id))
        .where(inArray(channels.id, channelIds))
        .orderBy(desc(channels.lastMessageAt)),
      this.db
        .select({ channelId: memberships.channelId, userId: memberships.userId })
        .from(memberships)
        .innerJoin(channels, eq(channels.id, memberships.channelId))
        .where(
          and(
            inArray(memberships.channelId, channelIds),
            eq(channels.type, 'DIRECT'),
            ne(memberships.userId, userId),
          ),
        ),
      this.cacheService.getUnreadCounts(userId, channelIds),
    ]);

    const lastReadMap = new Map(memberChannels.map((mc) => [mc.channelId, mc.lastReadMessageId]));
    const dmPeerMap = new Map(dmMembers.map((m) => [m.channelId, m.userId]));

    return result.map((channel) => ({
      ...channel,
      lastReadMessageId: lastReadMap.get(channel.id) ?? null,
      dmPeerId: channel.type === 'DIRECT' ? (dmPeerMap.get(channel.id) ?? null) : null,
      unreadCount: unread[channel.id] ?? 0,
    }));
  }

  // ─── Mark read (REST POST /channels/mark-read and socket mark-read) ──

  /**
   * Advances the read watermark (by sequence number, never backwards),
   * resets the unread counter and emits `message:read` to the channel room.
   */
  async markRead(userId: string, channelId: string, messageId: string) {
    const lastRead = alias(messages, 'last_read');
    const [row] = await this.db
      .select({
        membershipId: memberships.id,
        targetSeq: messages.sequenceNumber,
        currentSeq: lastRead.sequenceNumber,
      })
      .from(memberships)
      .leftJoin(messages, and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
      .leftJoin(lastRead, eq(lastRead.id, memberships.lastReadMessageId))
      .where(and(eq(memberships.userId, userId), eq(memberships.channelId, channelId)))
      .limit(1);

    if (!row) throw new ForbiddenException('Not a member of this channel');
    if (row.targetSeq == null) throw new NotFoundException('Message not found in this channel');

    let advanced = false;
    if (row.currentSeq == null || row.currentSeq < row.targetSeq) {
      const updated = await this.db.execute(sql`
        UPDATE memberships
        SET last_read_message_id = ${messageId}, last_read_at = now()
        WHERE id = ${row.membershipId}
          AND (
            last_read_message_id IS NULL
            OR COALESCE(
              (SELECT sequence_number FROM messages WHERE id = memberships.last_read_message_id),
              0
            ) < ${row.targetSeq}
          )
      `);
      advanced = (updated.rowCount ?? 0) > 0;
    }

    await this.cacheService.resetUnread(userId, channelId);

    if (advanced) {
      const readAt = new Date();
      await this.db
        .insert(messageReads)
        .values({ messageId, userId, readAt })
        .onConflictDoNothing();
      this.socket.emitToChannel(channelId, 'message:read', {
        userId,
        messageId,
        channelId,
        readAt: readAt.toISOString(),
      });
    }

    return { success: true, advanced };
  }

  // ─── Channel details ─────────────────────────────────────────────────

  async getChannel(channelId: string, userId: string) {
    const role = await this.assertMember(channelId, userId);

    const [channel] = await this.db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) throw new NotFoundException('Channel not found');

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

    return { ...channel, role, members };
  }

  // ─── Members ─────────────────────────────────────────────────────────

  async addMember(channelId: string, requesterId: string, newUserId: string, role?: string) {
    const requesterRole = await this.getRole(channelId, requesterId);
    if (requesterRole !== 'ADMIN') {
      throw new ForbiddenException('Only admins can add members');
    }

    const [channel] = await this.db
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== 'GROUP') {
      throw new BadRequestException('Members can only be added to group channels');
    }

    const [user] = await this.db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(and(eq(users.id, newUserId), eq(users.isActive, true)))
      .limit(1);
    if (!user) throw new NotFoundException('User not found');

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.channelId, channelId));
    if (Number(count) >= MAX_CHANNEL_PARTICIPANTS + 1) {
      throw new BadRequestException('Channel is full');
    }

    const [newMember] = await this.db
      .insert(memberships)
      .values({ userId: newUserId, channelId, role: role ?? 'MEMBER' })
      .onConflictDoNothing({ target: [memberships.userId, memberships.channelId] })
      .returning({ id: memberships.id });
    if (!newMember) {
      throw new ConflictException('User is already a member');
    }

    await this.db.update(channels).set({ updatedAt: new Date() }).where(eq(channels.id, channelId));
    await this.members.invalidate(channelId);

    this.socket.joinUsersToChannel([newUserId], channelId);
    this.socket.emitToChannelAndUsers(channelId, [newUserId], 'channel:member-added', {
      channelId,
      userId: newUserId,
    });

    return { membershipId: newMember.id, user };
  }

  /**
   * Removes a member (admins remove others; anyone may leave). If the last
   * admin leaves, the longest-standing remaining member is promoted.
   */
  async removeMember(channelId: string, requesterId: string, targetUserId: string) {
    if (requesterId !== targetUserId) {
      const requesterRole = await this.getRole(channelId, requesterId);
      if (requesterRole !== 'ADMIN') {
        throw new ForbiddenException('Only admins can remove members');
      }
    }

    const promotedUserId = await this.db.transaction(async (tx) => {
      // Serialise membership changes on this channel
      await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).for('update');

      const [removed] = await tx
        .delete(memberships)
        .where(and(eq(memberships.userId, targetUserId), eq(memberships.channelId, channelId)))
        .returning({ role: memberships.role });
      if (!removed) throw new NotFoundException('Member not found in channel');

      let promoted: string | null = null;
      if (removed.role === 'ADMIN') {
        const [admin] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(and(eq(memberships.channelId, channelId), eq(memberships.role, 'ADMIN')))
          .limit(1);
        if (!admin) {
          const [oldest] = await tx
            .select({ id: memberships.id, userId: memberships.userId })
            .from(memberships)
            .where(eq(memberships.channelId, channelId))
            .orderBy(asc(memberships.joinedAt))
            .limit(1);
          if (oldest) {
            await tx.update(memberships).set({ role: 'ADMIN' }).where(eq(memberships.id, oldest.id));
            promoted = oldest.userId;
          }
        }
      }

      await tx.update(channels).set({ updatedAt: new Date() }).where(eq(channels.id, channelId));
      return promoted;
    });

    await Promise.all([
      this.members.invalidate(channelId),
      this.cacheService.resetUnread(targetUserId, channelId),
    ]);

    // Notify (incl. the removed user) before their sockets leave the room
    this.socket.emitToChannelAndUsers(channelId, [targetUserId], 'channel:member-removed', {
      channelId,
      userId: targetUserId,
    });
    this.socket.removeUserFromChannel(targetUserId, channelId);

    return { success: true, promotedUserId };
  }

  async archive(channelId: string, userId: string) {
    const role = await this.getRole(channelId, userId);
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can archive channels');
    }

    const [channel] = await this.db
      .select({ isArchived: channels.isArchived })
      .from(channels)
      .where(eq(channels.id, channelId));
    if (!channel) throw new NotFoundException('Channel not found');

    const isArchived = !channel.isArchived;
    await this.db
      .update(channels)
      .set({ isArchived, updatedAt: new Date() })
      .where(eq(channels.id, channelId));

    return { isArchived };
  }

  // ─── Typing / read receipts ──────────────────────────────────────────

  async getTypingUsers(channelId: string, userId: string) {
    await this.assertMember(channelId, userId);
    const typingUserIds = await this.cacheService.getTypingUsers(channelId);
    return typingUserIds.filter((id) => id !== userId);
  }

  /** userId → last read message id, from the authoritative membership rows. */
  async getReadReceipts(channelId: string, userId: string): Promise<Record<string, string>> {
    await this.assertMember(channelId, userId);
    const rows = await this.db
      .select({ userId: memberships.userId, lastReadMessageId: memberships.lastReadMessageId })
      .from(memberships)
      .where(eq(memberships.channelId, channelId));
    const receipts: Record<string, string> = {};
    for (const r of rows) {
      if (r.lastReadMessageId) receipts[r.userId] = r.lastReadMessageId;
    }
    return receipts;
  }
}
