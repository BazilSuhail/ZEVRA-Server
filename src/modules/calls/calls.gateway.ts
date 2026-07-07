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
}
