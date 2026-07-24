import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { RedisService } from '../../redis/redis.service';
import { callLogs, callParticipants, users } from '../../database/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/** Ringing calls expire quickly; connected calls are kept for up to 4 hours. */
const RINGING_TTL_SECONDS = 120;
const CONNECTED_TTL_SECONDS = 4 * 60 * 60;

const roomKey = (callId: string) => `zevra:call:room:${callId}`;
const userCallKey = (userId: string) => `zevra:call:user:${userId}`;

export interface ActiveCall {
  callId: string;
  initiatorId: string;
  targetId: string;
  status: string; // 'ringing' | 'connected'
  startedAt: number;
  callLogId: string | null;
}

function toActiveCall(callId: string, data: Record<string, string> | null | undefined): ActiveCall | null {
  if (!data || !data.initiatorId) return null;
  return {
    callId,
    initiatorId: data.initiatorId,
    targetId: data.targetId,
    status: data.status,
    startedAt: Number(data.startedAt),
    callLogId: data.callLogId || null,
  };
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private redisService: RedisService,
  ) {}

  private get redis() {
    return this.redisService.getClient();
  }

  // ─── Redis State ───────────────────────────────────────────────────────

  async getActiveCall(userId: string): Promise<ActiveCall | null> {
    if (!this.redis) return null;
    try {
      const callId = await this.redis.get(userCallKey(userId));
      if (!callId) return null;
      const data = await this.redis.hGetAll(roomKey(callId));
      return toActiveCall(callId, data as Record<string, string>);
    } catch (err) {
      this.logger.warn(`getActiveCall failed: ${(err as Error).message}`);
      return null;
    }
  }

  async createCall(initiatorId: string, targetId: string, callLogId: string | null = null): Promise<ActiveCall> {
    const callId = randomUUID();
    const now = Date.now();

    if (this.redis) {
      const pipeline = this.redis.multi();
      pipeline.hSet(roomKey(callId), {
        initiatorId,
        targetId,
        status: 'ringing',
        startedAt: String(now),
        callLogId: callLogId ?? '',
      });
      pipeline.expire(roomKey(callId), RINGING_TTL_SECONDS);
      pipeline.setEx(userCallKey(initiatorId), RINGING_TTL_SECONDS, callId);
      pipeline.setEx(userCallKey(targetId), RINGING_TTL_SECONDS, callId);
      await pipeline.exec();
    }

    return { callId, initiatorId, targetId, status: 'ringing', startedAt: now, callLogId };
  }

  /** Marks the call connected, restarts its clock and extends the state TTL. */
  async acceptCall(call: ActiveCall): Promise<void> {
    if (!this.redis) return;
    try {
      const pipeline = this.redis.multi();
      pipeline.hSet(roomKey(call.callId), { status: 'connected', startedAt: String(Date.now()) });
      pipeline.expire(roomKey(call.callId), CONNECTED_TTL_SECONDS);
      pipeline.expire(userCallKey(call.initiatorId), CONNECTED_TTL_SECONDS);
      pipeline.expire(userCallKey(call.targetId), CONNECTED_TTL_SECONDS);
      await pipeline.exec();
    } catch (err) {
      this.logger.warn(`acceptCall failed: ${(err as Error).message}`);
    }
  }

  async cleanupCall(callId: string): Promise<ActiveCall | null> {
    if (!this.redis) return null;
    try {
      const data = await this.redis.hGetAll(roomKey(callId));
      const pipeline = this.redis.multi();
      pipeline.del(roomKey(callId));
      if (data?.initiatorId) pipeline.del(userCallKey(data.initiatorId));
      if (data?.targetId) pipeline.del(userCallKey(data.targetId));
      await pipeline.exec();
      return toActiveCall(callId, data as Record<string, string>);
    } catch (err) {
      this.logger.warn(`cleanupCall failed: ${(err as Error).message}`);
      return null;
    }
  }

  async cleanupUserCall(userId: string): Promise<ActiveCall | null> {
    const callId = await this.redis?.get(userCallKey(userId));
    if (!callId) return null;
    return this.cleanupCall(callId);
  }

  // ─── DB Writes ─────────────────────────────────────────────────────────

  async getUsernames(userIds: string[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(rows.map((r) => [r.id, r.username]));
  }

  async createCallLog(
    callType: 'WEBRTC' | 'LIVEKIT',
    initiatorId: string,
    calleeId: string | null,
    roomName: string | null,
    channelId?: string | null,
  ): Promise<string> {
    const data: typeof callLogs.$inferInsert = {
      type: callType,
      callerId: initiatorId,
      calleeId,
      roomName,
      channelId: channelId ?? null,
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

  /** Closes a connected 1:1 call log and records both participants. */
  async endCallLog(callLogId: string, callerId: string, calleeId: string, startedAt: Date): Promise<void> {
    const now = new Date();
    const duration = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
    const names = await this.getUsernames([callerId, calleeId]);

    await this.db
      .update(callLogs)
      .set({ endedAt: now, duration, status: 'completed' })
      .where(eq(callLogs.id, callLogId));

    await this.db
      .insert(callParticipants)
      .values(
        [callerId, calleeId].map((userId) => ({
          callLogId,
          userId,
          username: names.get(userId) ?? '',
          joinedAt: startedAt,
          leftAt: now,
          duration,
        })),
      )
      .onConflictDoNothing();
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
