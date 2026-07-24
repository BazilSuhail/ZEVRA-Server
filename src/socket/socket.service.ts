import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

export const channelRoom = (channelId: string) => `channel:${channelId}`;
export const userRoom = (userId: string) => `user:${userId}`;

export interface EmitOptions {
  /** Skip one specific socket (e.g. the sender's socket). */
  exceptSocketId?: string;
  /** Skip every socket of this user. */
  exceptUserId?: string;
}

/**
 * Room-based emit helpers. Every socket joins `user:{userId}` and
 * `channel:{channelId}` for each membership, so all operations here work
 * across nodes through the Socket.IO Redis adapter and across a user's
 * multiple devices.
 */
@Injectable()
export class SocketService {
  private readonly logger = new Logger(SocketService.name);
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  async emitToUser(userId: string, event: string, data: unknown): Promise<boolean> {
    if (!this.server) return false;
    this.server.to(userRoom(userId)).emit(event, data);
    return true;
  }

  emitToUsers(userIds: string[], event: string, data: unknown) {
    if (!this.server || userIds.length === 0) return;
    this.server.to(userIds.map(userRoom)).emit(event, data);
  }

  emitToChannel(channelId: string, event: string, data: unknown, options: EmitOptions = {}) {
    if (!this.server) return;
    let op = this.server.to(channelRoom(channelId));
    const except: string[] = [];
    if (options.exceptSocketId) except.push(options.exceptSocketId);
    if (options.exceptUserId) except.push(userRoom(options.exceptUserId));
    if (except.length > 0) op = op.except(except);
    op.emit(event, data);
  }

  /** Emits once to the union of a channel room and extra user rooms. */
  emitToChannelAndUsers(channelId: string, userIds: string[], event: string, data: unknown) {
    if (!this.server) return;
    this.server.to([channelRoom(channelId), ...userIds.map(userRoom)]).emit(event, data);
  }

  /** Joins every live socket of the given users to the channel room (all nodes). */
  joinUsersToChannel(userIds: string[], channelId: string) {
    if (!this.server || userIds.length === 0) return;
    this.server.in(userIds.map(userRoom)).socketsJoin(channelRoom(channelId));
  }

  /** Makes every live socket of the user leave the channel room (all nodes). */
  removeUserFromChannel(userId: string, channelId: string) {
    if (!this.server) return;
    this.server.in(userRoom(userId)).socketsLeave(channelRoom(channelId));
  }

  /**
   * User ids with at least one live socket currently in the channel room
   * (cluster-wide). Returns null when that cannot be determined, in which
   * case callers must treat every recipient as offline.
   */
  async getConnectedUserIds(channelId: string): Promise<Set<string> | null> {
    if (!this.server) return null;
    try {
      const sockets = await this.server.in(channelRoom(channelId)).fetchSockets();
      const ids = new Set<string>();
      for (const s of sockets) {
        const id = (s.data as { user?: { id?: string } } | undefined)?.user?.id;
        if (id) ids.add(id);
      }
      return ids;
    } catch (err) {
      this.logger.warn(`fetchSockets failed for ${channelId}: ${(err as Error).message}`);
      return null;
    }
  }
}
