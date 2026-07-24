import { Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { redisReconnectStrategy } from '../../redis/redis.service';

export const BULL_REDIS_CLIENT = 'BULL_REDIS_CLIENT';
const CONNECT_WAIT_MS = 10_000;

const logger = new Logger('BullRedis');

/**
 * Dedicated node-redis client for BullMQ (BullMQ duplicates it for blocking
 * workers). Created at DI time with a reconnect strategy and error listener,
 * closed on application shutdown.
 */
async function createBullRedisClient(): Promise<RedisClientType> {
  const client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: { reconnectStrategy: redisReconnectStrategy },
  }) as RedisClientType;

  let errorLogged = false;
  client.on('error', (err: Error) => {
    if (errorLogged) return;
    errorLogged = true;
    logger.error(`BullMQ Redis error: ${err.message}`);
  });
  client.on('ready', () => {
    errorLogged = false;
  });

  const connecting = client.connect().catch((err: Error) => {
    logger.error(`BullMQ Redis connect failed: ${err.message}`);
  });
  // Do not block bootstrap forever; BullMQ waits for 'ready' on its own
  await Promise.race([connecting, new Promise((r) => setTimeout(r, CONNECT_WAIT_MS))]);
  return client;
}

@Injectable()
export class BullRedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(BULL_REDIS_CLIENT) private readonly client: RedisClientType) {}

  async onApplicationShutdown() {
    try {
      if (this.client.isOpen) await this.client.quit();
    } catch {
      this.client.destroy();
    }
  }
}

@Module({
  providers: [
    { provide: BULL_REDIS_CLIENT, useFactory: createBullRedisClient },
    BullRedisLifecycle,
  ],
  exports: [BULL_REDIS_CLIENT],
})
export class BullRedisModule {}
