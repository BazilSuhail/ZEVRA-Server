import {
  WebSocketGateway,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { CallsService, ActiveCall } from './calls.service';
import { SocketService, userRoom } from '../../socket/socket.service';
import { RedisSessionService } from '../../redis/redis-session.service';
import { RateLimitService } from '../../shared/rate-limit/rate-limit.service';
import { LivekitService } from '../livekit/livekit.service';
import { getCorsOrigins } from '../../common/config';
import { socketError, toSocketError } from '../../common/errors/socket-error';

interface SocketUser {
  id: string;
  username: string;
}

const CALL_RATE_LIMIT = { windowMs: 5000, maxRequests: 10 };
const SIGNAL_RATE_LIMIT = { windowMs: 1000, maxRequests: 50 };
const MAX_SDP_LENGTH = 64 * 1024;
const MAX_CANDIDATE_LENGTH = 4096;
const MAX_GROUP_TARGETS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_NAME_RE = /^(dm|group)-[0-9a-f-]{36,73}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isUuidList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(isUuid);
}

function payload<T extends object>(data: unknown): Partial<T> {
  return data && typeof data === 'object' ? (data as Partial<T>) : {};
}

const invalid = (message: string) => socketError('VALIDATION_ERROR', message);
const notAuthenticated = () => socketError('NOT_AUTHENTICATED', 'Not authenticated');

