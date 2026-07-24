import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { callLogs, callParticipants } from '../../database/schema';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class LivekitWebhookService {
  private readonly logger = new Logger(LivekitWebhookService.name);

  constructor(@Inject(DB) private db: NodePgDatabase) {}

  private async latestLogId(roomName: string): Promise<string | null> {
    const [log] = await this.db
      .select({ id: callLogs.id })
      .from(callLogs)
      .where(eq(callLogs.roomName, roomName))
      .orderBy(desc(callLogs.startedAt))
      .limit(1);
    return log?.id ?? null;
  }

  async handleRoomStarted(roomName: string): Promise<string | null> {
    try {
      // Reuse the log created at call initiation (still open) to avoid a
      // duplicate row per room session.
      const [existing] = await this.db
        .select({ id: callLogs.id })
        .from(callLogs)
        .where(and(eq(callLogs.roomName, roomName), isNull(callLogs.endedAt)))
        .orderBy(desc(callLogs.startedAt))
        .limit(1);
      if (existing) return existing.id;

      const [row] = await this.db
        .insert(callLogs)
        .values({ type: 'LIVEKIT', roomName, status: 'missed' })
        .returning({ id: callLogs.id });
      return row.id;
    } catch (err) {
      this.logger.error(`Failed to create call log on room_started: ${(err as Error).message}`);
      return null;
    }
  }

  async handleRoomFinished(roomName: string): Promise<void> {
    try {
      const updated = await this.db
        .update(callLogs)
        .set({
          endedAt: new Date(),
          duration: sql<number>`GREATEST(0, EXTRACT(EPOCH FROM (now() - ${callLogs.startedAt})))::int`,
          status: 'completed',
        })
        .where(and(eq(callLogs.roomName, roomName), isNull(callLogs.endedAt)))
        .returning({ id: callLogs.id });

      if (updated.length === 0) {
        await this.db.insert(callLogs).values({
          type: 'LIVEKIT',
          roomName,
          endedAt: new Date(),
          duration: 0,
          status: 'completed',
        });
      }
    } catch (err) {
      this.logger.error(`Failed to update call log on room_finished: ${(err as Error).message}`);
    }
  }

  async handleParticipantJoined(roomName: string, identity: string, name: string): Promise<void> {
    if (!UUID_RE.test(identity)) return;
    try {
      const logId = await this.latestLogId(roomName);
      if (!logId) return;

      // Rejoin after a leave: reset the row so duration counts from this join.
      const [reset] = await this.db
        .update(callParticipants)
        .set({ joinedAt: new Date(), leftAt: null, duration: null })
        .where(and(eq(callParticipants.callLogId, logId), eq(callParticipants.userId, identity)))
        .returning({ id: callParticipants.id });

      if (!reset) {
        await this.db
          .insert(callParticipants)
          .values({ callLogId: logId, userId: identity, username: name.slice(0, 32) })
          .onConflictDoNothing();
      }
    } catch (err) {
      this.logger.error(`Failed to add participant: ${(err as Error).message}`);
    }
  }

  async handleParticipantLeft(roomName: string, identity: string): Promise<void> {
    if (!UUID_RE.test(identity)) return;
    try {
      const logId = await this.latestLogId(roomName);
      if (!logId) return;

      const [participant] = await this.db
        .select({ id: callParticipants.id, joinedAt: callParticipants.joinedAt })
        .from(callParticipants)
        .where(and(eq(callParticipants.callLogId, logId), eq(callParticipants.userId, identity)))
        .limit(1);
      if (!participant) return;

      const now = new Date();
      const duration = Math.max(0, Math.floor((now.getTime() - participant.joinedAt.getTime()) / 1000));

      await this.db
        .update(callParticipants)
        .set({ leftAt: now, duration })
        .where(eq(callParticipants.id, participant.id));
    } catch (err) {
      this.logger.error(`Failed to update participant: ${(err as Error).message}`);
    }
  }
}
