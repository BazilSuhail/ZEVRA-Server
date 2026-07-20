import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { callLogs, callParticipants, users } from '../../database/schema';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

@Injectable()
export class LivekitWebhookService {
  private readonly logger = new Logger(LivekitWebhookService.name);

  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async handleRoomStarted(roomName: string): Promise<string | null> {
    try {
      // Reuse the log created at call initiation (still open) — otherwise
      // we'd end up with a duplicate row per room session
      const [existing] = await this.db
        .select({ id: callLogs.id })
        .from(callLogs)
        .where(and(eq(callLogs.roomName, roomName), isNull(callLogs.endedAt)))
        .orderBy(desc(callLogs.startedAt))
        .limit(1);
      if (existing) return existing.id;

      const [row] = await this.db
        .insert(callLogs)
        .values({
          type: 'LIVEKIT',
          roomName,
          status: 'missed',
        })
        .returning({ id: callLogs.id });
      return row.id;
    } catch (err) {
      this.logger.error(`Failed to create call log on room_started: ${(err as Error).message}`);
      return null;
    }
  }

  async handleRoomFinished(roomName: string, duration: number): Promise<void> {
    try {
      // Close the most recent open log for this room (rooms are recreated
      // per session, so only the open one should be touched)
      const updated = await this.db
        .update(callLogs)
        .set({
          endedAt: new Date(),
          duration,
          status: 'completed',
        })
        .where(and(eq(callLogs.roomName, roomName), isNull(callLogs.endedAt)))
        .returning({ id: callLogs.id });

      if (updated.length === 0) {
        // No open log (e.g. initiation log was never created) — add one
        await this.db
          .insert(callLogs)
          .values({
            type: 'LIVEKIT',
            roomName,
            endedAt: new Date(),
            duration,
            status: 'completed',
          })
          .returning({ id: callLogs.id });
      }
    } catch (err) {
      this.logger.error(`Failed to update call log on room_finished: ${(err as Error).message}`);
    }
  }

  async handleParticipantJoined(roomName: string, identity: string, name: string): Promise<void> {
    try {
      // Find the call log for this room
      const [log] = await this.db
        .select({ id: callLogs.id })
        .from(callLogs)
        .where(eq(callLogs.roomName, roomName))
        .orderBy(desc(callLogs.startedAt))
        .limit(1);

      if (!log) return;

      // Rejoin after a leave: reset the row so duration counts from this join
      const [reset] = await this.db
        .update(callParticipants)
        .set({ joinedAt: new Date(), leftAt: null, duration: null })
        .where(
          and(
            eq(callParticipants.callLogId, log.id),
            eq(callParticipants.userId, identity),
          ),
        )
        .returning({ id: callParticipants.id });

      if (!reset) {
        await this.db
          .insert(callParticipants)
          .values({
            callLogId: log.id,
            userId: identity,
            username: name,
          });
      }
    } catch (err) {
      this.logger.error(`Failed to add participant: ${(err as Error).message}`);
    }
  }

  async handleParticipantLeft(roomName: string, identity: string): Promise<void> {
    try {
      const [log] = await this.db
        .select({ id: callLogs.id })
        .from(callLogs)
        .where(eq(callLogs.roomName, roomName))
        .limit(1);

      if (!log) return;

      const [participant] = await this.db
        .select({ id: callLogs.id, joinedAt: callParticipants.joinedAt })
        .from(callParticipants)
        .where(
          sql`${callParticipants.callLogId} = ${log.id} AND ${callParticipants.userId} = ${identity}`
        )
        .limit(1);

      if (!participant) return;

      const now = new Date();
      const duration = Math.floor((now.getTime() - participant.joinedAt.getTime()) / 1000);

      await this.db
        .update(callParticipants)
        .set({ leftAt: now, duration })
        .where(
          sql`${callParticipants.callLogId} = ${log.id} AND ${callParticipants.userId} = ${identity}`
        );
    } catch (err) {
      this.logger.error(`Failed to update participant: ${(err as Error).message}`);
    }
  }
}