@WebSocketGateway({ cors: { origin: getCorsOrigins(), credentials: true } })
export class CallsGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(CallsGateway.name);

  constructor(
    private callsService: CallsService,
    private socketService: SocketService,
    private sessionService: RedisSessionService,
    private rateLimitService: RateLimitService,
    private livekitService: LivekitService,
  ) {}

  private getOtherUserId(call: ActiveCall, userId: string): string {
    return call.initiatorId === userId ? call.targetId : call.initiatorId;
  }

  private user(client: Socket): SocketUser | null {
    const user = client.data?.user;
    return user && typeof user.id === 'string' ? (user as SocketUser) : null;
  }

  private async allowed(userId: string, scope: string, limit: typeof CALL_RATE_LIMIT): Promise<boolean> {
    const rl = await this.rateLimitService.checkRateLimit(`${scope}:${userId}`, limit);
    return rl.allowed;
  }

  /** Records a connected 1:1 call as completed, reusing its log when known. */
  private async finishConnectedCall(call: ActiveCall): Promise<void> {
    const callLogId =
      call.callLogId ?? (await this.callsService.createCallLog('WEBRTC', call.initiatorId, call.targetId, null));
    await this.callsService.endCallLog(callLogId, call.initiatorId, call.targetId, new Date(call.startedAt));
  }

  // ─── Disconnect: cleanup active calls ──────────────────────────────────

  async handleDisconnect(@ConnectedSocket() client: Socket) {
    const user = this.user(client);
    if (!user) return;

    try {
      // Keep the call if another socket of the same user is still connected.
      const remaining = await client.nsp.in(userRoom(user.id)).fetchSockets().catch(() => []);
      if (remaining.some((s) => s.id !== client.id)) return;

      const call = await this.callsService.cleanupUserCall(user.id);
      if (!call) return;
      const otherId = this.getOtherUserId(call, user.id);
      if (call.status === 'connected') {
        await this.finishConnectedCall(call);
        this.socketService.emitToUser(otherId, 'call:hangup', { callId: call.callId, reason: 'disconnected' });
      } else {
        this.socketService.emitToUser(otherId, 'call:hangup', {
          callId: call.callId,
          reason: 'caller_disconnected',
        });
      }
    } catch (err) {
      this.logger.error(`Call cleanup on disconnect failed: ${(err as Error).message}`);
    }
  }

  // ─── call:invite ───────────────────────────────────────────────────────

  @SubscribeMessage('call:invite')
  async handleInvite(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    try {
      const user = this.user(client);
      if (!user) return notAuthenticated();
      const { targetUserId } = payload<{ targetUserId: string }>(data);
      if (!isUuid(targetUserId) || targetUserId === user.id) return invalid('targetUserId must be a valid user id');

      if (!(await this.allowed(user.id, 'call', CALL_RATE_LIMIT))) {
        return socketError('RATE_LIMITED', 'Too many call attempts');
      }
      if (await this.callsService.getActiveCall(user.id)) {
        return { success: false, error: 'ALREADY_IN_CALL', message: 'You are already in a call' };
      }
      if (await this.callsService.getActiveCall(targetUserId)) {
        return { success: false, error: 'TARGET_BUSY', message: 'User is busy' };
      }
      if (!(await this.sessionService.isOnline(targetUserId))) {
        return { success: false, error: 'TARGET_OFFLINE', message: 'User is offline' };
      }

      const callLogId = await this.callsService.createCallLog('WEBRTC', user.id, targetUserId, null);
      const call = await this.callsService.createCall(user.id, targetUserId, callLogId);

      this.socketService.emitToUser(targetUserId, 'call:incoming', {
        callId: call.callId,
        callerId: user.id,
        callerUsername: user.username,
      });

      return { success: true, callId: call.callId, callLogId };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── call:accept ───────────────────────────────────────────────────────

  @SubscribeMessage('call:accept')
  async handleAccept(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    try {
      const user = this.user(client);
      if (!user) return notAuthenticated();
      const { callId } = payload<{ callId: string }>(data);
      if (!isUuid(callId)) return invalid('callId must be a valid id');

      const call = await this.callsService.getActiveCall(user.id);
      if (!call || call.callId !== callId || call.targetId !== user.id) {
        return { success: false, error: 'INVALID_CALL', message: 'Call not found' };
      }

      await this.callsService.acceptCall(call);
      if (call.callLogId) await this.callsService.updateCallLogAccepted(call.callLogId);

      this.socketService.emitToUser(call.initiatorId, 'call:accepted', {
        callId: call.callId,
        calleeId: user.id,
        calleeUsername: user.username,
      });

      return { success: true };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── call:reject ───────────────────────────────────────────────────────

  @SubscribeMessage('call:reject')
  async handleReject(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    try {
      const user = this.user(client);
      if (!user) return notAuthenticated();
      const { callId } = payload<{ callId: string }>(data);
      if (!isUuid(callId)) return invalid('callId must be a valid id');

      const call = await this.callsService.getActiveCall(user.id);
      if (!call || call.callId !== callId) {
        return { success: false, error: 'INVALID_CALL', message: 'Call not found' };
      }

      const callLogId =
        call.callLogId ?? (await this.callsService.createCallLog('WEBRTC', call.initiatorId, call.targetId, null));
      await this.callsService.updateCallLogRejected(callLogId);
      await this.callsService.cleanupCall(call.callId);

      this.socketService.emitToUser(this.getOtherUserId(call, user.id), 'call:rejected', {
        callId: call.callId,
      });

      return { success: true };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── WebRTC signalling relays ──────────────────────────────────────────

  private async relayTarget(client: Socket, callId: unknown): Promise<{ user: SocketUser; call: ActiveCall } | null> {
    const user = this.user(client);
    if (!user || !isUuid(callId)) return null;
    if (!(await this.allowed(user.id, 'call-signal', SIGNAL_RATE_LIMIT))) return null;
    const call = await this.callsService.getActiveCall(user.id);
    if (!call || call.callId !== callId) return null;
    return { user, call };
  }

  @SubscribeMessage('call:offer')
  async handleOffer(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const { callId, sdp } = payload<{ callId: string; sdp: string }>(data);
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_LENGTH) return;
    const ctx = await this.relayTarget(client, callId).catch(() => null);
    if (!ctx) return;
    this.socketService.emitToUser(this.getOtherUserId(ctx.call, ctx.user.id), 'call:offer', {
      callId: ctx.call.callId,
      offer: { type: 'offer', sdp },
      callerId: ctx.user.id,
      callerUsername: ctx.user.username,
    });
  }

  @SubscribeMessage('call:answer')
  async handleAnswer(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const { callId, sdp } = payload<{ callId: string; sdp: string }>(data);
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_LENGTH) return;
    const ctx = await this.relayTarget(client, callId).catch(() => null);
    if (!ctx) return;
    this.socketService.emitToUser(this.getOtherUserId(ctx.call, ctx.user.id), 'call:answer', {
      callId: ctx.call.callId,
      answer: { type: 'answer', sdp },
      calleeId: ctx.user.id,
      calleeUsername: ctx.user.username,
    });
  }

  @SubscribeMessage('call:ice-candidate')
  async handleIceCandidate(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const { callId, candidate } = payload<{ callId: string; candidate: unknown }>(data);
    if (candidate === undefined || JSON.stringify(candidate ?? null).length > MAX_CANDIDATE_LENGTH) return;
    const ctx = await this.relayTarget(client, callId).catch(() => null);
    if (!ctx) return;
    this.socketService.emitToUser(this.getOtherUserId(ctx.call, ctx.user.id), 'call:ice-candidate', {
      callId: ctx.call.callId,
      candidate,
      from: ctx.user.id,
    });
  }

  // ─── call:hangup ───────────────────────────────────────────────────────

  @SubscribeMessage('call:hangup')
  async handleHangup(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    try {
      const user = this.user(client);
      if (!user) return notAuthenticated();
      const { callId } = payload<{ callId: string }>(data);
      if (!isUuid(callId)) return invalid('callId must be a valid id');

      const call = await this.callsService.getActiveCall(user.id);
      if (!call || call.callId !== callId) {
        return { success: false, error: 'INVALID_CALL', message: 'Call not found' };
      }

      if (call.status === 'connected') {
        await this.finishConnectedCall(call);
      }
      await this.callsService.cleanupCall(call.callId);

      this.socketService.emitToUser(this.getOtherUserId(call, user.id), 'call:hangup', {
        callId: call.callId,
      });

      return { success: true };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── call:initiate ────────────────────────────────────────────────────

  @SubscribeMessage('call:initiate')
  async handleInitiate(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    try {
      const user = this.user(client);
      if (!user) return notAuthenticated();
      const { targetUserIds, type, channelId } = payload<{
        targetUserIds: string[];
        type: 'DM' | 'GROUP';
        channelId?: string;
      }>(data);
      if (type !== 'DM' && type !== 'GROUP') return invalid('type must be DM or GROUP');
      if (!isUuidList(targetUserIds, MAX_GROUP_TARGETS)) return invalid('targetUserIds must be a list of user ids');
      if (channelId !== undefined && channelId !== null && !isUuid(channelId)) {
        return invalid('channelId must be a valid id');
      }

      if (!(await this.allowed(user.id, 'call', CALL_RATE_LIMIT))) {
        return socketError('RATE_LIMITED', 'Too many call attempts');
      }
      if (await this.callsService.getActiveCall(user.id)) {
        return { success: false, error: 'ALREADY_IN_CALL', message: 'You are already in a call' };
      }

      if (type === 'GROUP') {
        if (!channelId) return { success: false, error: 'CHANNEL_REQUIRED', message: 'channelId is required' };
        const authorized = await this.livekitService.authorizeRoomAccess(
          LivekitService.getGroupRoomName(channelId),
          user.id,
        );
        if (!authorized) return socketError('NOT_MEMBER', 'Not a member of this channel');
        return await this.initiateLiveKitGroupCall(user, channelId, targetUserIds);
      }

      const targetId = targetUserIds[0];
      if (!targetId || targetId === user.id) {
        return { success: false, error: 'NO_TARGET', message: 'A target user is required' };
      }
      if (await this.callsService.getActiveCall(targetId)) {
        return { success: false, error: 'TARGET_BUSY', message: 'User is busy' };
      }
      if (!(await this.sessionService.isOnline(targetId))) {
        return { success: false, error: 'TARGET_OFFLINE', message: 'User is offline', fallback: 'LIVEKIT' };
      }

      const callLogId = await this.callsService.createCallLog('WEBRTC', user.id, targetId, null, channelId ?? null);
      const call = await this.callsService.createCall(user.id, targetId, callLogId);
      const names = await this.callsService.getUsernames([targetId]);

      this.socketService.emitToUser(user.id, 'call:method-selected', {
        callId: call.callId,
        method: 'WEBRTC',
        targetUserId: targetId,
        targetUsername: names.get(targetId) ?? 'Unknown',
      });
      this.socketService.emitToUser(targetId, 'call:incoming', {
        callId: call.callId,
        callerId: user.id,
        callerUsername: user.username,
      });

      return { success: true, method: 'WEBRTC', callId: call.callId, callLogId };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── call:livekit-fallback ────────────────────────────────────────────

  @SubscribeMessage('call:livekit-fallback')
  async handleLiveKitFallback(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    try {
      const user = this.user(client);
      if (!user) return notAuthenticated();
      const { targetUserIds, channelId } = payload<{ targetUserIds: string[]; channelId?: string }>(data);
      if (!isUuidList(targetUserIds, MAX_GROUP_TARGETS)) return invalid('targetUserIds must be a list of user ids');
      if (channelId !== undefined && channelId !== null && !isUuid(channelId)) {
        return invalid('channelId must be a valid id');
      }
      if (!this.livekitService.isConfigured) {
        return { success: false, error: 'LIVEKIT_NOT_CONFIGURED', message: 'Calls are not available' };
      }
      if (!(await this.allowed(user.id, 'call', CALL_RATE_LIMIT))) {
        return socketError('RATE_LIMITED', 'Too many call attempts');
      }

      const targetId = targetUserIds[0];
      if (!targetId || targetId === user.id) {
        return { success: false, error: 'NO_TARGET', message: 'A target user is required' };
      }

      const roomName = LivekitService.getDmRoomName(user.id, targetId);
      await this.livekitService.createRoom(roomName, 2);

      const callLogId = await this.callsService.createCallLog('LIVEKIT', user.id, targetId, roomName, channelId ?? null);

      const token = await this.livekitService.generateToken(roomName, user.id, user.username);
      if (!token) return { success: false, error: 'TOKEN_FAILED', message: 'Could not start the call' };

      const names = await this.callsService.getUsernames([targetId]);
      const targetName = names.get(targetId);
      if (targetName) {
        const targetToken = await this.livekitService.generateToken(roomName, targetId, targetName);
        if (targetToken) {
          this.socketService.emitToUser(targetId, 'livekit:incoming', {
            roomName,
            serverUrl: process.env.LIVEKIT_URL,
            token: targetToken,
            callerId: user.id,
            callerUsername: user.username,
          });
        }
      }

      return {
        success: true,
        method: 'LIVEKIT',
        roomName,
        serverUrl: process.env.LIVEKIT_URL,
        token,
        callLogId,
      };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── call:livekit-active ───────────────────────────────────────────────

  @SubscribeMessage('call:livekit-active')
  async handleLiveKitActive(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    try {
      const user = this.user(client);
      if (!user) return notAuthenticated();
      const { channelId } = payload<{ channelId: string }>(data);
      if (!isUuid(channelId)) return invalid('channelId must be a valid id');

      const roomName = LivekitService.getGroupRoomName(channelId);
      if (!(await this.livekitService.authorizeRoomAccess(roomName, user.id))) {
        return socketError('NOT_MEMBER', 'Not a member of this channel');
      }
      if (!this.livekitService.isConfigured) {
        return { success: true, active: false, participantCount: 0 };
      }

      const participants = await this.livekitService.getParticipants(roomName);
      return {
        success: true,
        active: participants.length > 0,
        participantCount: participants.length,
        roomName,
      };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── call:livekit-join-group ──────────────────────────────────────────

  @SubscribeMessage('call:livekit-join-group')
  async handleLiveKitJoinGroup(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    try {
      const user = this.user(client);
      if (!user) return notAuthenticated();
      const { roomName } = payload<{ roomName: string }>(data);
      if (typeof roomName !== 'string' || !ROOM_NAME_RE.test(roomName)) return invalid('roomName is invalid');
      if (!this.livekitService.isConfigured) {
        return { success: false, error: 'LIVEKIT_NOT_CONFIGURED', message: 'Calls are not available' };
      }

      if (!(await this.livekitService.authorizeRoomAccess(roomName, user.id))) {
        return socketError('NOT_MEMBER', 'Not allowed to join this call');
      }

      const token = await this.livekitService.generateToken(roomName, user.id, user.username);
      if (!token) return { success: false, error: 'TOKEN_FAILED', message: 'Could not join the call' };

      return { success: true, serverUrl: process.env.LIVEKIT_URL, token, roomName };
    } catch (err) {
      return toSocketError(err);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async initiateLiveKitGroupCall(user: SocketUser, channelId: string, targetUserIds: string[]) {
    if (!this.livekitService.isConfigured) {
      return { success: false, error: 'LIVEKIT_NOT_CONFIGURED', message: 'Calls are not available' };
    }

    const roomName = LivekitService.getGroupRoomName(channelId);
    await this.livekitService.createRoom(roomName, 10);

    // Created up front (webhook room_started reuses it) so group calls show
    // in history even when webhooks are not configured.
    const callLogId = await this.callsService.createCallLog('LIVEKIT', user.id, null, roomName, channelId);

    const creatorToken = await this.livekitService.generateToken(roomName, user.id, user.username);

    // Only invite users who are actually members of the channel.
    const candidates = Array.from(new Set(targetUserIds.filter((id) => id !== user.id)));
    const names = await this.callsService.getUsernames(candidates);
    for (const targetId of candidates) {
      const name = names.get(targetId);
      if (!name) continue;
      if (!(await this.livekitService.authorizeRoomAccess(roomName, targetId))) continue;
      const targetToken = await this.livekitService.generateToken(roomName, targetId, name);
      if (targetToken) {
        this.socketService.emitToUser(targetId, 'livekit:group-invite', {
          roomName,
          serverUrl: process.env.LIVEKIT_URL,
          token: targetToken,
          creatorId: user.id,
          creatorUsername: user.username,
        });
      }
    }

    return {
      success: true,
      method: 'LIVEKIT',
      roomName,
      serverUrl: process.env.LIVEKIT_URL,
      token: creatorToken,
      callLogId,
    };
  }
}
