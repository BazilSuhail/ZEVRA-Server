import { Inject, Injectable } from '@nestjs/common';
import { DB } from './database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

@Injectable()
export class AppService {
  constructor(@Inject(DB) private db: NodePgDatabase) {}

  async getHealth() {
    try {
      await this.db.execute(sql`SELECT 1`);
      return {
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'error',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      };
    }
  }
}
