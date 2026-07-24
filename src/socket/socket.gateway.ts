import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UseGuards, Inject, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { IsArray, IsOptional, IsUUID, ArrayMaxSize } from 'class-validator';
import {
  SocketAuthGuard,
  SocketData,
  SocketUser,
  SOCKET_JWT_VERIFY_OPTIONS,
  extractSocketToken,
  isTokenExpired,
} from './socket-auth.guard';
import { SocketService, channelRoom, userRoom } from './socket.service';
import { validatePayload } from './validate-payload';
import { createSocketRedisAdapter } from './socket-redis-adapter';
import { RedisSessionService } from '../redis/redis-session.service';
import { RedisCacheService } from '../redis/redis-cache.service';
import { RedisService } from '../redis/redis.service';
import { ChannelMembersService } from '../redis/channel-members.service';
import { RateLimitService } from '../shared/rate-limit/rate-limit.service';
import { ChatService } from '../chat/chat.service';
import { ChannelsService } from '../modules/channels/channels.service';
import { CreateChannelDto } from '../modules/channels/dto/create-channel.dto';
import { ChannelIdDto } from '../modules/channels/dto/mark-read.dto';
import { DB } from '../database/database.module';
import { users } from '../database/schema';
import { SocketError, toSocketError } from '../common/errors/socket-error';
import { getCorsOrigins } from '../common/config';

const HEARTBEAT_INTERVAL_MS = 30_000;
const TYPING_AUTO_STOP_MS = 6_000;

class PresenceBulkDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  userIds?: string[];
}

