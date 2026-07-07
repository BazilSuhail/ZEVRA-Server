import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { RedisService } from '../../redis/redis.service';
import { RedisSessionService } from '../../redis/redis-session.service';
import { callLogs, callParticipants, users } from '../../database/schema';
import { eq, and, sql, desc, asc } from 'drizzle-orm';
import { randomUUID } from 'crypto';

const CALL_TTL = 300; // 5 minutes max call duration in Redis

export interface ActiveCall {
  callId: string;
  initiatorId: string;
  targetId: string;
  status: string; // 'ringing' | 'connected'
  startedAt: number;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private redisService: RedisService,
    private sessionService: RedisSessionService,
  ) {}

  private get redis() {
    return this.redisService.getClient();
  }

  // ─── Redis State ───────────────────────────────────────────────────────

  async getActiveCall(userId: string): Promise<ActiveCall | null> {
    if (!this.redis) return null;
    try {
      const callId = await this.redis.get(`call:${userId}`);
      if (!callId) return null;
      const data = await this.redis.hGetAll(`call:room:${callId}`);
      if (!data || !data.initiatorId) return null;
      return {
        callId,
        initiatorId: data.initiatorId,
        targetId: data.targetId,
        status: data.status,
        startedAt: Number(data.startedAt),
      };
    } catch {
      return null;
    }
  }

  async createCall(
    initiatorId: string,
    targetId: string,
  ): Promise<ActiveCall> {
    const callId = randomUUID();
    const now = Date.now();

    if (this.redis) {
      const pipeline = this.redis.multi();
      pipeline.hSet(`call:room:${callId}`, {
        initiatorId,
        targetId,
        status: 'ringing',
        startedAt: String(now),
      });
      pipeline.expire(`call:room:${callId}`, CALL_TTL);
      pipeline.setEx(`call:${initiatorId}`, CALL_TTL, callId);
      pipeline.setEx(`call:${targetId}`, CALL_TTL, callId);
      await pipeline.exec();
    }

    return { callId, initiatorId, targetId, status: 'ringing', startedAt: now };
  }

  async acceptCall(callId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.hSet(`call:room:${callId}`, { status: 'connected' });
    } catch {}
  }

  async cleanupCall(callId: string): Promise<ActiveCall | null> {
    if (!this.redis) return null;
    try {
      const data = await this.redis.hGetAll(`call:room:${callId}`);
      const pipeline = this.redis.multi();
      pipeline.del(`call:room:${callId}`);
      if (data?.initiatorId) pipeline.del(`call:${data.initiatorId}`);
      if (data?.targetId) pipeline.del(`call:${data.targetId}`);
      await pipeline.exec();
      return data?.initiatorId
        ? {
            callId,
            initiatorId: data.initiatorId,
            targetId: data.targetId,
            status: data.status,
            startedAt: Number(data.startedAt),
          }
        : null;
    } catch {
      return null;
    }
  }

  async cleanupUserCall(userId: string): Promise<ActiveCall | null> {
    const callId = await this.redis?.get(`call:${userId}`);
    if (!callId) return null;
    return this.cleanupCall(callId);
  }

  // ─── DB Writes ─────────────────────────────────────────────────────────

  async createCallLog(
    callType: 'WEBRTC' | 'LIVEKIT',
    initiatorId: string,
    calleeId: string | null,
    roomName: string | null,
  ): Promise<string> {
    const data: typeof callLogs.$inferInsert = {
      type: callType,
      callerId: initiatorId,
      calleeId,
      roomName,
      status: 'missed',
    };
    const [row] = await this.db
      .insert(callLogs)
      .values(data)
      .returning({ id: callLogs.id });
    return row.id;
  }

  async updateCallLogAccepted(callLogId: string): Promise<void> {
    await this.db
      .update(callLogs)
      .set({ status: 'completed' })
      .where(eq(callLogs.id, callLogId));
  }

  async updateCallLogRejected(callLogId: string): Promise<void> {
    await this.db
      .update(callLogs)
      .set({ status: 'rejected' })
      .where(eq(callLogs.id, callLogId));
  }

  async endCallLog(
    callLogId: string,
    callerId: string,
    callerUsername: string,
    calleeId: string,
    calleeUsername: string,
    startedAt: Date,
  ): Promise<void> {
    const now = new Date();
    const duration = Math.floor((now.getTime() - startedAt.getTime()) / 1000);

    await this.db
      .update(callLogs)
      .set({ endedAt: now, duration })
      .where(eq(callLogs.id, callLogId));

    await this.db.insert(callParticipants).values([
      {
        callLogId,
        userId: callerId,
        username: callerUsername,
        joinedAt: startedAt,
        leftAt: now,
        duration,
      },
      {
        callLogId,
        userId: calleeId,
        username: calleeUsername,
        joinedAt: startedAt,
        leftAt: now,
        duration,
      },
    ]);
  }

  // ─── Call History (one query) ──────────────────────────────────────────

  async getCallHistory(userId: string, limit = 20, offset = 0) {
    const result = await this.db.execute(sql`
      SELECT
        cl.id,
        cl.type,
        cl.status,
        cl.started_at,
        cl.ended_at,
        cl.duration,
        cl.room_name,
        caller.id       AS caller_id,
        caller.username AS caller_username,
        callee.id       AS callee_id,
        callee.username AS callee_username,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'userId', cp.user_id,
            'username', cp.username,
            'joinedAt', cp.joined_at,
            'leftAt', cp.left_at,
            'duration', cp.duration
          )), '[]'::json)
          FROM call_participants cp
          WHERE cp.call_log_id = cl.id
        ) AS participants
      FROM call_logs cl
      LEFT JOIN users caller ON caller.id = cl.caller_id
      LEFT JOIN users callee ON callee.id = cl.callee_id
      WHERE cl.caller_id = ${userId}
         OR cl.callee_id = ${userId}
         OR EXISTS (
           SELECT 1 FROM call_participants cp2
           WHERE cp2.call_log_id = cl.id AND cp2.user_id = ${userId}
         )
      ORDER BY cl.started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return result.rows;
  }

  async getCallHistoryWithUser(userId: string, otherUserId: string, limit = 20) {
    const result = await this.db.execute(sql`
      SELECT
        cl.id,
        cl.type,
        cl.status,
        cl.started_at,
        cl.ended_at,
        cl.duration,
        cl.room_name,
        caller.id       AS caller_id,
        caller.username AS caller_username,
        callee.id       AS callee_id,
        callee.username AS callee_username,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'userId', cp.user_id,
            'username', cp.username,
            'joinedAt', cp.joined_at,
            'leftAt', cp.left_at,
            'duration', cp.duration
          )), '[]'::json)
          FROM call_participants cp
          WHERE cp.call_log_id = cl.id
        ) AS participants
      FROM call_logs cl
      LEFT JOIN users caller ON caller.id = cl.caller_id
      LEFT JOIN users callee ON callee.id = cl.callee_id
      WHERE (
        (cl.caller_id = ${userId} AND cl.callee_id = ${otherUserId})
        OR
        (cl.caller_id = ${otherUserId} AND cl.callee_id = ${userId})
      )
      ORDER BY cl.started_at DESC
      LIMIT ${limit}
    `);

    return result.rows;
  }
}
