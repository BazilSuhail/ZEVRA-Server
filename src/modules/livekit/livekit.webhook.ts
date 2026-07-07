import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { callLogs, callParticipants, users } from '../../database/schema';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

@Injectable()
export class LivekitWebhookService {
  private readonly logger = new Logger(LivekitWebhookService.name);

  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async handleRoomStarted(roomName: string): Promise<string | null> {
    try {
      const [row] = await this.db
        .insert(callLogs)
        .values({
          type: 'LIVEKIT',
          roomName,
          status: 'completed',
        } as any)
        .returning({ id: callLogs.id });
      return row.id;
    } catch (err) {
      this.logger.error(`Failed to create call log on room_started: ${(err as Error).message}`);
      return null;
    }
  }

  async handleRoomFinished(roomName: string, duration: number): Promise<void> {
    try {
      await this.db
        .update(callLogs)
        .set({
          endedAt: new Date(),
          duration,
        })
        .where(eq(callLogs.roomName, roomName));
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
        .limit(1);

      if (!log) return;

      await this.db
        .insert(callParticipants)
        .values({
          callLogId: log.id,
          userId: identity,
          username: name,
        })
        .onConflictDoNothing();
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
