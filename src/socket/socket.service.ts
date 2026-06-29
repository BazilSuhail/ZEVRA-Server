import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { RedisSessionService } from '../redis/redis-session.service';
import { RedisPubSubService } from '../redis/redis-pubsub.service';

@Injectable()
export class SocketService {
  private readonly logger = new Logger(SocketService.name);
  private server: Server | null = null;

  constructor(
    private sessionService: RedisSessionService,
    private pubSubService: RedisPubSubService,
  ) {}

  setServer(server: Server) {
    this.server = server;
  }

  // ─── Emit to specific user ─────────────────────────────────────────────

  async emitToUser(userId: string, event: string, data: unknown): Promise<boolean> {
    if (!this.server) return false;

    const socketId = await this.sessionService.getSession(userId);
    if (!socketId) return false;

    const socket = this.server.sockets.sockets.get(socketId);
    if (!socket) return false;

    socket.emit(event, data);
    return true;
  }

  // ─── Broadcast to channel room ─────────────────────────────────────────

  broadcastToChannel(channelId: string, event: string, data: unknown, excludeUserId?: string) {
    if (!this.server) return;
    this.server.to(`channel:${channelId}`).emit(event, data);
  }

  // ─── Emit to specific socket ───────────────────────────────────────────

  emitToSocket(socketId: string, event: string, data: unknown) {
    if (!this.server) return;
    const socket = this.server.sockets.sockets.get(socketId);
    if (socket) socket.emit(event, data);
  }

  // ─── Join/Leave rooms ──────────────────────────────────────────────────

  joinChannel(socket: Socket, channelId: string) {
    socket.join(`channel:${channelId}`);
  }

  leaveChannel(socket: Socket, channelId: string) {
    socket.leave(`channel:${channelId}`);
  }

  // ─── Get online members of a channel ──────────────────────────────────

  async getOnlineChannelMembers(channelId: string): Promise<string[]> {
    const members = await this.sessionService.getChannelMembers(channelId);
    if (members.length === 0) return [];

    const online = await this.sessionService.getOnlineUsers(members);
    return Array.from(online);
  }

  // ─── Check if user is online ──────────────────────────────────────────

  async isUserOnline(userId: string): Promise<boolean> {
    return this.sessionService.isOnline(userId);
  }

  // ─── Get connected socket count ───────────────────────────────────────

  getConnectedCount(): number {
    if (!this.server) return 0;
    return this.server.sockets.sockets.size;
  }
}