@WebSocketGateway({ cors: { origin: getCorsOrigins(), credentials: true } })
export class SocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(SocketGateway.name);

  @WebSocketServer()
  server!: Server;

  private heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** key `${socketId}|${channelId}` → auto typing:stop timer */
  private typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private socketService: SocketService,
    private sessionService: RedisSessionService,
    private cacheService: RedisCacheService,
    private channelMembers: ChannelMembersService,
    private rateLimitService: RateLimitService,
    private redisService: RedisService,
    private chatService: ChatService,
    private channelsService: ChannelsService,
    private jwt: JwtService,
    @Inject(DB) private db: NodePgDatabase,
  ) {}

  afterInit() {
    this.socketService.setServer(this.server);
    this.attachRedisAdapter().catch((err) =>
      this.logger.error(`Redis adapter setup failed: ${(err as Error).message}`),
    );
  }

  private async attachRedisAdapter() {
    const pubClient = this.redisService.getClient();
    const subClient = pubClient ? await this.redisService.createDedicatedClient('socket-adapter-sub') : null;
    if (!pubClient || !subClient) {
      this.logger.warn('Redis unavailable — Socket.IO running in single-node mode');
      return;
    }
    this.server.adapter(createSocketRedisAdapter(pubClient, subClient));
    this.logger.log('Socket.IO Redis adapter attached');
  }

  onModuleDestroy() {
    for (const interval of this.heartbeatIntervals.values()) clearInterval(interval);
    for (const timeout of this.typingTimeouts.values()) clearTimeout(timeout);
    this.heartbeatIntervals.clear();
    this.typingTimeouts.clear();
  }

  private clientIp(client: Socket): string {
    if (process.env.TRUST_PROXY === 'true') {
      const header = client.handshake.headers['x-forwarded-for'];
      const raw = Array.isArray(header) ? header[0] : header;
      const first = raw?.split(',')[0]?.trim();
      if (first) return first;
    }
    return client.handshake.address;
  }

  private rejectConnection(client: Socket, code: string, message: string) {
    client.emit('error', { code, message });
    client.disconnect(true);
  }

  // ─── Connection ────────────────────────────────────────────────────────

  async handleConnection(@ConnectedSocket() client: Socket) {
    const ip = this.clientIp(client);
    const ipResult = await this.rateLimitService.checkRateLimit(
      `conn-ip:${ip}`,
      RateLimitService.CONNECTION_PER_IP,
    );
    if (!ipResult.allowed) {
      this.logger.warn(`Connection rejected: rate limit for ${ip}`);
      return this.rejectConnection(client, 'RATE_LIMITED', 'Too many connections');
    }

    let user: SocketUser | undefined;
    let tokenExp: number | undefined;
    const token = extractSocketToken(client);
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string; exp?: number }>(
          token,
          SOCKET_JWT_VERIFY_OPTIONS,
        );
        const [found] = await this.db
          .select({ id: users.id, username: users.username, status: users.status })
          .from(users)
          .where(and(eq(users.id, payload.sub), eq(users.isActive, true)));
        user = found;
        tokenExp = payload.exp;
      } catch (err) {
        if ((err as { name?: string })?.name === 'TokenExpiredError') {
          return this.rejectConnection(client, 'TOKEN_EXPIRED', 'Token expired');
        }
      }
    }
    if (!user) {
      return this.rejectConnection(client, 'NOT_AUTHENTICATED', 'Authentication required');
    }

    client.data.user = user;
    client.data.tokenExp = tokenExp;

    let socketCount: number | null;
    try {
      // Join personal + channel rooms before announcing readiness, so nothing
      // emitted after `connected` can be missed.
      const channelIds = await this.chatService.getUserChannelIds(user.id);
      await client.join([userRoom(user.id), ...channelIds.map(channelRoom)]);
      if (!client.connected) return;

      socketCount = await this.sessionService.addSocket(user.id, client.id);
      await this.sessionService.setOnline(user.id);
    } catch (err) {
      this.logger.error(`Connection setup failed for ${user.id}: ${(err as Error).message}`);
      return this.rejectConnection(client, 'INTERNAL_ERROR', 'Connection setup failed');
    }
    if (!client.connected) {
      await this.sessionService.removeSocket(user.id, client.id);
      return;
    }
    this.startHeartbeat(client);

    client.emit('connected', { userId: user.id, username: user.username, socketId: client.id });

    this.pushPresence(client, user, socketCount === 1).catch((err) =>
      this.logger.warn(`Presence push failed: ${(err as Error).message}`),
    );
  }

  private async pushPresence(client: Socket, user: SocketUser, firstSocket: boolean) {
    const peerIds = await this.chatService.getUserDMPeers(user.id);
    if (peerIds.length === 0) return;
    const onlinePeers = await this.sessionService.getOnlineUsers(peerIds);
    client.emit('presence:bulk', { online: Array.from(onlinePeers) });
    if (firstSocket) {
      this.socketService.emitToUsers(Array.from(onlinePeers), 'user:joined', {
        userId: user.id,
        username: user.username,
      });
    }
  }

  // ─── Disconnect ────────────────────────────────────────────────────────

  async handleDisconnect(@ConnectedSocket() client: Socket) {
    this.stopHeartbeat(client.id);
    this.clearTypingFor(client);

    const user: SocketUser | undefined = client.data?.user;
    if (!user) return;

    const remaining = await this.sessionService.removeSocket(user.id, client.id);
    if (remaining !== 0) return;

    // Last live socket of this user (cluster-wide) is gone
    await this.sessionService.setOffline(user.id);
    try {
      const peerIds = await this.chatService.getUserDMPeers(user.id);
      this.socketService.emitToUsers(peerIds, 'user:left', { userId: user.id, username: user.username });
    } catch (err) {
      this.logger.warn(`Offline notify failed: ${(err as Error).message}`);
    }
  }

  // ─── Presence ─────────────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('presence:bulk')
  async handlePresenceBulk(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      const dto = validatePayload(PresenceBulkDto, data ?? {});
      let userIds = dto.userIds ?? [];
      if (userIds.length === 0) userIds = await this.chatService.getUserDMPeers(user.id);
      const online = await this.sessionService.getOnlineUsers(userIds);
      return { success: true, online: Array.from(online) };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── Create or Join Channel ──────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('create-or-join')
  async handleCreateOrJoin(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      const dto = validatePayload(CreateChannelDto, data);
      // Joins every member's sockets to the room and emits channel:created
      const { channel, created } = await this.channelsService.create(
        user.id,
        dto.participantIds,
        dto.type,
        dto.name,
      );
      await client.join(channelRoom(channel.id));
      return { success: true, channelId: channel.id, created };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── Join / Leave Channel room ─────────────────────────────────────────

  private async requireMember(channelId: string, userId: string) {
    if (!(await this.channelMembers.isMember(channelId, userId))) {
      throw new SocketError('NOT_MEMBER', 'Not a member of this channel');
    }
  }

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('join-channel')
  async handleJoinChannel(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      const { channelId } = validatePayload(ChannelIdDto, data);
      await this.requireMember(channelId, user.id);
      await client.join(channelRoom(channelId));
      return { success: true };
    } catch (err) {
      return toSocketError(err);
    }
  }

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('leave-channel')
  async handleLeaveChannel(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      const { channelId } = validatePayload(ChannelIdDto, data);
      await this.requireMember(channelId, user.id);
      await client.leave(channelRoom(channelId));
      return { success: true };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── Typing Indicators ────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('typing:start')
  async handleTypingStart(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      const { channelId } = validatePayload(ChannelIdDto, data);
      const rl = await this.rateLimitService.checkRateLimit(`typing:${user.id}`, RateLimitService.TYPING);
      if (!rl.allowed) throw new SocketError('RATE_LIMITED', 'Too many typing events');
      await this.requireMember(channelId, user.id);

      const timeoutKey = `${client.id}|${channelId}`;
      const existing = this.typingTimeouts.get(timeoutKey);
      if (existing) clearTimeout(existing);

      await this.cacheService.setTyping(channelId, user.id);
      this.emitTyping('typing:start', user, channelId);

      this.typingTimeouts.set(
        timeoutKey,
        setTimeout(() => {
          this.typingTimeouts.delete(timeoutKey);
          this.stopTyping(user, channelId);
        }, TYPING_AUTO_STOP_MS),
      );
      return { success: true };
    } catch (err) {
      return toSocketError(err);
    }
  }

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('typing:stop')
  async handleTypingStop(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const user: SocketUser = client.data.user;
    try {
      const { channelId } = validatePayload(ChannelIdDto, data);
      const rl = await this.rateLimitService.checkRateLimit(`typing:${user.id}`, RateLimitService.TYPING);
      if (!rl.allowed) throw new SocketError('RATE_LIMITED', 'Too many typing events');
      await this.requireMember(channelId, user.id);

      const timeoutKey = `${client.id}|${channelId}`;
      const existing = this.typingTimeouts.get(timeoutKey);
      if (existing) {
        clearTimeout(existing);
        this.typingTimeouts.delete(timeoutKey);
      }
      this.stopTyping(user, channelId);
      return { success: true };
    } catch (err) {
      return toSocketError(err);
    }
  }

  private emitTyping(event: 'typing:start' | 'typing:stop', user: SocketUser, channelId: string) {
    this.socketService.emitToChannel(
      channelId,
      event,
      { userId: user.id, username: user.username, channelId },
      { exceptUserId: user.id },
    );
  }

  private stopTyping(user: SocketUser, channelId: string) {
    this.cacheService.clearTyping(channelId, user.id).catch(() => undefined);
    this.emitTyping('typing:stop', user, channelId);
  }

  private clearTypingFor(client: Socket) {
    const user: SocketUser | undefined = client.data?.user;
    const prefix = `${client.id}|`;
    for (const [key, timeout] of this.typingTimeouts) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timeout);
      this.typingTimeouts.delete(key);
      if (user) this.stopTyping(user, key.slice(prefix.length));
    }
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────

  @SubscribeMessage('heartbeat')
  async handleHeartbeat(@ConnectedSocket() client: Socket) {
    const user: SocketUser | undefined = client.data?.user;
    if (!user) return { success: false, error: 'NOT_AUTHENTICATED', message: 'Authentication required' };
    if (!(await this.beat(client))) {
      return { success: false, error: 'NOT_AUTHENTICATED', message: 'Token expired' };
    }
    const timestamp = Date.now();
    client.emit('heartbeat-ack', { timestamp });
    return { success: true, timestamp };
  }

  /** Refreshes liveness; disconnects with TOKEN_EXPIRED once the JWT expires. */
  private async beat(client: Socket): Promise<boolean> {
    const user: SocketUser | undefined = client.data?.user;
    if (!user) return false;
    if (isTokenExpired(client.data as SocketData)) {
      this.rejectConnection(client, 'TOKEN_EXPIRED', 'Token expired');
      return false;
    }
    await this.sessionService.refreshSocket(user.id, client.id);
    await this.sessionService.setOnline(user.id);
    return true;
  }

  private startHeartbeat(client: Socket) {
    this.stopHeartbeat(client.id);
    const interval = setInterval(() => {
      if (!client.connected) {
        this.stopHeartbeat(client.id);
        return;
      }
      this.beat(client).catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatIntervals.set(client.id, interval);
  }

  private stopHeartbeat(socketId: string) {
    const interval = this.heartbeatIntervals.get(socketId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(socketId);
    }
  }
}
