import { Module, Global, Inject, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { getDbConnectionOptions } from '../common/config';

export const DB = 'DB_CONNECTION';
export const PG_POOL = 'PG_POOL';

const logger = new Logger('Database');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const pool = new Pool({
          ...getDbConnectionOptions(),
          max: Number(process.env.DB_POOL_MAX) || 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
        });
        // Idle client errors (e.g. server restart) must not crash the process.
        pool.on('error', (err) => logger.error(`Idle pg client error: ${err.message}`));
        return pool;
      },
    },
    {
      provide: DB,
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
      inject: [PG_POOL],
    },
  ],
  exports: [DB, PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    try {
      await this.pool.end();
      logger.log('Postgres pool closed');
    } catch (err) {
      logger.error(`Failed to close Postgres pool: ${(err as Error).message}`);
    }
  }
}
