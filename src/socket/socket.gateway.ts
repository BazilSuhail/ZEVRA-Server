import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UseGuards, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { SocketAuthGuard, SocketUser } from './socket-auth.guard';
import { SocketService } from './socket.service';
import { RedisSessionService } from '../redis/redis-session.service';
import { RedisCacheService } from '../redis/redis-cache.service';
import { RedisPubSubService } from '../redis/redis-pubsub.service';
import { RedisService } from '../redis/redis.service';
import { RateLimitService } from '../shared/rate-limit/rate-limit.service';
import { ChatService } from '../chat/chat.service';
import { createSocketRedisAdapter } from './socket-redis-adapter';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '../database/schema';
import { eq } from 'drizzle-orm';

@WebSocketGateway({ cors: true })
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SocketGateway.name);

  @WebSocketServer()
  server!: Server;

  private heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private ipConnections = new Map<string, Set<string>>();
  private typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private socketService: SocketService,
    private sessionService: RedisSessionService,
    private cacheService: RedisCacheService,
    private pubSubService: RedisPubSubService,
    private rateLimitService: RateLimitService,
    private redisService: RedisService,
    private chatService: ChatService,
    private jwt: JwtService,
    @Inject(DB) private db: NodePgDatabase,
  ) {}

  afterInit() {
    this.socketService.setServer(this.server);

    // Attach Redis adapter for multi-node broadcast
    const pubClient = this.redisService.getClient();
    if (pubClient) {
      const subClient = pubClient.duplicate();
      this.server.adapter(createSocketRedisAdapter(pubClient, subClient));
      this.logger.log('Socket.io Redis adapter attached — multi-node enabled');
    } else {
      this.logger.warn('Redis unavailable — single-node Socket.io mode');
    }

    this.logger.log('Socket.io gateway initialized');
  }

  // ─── Connection ────────────────────────────────────────────────────────

  // @UseGuards(SocketAuthGuard) — doesn't reliably block handleConnection in WS gateways
  async handleConnection(@ConnectedSocket() client: Socket) {
    // Inline auth check
    let user: SocketUser | undefined;

    const token =
      client.handshake?.auth?.token ||
      client.handshake?.headers?.authorization?.slice(7);

    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
        const [found] = await this.db
          .select({ id: users.id, username: users.username, email: users.email, status: users.status })
          .from(users)
          .where(eq(users.id, payload.sub));
        user = found;
      } catch {}
    }

    if (!user) {
      /* [SOCKET:REJECTED] */
      this.logger.warn(`[SOCKET:REJECTED] id=${client.id} reason=no_auth`);
      client.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Authentication required' });
      client.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Authentication required' });
      client.disconnect(true);
      return;
    }

    client.data.user = user;

    const ip = (client.handshake.headers['x-forwarded-for'] as string) || client.handshake.address;

    /* [SOCKET:CONNECT] */
    this.logger.log(`[SOCKET:CONNECT] id=${client.id} user=${user.id} username=${user.username} ip=${ip}`);

    // IP connection rate limit
    const ipKey = `ip:${ip}`;
    const ipResult = await this.rateLimitService.checkRateLimit(ipKey, RateLimitService.CONNECTION_PER_IP);
    if (!ipResult.allowed) {
      this.logger.warn(`Connection rejected — IP ${ip} exceeded rate limit`);
      client.emit('error', { code: 'RATE_LIMITED', message: 'Too many connections' });
      client.disconnect(true);
      return;
    }

    // Track IP connections
    if (!this.ipConnections.has(ip)) {
      this.ipConnections.set(ip, new Set());
    }
    this.ipConnections.get(ip)!.add(client.id);

    this.logger.log(`Client connected: ${client.id} (user: ${user.username})`);

    // Single-session enforcement
    const existingSocketId = await this.sessionService.getSession(user.id);
    if (existingSocketId && existingSocketId !== client.id) {
      const existingSocket = this.server.sockets.sockets.get(existingSocketId);
      if (existingSocket) {
        existingSocket.emit('forced-disconnect', {
          reason: 'Another device connected',
        });
        existingSocket.disconnect(true);
      }
      this.logger.log(`Disconnected old session for user ${user.username}`);
    }

    await this.sessionService.registerSession(user.id, client.id);
    await this.sessionService.setOnline(user.id);

    // Auto-join all channel rooms (needed for typing, reactions, read receipts)
    this.chatService.getUserChannelIds(user.id).then((channelIds) => {
      for (const channelId of channelIds) {
        client.join(`channel:${channelId}`);
      }
      this.logger.debug(`Auto-joined ${channelIds.length} channels for ${user.username}`);
    }).catch((err) =>
      this.logger.warn(`Auto-join channels failed: ${(err as Error).message}`),
    );

    // Auto-deliver pending messages from previous session
    this.chatService.deliverPendingMessages(user.id).catch((err) =>
      this.logger.warn(`Auto-deliver pending failed: ${(err as Error).message}`),
    );

    await this.pubSubService.subscribeToUser(user.id, (message) => {
      client.emit('user:message', JSON.parse(message));
    });

    this.startHeartbeat(client.id, user.id);

    client.emit('connected', {
      userId: user.id,
      username: user.username,
      socketId: client.id,
    });
  }

  // ─── Disconnect ────────────────────────────────────────────────────────

  async handleDisconnect(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    if (!user) return;

    /* [SOCKET:DISCONNECT] */
    this.logger.log(`[SOCKET:DISCONNECT] id=${client.id} user=${user.id} username=${user.username}`);

    this.logger.log(`Client disconnected: ${client.id} (user: ${user.username})`);

    const interval = this.heartbeatIntervals.get(client.id);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(client.id);
    }

    // Clean up IP tracking
    const ip = (client.handshake.headers['x-forwarded-for'] as string) || client.handshake.address;
    const ipSockets = this.ipConnections.get(ip);
    if (ipSockets) {
      ipSockets.delete(client.id);
      if (ipSockets.size === 0) this.ipConnections.delete(ip);
    }

    const currentSocketId = await this.sessionService.getSession(user.id);
    if (currentSocketId === client.id) {
      await this.sessionService.removeSession(user.id, client.id);
      await this.sessionService.setOffline(user.id);
      await this.pubSubService.unsubscribeFromUser(user.id);
    }
  }

  // ─── Create or Join Channel ──────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('create-or-join')
  async handleCreateOrJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { participantIds: string[]; type: string; name?: string },
  ) {
    const user: SocketUser = client.data.user;

    try {
      const result = await this.chatService.createOrJoinChannel(
        user.id,
        data.participantIds,
        data.type,
        data.name,
      );

      // Auto-join the room
      this.socketService.joinChannel(client, result.channelId);

      // Notify channel
      this.server.to(`channel:${result.channelId}`).emit('user:joined', {
        userId: user.id,
        username: user.username,
        channelId: result.channelId,
      });

      return { success: true, channelId: result.channelId, created: result.created };
    } catch (err) {
      const error = err as any;
      return { success: false, error: error?.message };
    }
  }

  // ─── Join Channel ──────────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('join-channel')
  async handleJoinChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const user: SocketUser = client.data.user;

    const isMember = await this.sessionService.isChannelMember(data.channelId, user.id);
    if (!isMember) {
      client.emit('error', { code: 'NOT_MEMBER', message: 'Not a member of this channel' });
      return { success: false, error: 'NOT_MEMBER' };
    }

    this.socketService.joinChannel(client, data.channelId);

    // Notify channel that user joined
    this.server.to(`channel:${data.channelId}`).emit('user:joined', {
      userId: user.id,
      username: user.username,
      channelId: data.channelId,
    });

    return { success: true };
  }

  // ─── Leave Channel ─────────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('leave-channel')
  async handleLeaveChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const user: SocketUser = client.data.user;

    this.socketService.leaveChannel(client, data.channelId);

    // Notify channel that user left
    this.server.to(`channel:${data.channelId}`).emit('user:left', {
      userId: user.id,
      username: user.username,
      channelId: data.channelId,
    });

    return { success: true };
  }

  // ─── Typing Indicators ────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('typing:start')
  async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const user: SocketUser = client.data.user;

    // Rate limit typing events
    const rl = await this.rateLimitService.checkRateLimit(
      `typing:${user.id}`,
      RateLimitService.TYPING,
    );
    if (!rl.allowed) return;

    // Clear any existing timeout for this user+channel
    const timeoutKey = `${user.id}:${data.channelId}`;
    const existing = this.typingTimeouts.get(timeoutKey);
    if (existing) clearTimeout(existing);

    await this.cacheService.setTyping(data.channelId, user.id);

    client.to(`channel:${data.channelId}`).emit('typing:start', {
      userId: user.id,
      username: user.username,
      channelId: data.channelId,
    });

    // Auto-broadcast typing:stop after 6s if client doesn't send it
    const timeout = setTimeout(async () => {
      this.typingTimeouts.delete(timeoutKey);
      await this.cacheService.clearTyping(data.channelId, user.id);
      client.to(`channel:${data.channelId}`).emit('typing:stop', {
        userId: user.id,
        username: user.username,
        channelId: data.channelId,
      });
    }, 6000);
    this.typingTimeouts.set(timeoutKey, timeout);
  }

  @UseGuards(SocketAuthGuard)
  @SubscribeMessage('typing:stop')
  async handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const user: SocketUser = client.data.user;

    const rl = await this.rateLimitService.checkRateLimit(
      `typing:${user.id}`,
      RateLimitService.TYPING,
    );
    if (!rl.allowed) return;

    // Clear the auto-timeout
    const timeoutKey = `${user.id}:${data.channelId}`;
    const existing = this.typingTimeouts.get(timeoutKey);
    if (existing) {
      clearTimeout(existing);
      this.typingTimeouts.delete(timeoutKey);
    }

    await this.cacheService.clearTyping(data.channelId, user.id);

    client.to(`channel:${data.channelId}`).emit('typing:stop', {
      userId: user.id,
      username: user.username,
      channelId: data.channelId,
    });
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────

  @SubscribeMessage('heartbeat')
  async handleHeartbeat(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    if (!user) return;

    await this.sessionService.renewSession(user.id, client.id);
    await this.sessionService.setOnline(user.id);

    client.emit('heartbeat-ack', { timestamp: Date.now() });
  }

  // ─── Private: Heartbeat Interval ───────────────────────────────────────

  private startHeartbeat(socketId: string, userId: string) {
    const interval = setInterval(async () => {
      // Check if socket is still alive
      const socket = this.server.sockets.sockets.get(socketId);
      if (!socket) {
        clearInterval(interval);
        this.heartbeatIntervals.delete(socketId);
        return;
      }

      // Renew session TTL
      await this.sessionService.renewSession(userId, socketId);
      await this.sessionService.setOnline(userId);
    }, 30_000); // Every 30 seconds

    this.heartbeatIntervals.set(socketId, interval);
  }
}
