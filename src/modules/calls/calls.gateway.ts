import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, UseGuards, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { CallsService, ActiveCall } from './calls.service';
import { SocketService } from '../../socket/socket.service';
import { RedisSessionService } from '../../redis/redis-session.service';
import { RateLimitService } from '../../shared/rate-limit/rate-limit.service';
import { LivekitService } from '../livekit/livekit.service';

interface SocketUser {
  id: string;
  username: string;
  email: string;
  status: string;
}

const CALL_RATE_LIMIT = { windowMs: 5000, maxRequests: 10 };

@WebSocketGateway({ cors: true })
export class CallsGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(CallsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private callsService: CallsService,
    private socketService: SocketService,
    private sessionService: RedisSessionService,
    private rateLimitService: RateLimitService,
    private livekitService: LivekitService,
    private jwt: JwtService,
    @Inject(DB) private db: NodePgDatabase,
  ) {}

  // ─── Auth helper ───────────────────────────────────────────────────────

  private async authenticateClient(client: Socket): Promise<SocketUser | null> {
    const token =
      client.handshake?.auth?.token ||
      client.handshake?.headers?.authorization?.slice(7);
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      const [user] = await this.db
        .select({ id: users.id, username: users.username, email: users.email, status: users.status })
        .from(users)
        .where(eq(users.id, payload.sub));
      return user ?? null;
    } catch {
      return null;
    }
  }

  private getOtherUserId(call: ActiveCall, userId: string): string {
    return call.initiatorId === userId ? call.targetId : call.initiatorId;
  }

  // ─── Disconnect: cleanup active calls ──────────────────────────────────

  async handleDisconnect(@ConnectedSocket() client: Socket) {
    const user: SocketUser = client.data.user;
    if (!user) return;

    const call = await this.callsService.cleanupUserCall(user.id);
    if (call && call.status === 'connected') {
      const callLogId = await this.callsService.createCallLog(
        'WEBRTC',
        call.initiatorId,
        call.targetId,
        null,
      );
      await this.callsService.updateCallLogAccepted(callLogId);
      await this.callsService.endCallLog(
        callLogId,
        call.initiatorId,
        '',
        call.targetId,
        '',
        new Date(call.startedAt),
      );

      const otherId = this.getOtherUserId(call, user.id);
      this.socketService.emitToUser(otherId, 'call:hangup', {
        callId: call.callId,
        reason: 'disconnected',
      });
    } else if (call && call.status === 'ringing') {
      const otherId = this.getOtherUserId(call, user.id);
      await this.callsService.cleanupCall(call.callId);
      this.socketService.emitToUser(otherId, 'call:hangup', {
        callId: call.callId,
        reason: 'caller_disconnected',
      });
    }
  }

  // ─── call:invite ───────────────────────────────────────────────────────

  @SubscribeMessage('call:invite')
  async handleInvite(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserId: string },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

    const rl = await this.rateLimitService.checkRateLimit(
      `call:${user.id}`,
      CALL_RATE_LIMIT,
    );
    if (!rl.allowed) {
      return { success: false, error: 'RATE_LIMITED' };
    }

    // Check caller not already in a call
    const callerCall = await this.callsService.getActiveCall(user.id);
    if (callerCall) {
      return { success: false, error: 'ALREADY_IN_CALL' };
    }

    // Check target not already in a call
    const targetCall = await this.callsService.getActiveCall(data.targetUserId);
    if (targetCall) {
      return { success: false, error: 'TARGET_BUSY' };
    }

    // Check target is online
    const isOnline = await this.sessionService.isOnline(data.targetUserId);
    if (!isOnline) {
      return { success: false, error: 'TARGET_OFFLINE' };
    }

    // Create call state
    const call = await this.callsService.createCall(user.id, data.targetUserId);

    // Create DB log (status=missed initially)
    const callLogId = await this.callsService.createCallLog(
      'WEBRTC',
      user.id,
      data.targetUserId,
      null,
    );

    // Notify target
    this.socketService.emitToUser(data.targetUserId, 'call:incoming', {
      callId: call.callId,
      callerId: user.id,
      callerUsername: user.username,
    });

    return { success: true, callId: call.callId, callLogId };
  }

  // ─── call:accept ───────────────────────────────────────────────────────

  @SubscribeMessage('call:accept')
  async handleAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

    const call = await this.callsService.getActiveCall(user.id);
    if (!call || call.callId !== data.callId) {
      return { success: false, error: 'INVALID_CALL' };
    }

    await this.callsService.acceptCall(call.callId);

    // Notify caller
    this.socketService.emitToUser(call.initiatorId, 'call:accepted', {
      callId: call.callId,
    });

    return { success: true };
  }

  // ─── call:reject ───────────────────────────────────────────────────────

  @SubscribeMessage('call:reject')
  async handleReject(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

    const call = await this.callsService.getActiveCall(user.id);
    if (!call || call.callId !== data.callId) {
      return { success: false, error: 'INVALID_CALL' };
    }

    // Create rejected log
    const callLogId = await this.callsService.createCallLog(
      'WEBRTC',
      call.initiatorId,
      call.targetId,
      null,
    );
    await this.callsService.updateCallLogRejected(callLogId);

    await this.callsService.cleanupCall(call.callId);

    this.socketService.emitToUser(call.initiatorId, 'call:rejected', {
      callId: call.callId,
    });

    return { success: true };
  }

  // ─── call:offer ────────────────────────────────────────────────────────

  @SubscribeMessage('call:offer')
  async handleOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; sdp: string },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return;

    const call = await this.callsService.getActiveCall(user.id);
    if (!call || call.callId !== data.callId) return;

    const otherId = this.getOtherUserId(call, user.id);
    this.socketService.emitToUser(otherId, 'call:offer', {
      callId: call.callId,
      sdp: data.sdp,
      from: user.id,
    });
  }

  // ─── call:answer ───────────────────────────────────────────────────────

  @SubscribeMessage('call:answer')
  async handleAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; sdp: string },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return;

    const call = await this.callsService.getActiveCall(user.id);
    if (!call || call.callId !== data.callId) return;

    const otherId = this.getOtherUserId(call, user.id);
    this.socketService.emitToUser(otherId, 'call:answer', {
      callId: call.callId,
      sdp: data.sdp,
      from: user.id,
    });
  }

  // ─── call:ice-candidate ────────────────────────────────────────────────

  @SubscribeMessage('call:ice-candidate')
  async handleIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; candidate: unknown },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return;

    const call = await this.callsService.getActiveCall(user.id);
    if (!call || call.callId !== data.callId) return;

    const otherId = this.getOtherUserId(call, user.id);
    this.socketService.emitToUser(otherId, 'call:ice-candidate', {
      callId: call.callId,
      candidate: data.candidate,
      from: user.id,
    });
  }

  // ─── call:hangup ───────────────────────────────────────────────────────

  @SubscribeMessage('call:hangup')
  async handleHangup(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

    const call = await this.callsService.getActiveCall(user.id);
    if (!call || call.callId !== data.callId) {
      return { success: false, error: 'INVALID_CALL' };
    }

    const otherId = this.getOtherUserId(call, user.id);

    // If call was connected, log it
    if (call.status === 'connected') {
      const callLogId = await this.callsService.createCallLog(
        'WEBRTC',
        call.initiatorId,
        call.targetId,
        null,
      );
      await this.callsService.updateCallLogAccepted(callLogId);
      await this.callsService.endCallLog(
        callLogId,
        call.initiatorId,
        '',
        call.targetId,
        '',
        new Date(call.startedAt),
      );
    }

    await this.callsService.cleanupCall(call.callId);

    this.socketService.emitToUser(otherId, 'call:hangup', {
      callId: call.callId,
    });

    return { success: true };
  }

  // ─── call:initiate ────────────────────────────────────────────────────

  @SubscribeMessage('call:initiate')
  async handleInitiate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserIds: string[]; type: 'DM' | 'GROUP' },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

    const rl = await this.rateLimitService.checkRateLimit(
      `call:${user.id}`,
      CALL_RATE_LIMIT,
    );
    if (!rl.allowed) {
      return { success: false, error: 'RATE_LIMITED' };
    }

    // Check caller not already in a call
    const callerCall = await this.callsService.getActiveCall(user.id);
    if (callerCall) {
      return { success: false, error: 'ALREADY_IN_CALL' };
    }

    // GROUP → always LiveKit
    if (data.type === 'GROUP') {
      return this.initiateLiveKitGroupCall(user, data.targetUserIds);
    }

    // DM → try WebRTC first
    const targetId = data.targetUserIds[0];
    if (!targetId) {
      return { success: false, error: 'NO_TARGET' };
    }

    const targetCall = await this.callsService.getActiveCall(targetId);
    if (targetCall) {
      return { success: false, error: 'TARGET_BUSY' };
    }

    const isOnline = await this.sessionService.isOnline(targetId);
    if (!isOnline) {
      // Target offline → tell client to use LiveKit fallback
      return { success: false, error: 'TARGET_OFFLINE', fallback: 'LIVEKIT' };
    }

    // Target online → WebRTC path
    const call = await this.callsService.createCall(user.id, targetId);
    const callLogId = await this.callsService.createCallLog(
      'WEBRTC',
      user.id,
      targetId,
      null,
    );

    this.socketService.emitToUser(targetId, 'call:incoming', {
      callId: call.callId,
      callerId: user.id,
      callerUsername: user.username,
    });

    return { success: true, method: 'WEBRTC', callId: call.callId, callLogId };
  }

  // ─── call:livekit-fallback ────────────────────────────────────────────

  @SubscribeMessage('call:livekit-fallback')
  async handleLiveKitFallback(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserIds: string[] },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

    if (!this.livekitService.isConfigured) {
      return { success: false, error: 'LIVEKIT_NOT_CONFIGURED' };
    }

    // Generate DM room token
    const targetId = data.targetUserIds[0];
    if (!targetId) {
      return { success: false, error: 'NO_TARGET' };
    }

    const roomName = LivekitService.getDmRoomName(user.id, targetId);

    // Create LiveKit room (2 participants for DM)
    await this.livekitService.createRoom(roomName, 2);

    // Generate token for caller
    const token = await this.livekitService.generateToken(roomName, user.id, user.username);
    if (!token) {
      return { success: false, error: 'TOKEN_FAILED' };
    }

    // Notify target to join via LiveKit
    const targetToken = await this.livekitService.generateToken(roomName, targetId, '');
    if (targetToken) {
      this.socketService.emitToUser(targetId, 'livekit:incoming', {
        roomName,
        serverUrl: process.env.LIVEKIT_URL,
        token: targetToken,
        callerId: user.id,
        callerUsername: user.username,
      });
    }

    return {
      success: true,
      method: 'LIVEKIT',
      roomName,
      serverUrl: process.env.LIVEKIT_URL,
      token,
    };
  }

  // ─── call:livekit-join-group ──────────────────────────────────────────

  @SubscribeMessage('call:livekit-join-group')
  async handleLiveKitJoinGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomName: string },
  ) {
    const user: SocketUser = client.data.user;
    if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

    if (!this.livekitService.isConfigured) {
      return { success: false, error: 'LIVEKIT_NOT_CONFIGURED' };
    }

    const token = await this.livekitService.generateToken(
      data.roomName,
      user.id,
      user.username,
    );

    if (!token) {
      return { success: false, error: 'TOKEN_FAILED' };
    }

    return {
      success: true,
      serverUrl: process.env.LIVEKIT_URL,
      token,
      roomName: data.roomName,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async initiateLiveKitGroupCall(
    user: SocketUser,
    targetUserIds: string[],
  ) {
    if (!this.livekitService.isConfigured) {
      return { success: false, error: 'LIVEKIT_NOT_CONFIGURED' };
    }

    const roomName = LivekitService.getGroupRoomName();
    const maxParticipants = Math.min(10, targetUserIds.length + 1);

    await this.livekitService.createRoom(roomName, maxParticipants);

    // Token for creator
    const creatorToken = await this.livekitService.generateToken(
      roomName,
      user.id,
      user.username,
    );

    // Notify all participants
    for (const targetId of targetUserIds) {
      const targetToken = await this.livekitService.generateToken(roomName, targetId, '');
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
    };
  }
}
