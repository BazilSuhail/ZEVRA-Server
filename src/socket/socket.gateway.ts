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

@WebSocketGateway({ cors: true })
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SocketGateway.name);

  @WebSocketServer()
  server!: Server;

  // Heartbeat interval per socket
  private heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private socketService: SocketService,
    private sessionService: RedisSessionService,
    private cacheService: RedisCacheService,
    private pubSubService: RedisPubSubService,
  ) {}

  afterInit() {
    this.socketService.setServer(this.server);
    this.logger.log('Socket.io gateway initialized');
  }

  // ─── Connection ────────────────────────────────────────────────────────

  @UseGuards(SocketAuthGuard)
  async handleConnection(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    this.logger.log(`Client connected: ${client.id} (user: ${user.username})`);

    // Single-session enforcement: check for existing connection
    const existingSocketId = await this.sessionService.getSession(user.id);
    if (existingSocketId && existingSocketId !== client.id) {
      // Disconnect old socket
      const existingSocket = this.server.sockets.sockets.get(existingSocketId);
      if (existingSocket) {
        existingSocket.emit('forced-disconnect', {
          reason: 'Another device connected',
        });
        existingSocket.disconnect(true);
      }
      this.logger.log(`Disconnected old session for user ${user.username}`);
    }

    // Register new session
    await this.sessionService.registerSession(user.id, client.id);
    await this.sessionService.setOnline(user.id);

    // Subscribe to user's personal channel
    await this.pubSubService.subscribeToUser(user.id, (message) => {
      client.emit('user:message', JSON.parse(message));
    });

    // Start heartbeat
    this.startHeartbeat(client.id, user.id);

    // Send connection ack
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

    // Stop heartbeat
    const interval = this.heartbeatIntervals.get(client.id);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(client.id);
    }

    // Only remove session if this is the current socket for the user
    const currentSocketId = await this.sessionService.getSession(user.id);
    if (currentSocketId === client.id) {
      await this.sessionService.removeSession(user.id, client.id);
      await this.sessionService.setOffline(user.id);

      // Unsubscribe from user channel
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

    await this.cacheService.setTyping(data.channelId, user.id);

    // Broadcast to channel (except sender)
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
