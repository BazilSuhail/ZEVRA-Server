import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { SocketAuthGuard, SocketUser } from './socket-auth.guard';
import { SocketService } from './socket.service';
import { RedisSessionService } from '../redis/redis-session.service';
import { RedisCacheService } from '../redis/redis-cache.service';
import { RedisPubSubService } from '../redis/redis-pubsub.service';
import { RedisService } from '../redis/redis.service';
import { RateLimitService } from '../shared/rate-limit/rate-limit.service';
import { createSocketRedisAdapter } from './socket-redis-adapter';

@WebSocketGateway({ cors: true })
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SocketGateway.name);

  @WebSocketServer()
  server!: Server;

  private heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private ipConnections = new Map<string, Set<string>>();

  constructor(
    private socketService: SocketService,
    private sessionService: RedisSessionService,
    private cacheService: RedisCacheService,
    private pubSubService: RedisPubSubService,
    private rateLimitService: RateLimitService,
    private redisService: RedisService,
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

  @UseGuards(SocketAuthGuard)
  async handleConnection(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    const ip = (client.handshake.headers['x-forwarded-for'] as string) || client.handshake.address;

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

    await this.cacheService.setTyping(data.channelId, user.id);

    client.to(`channel:${data.channelId}`).emit('typing:start', {
      userId: user.id,
      username: user.username,
      channelId: data.channelId,
    });
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
