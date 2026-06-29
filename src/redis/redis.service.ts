import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisClientType | null = null;

  async connect(): Promise<RedisClientType | null> {
    if (this.client) return this.client;

    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn('REDIS_URL not set — Redis features disabled');
      return null;
    }

    try {
      this.client = createClient({ url });

      this.client.on('error', (err) => {
        this.logger.error(`Redis error: ${err.message}`);
      });

      this.client.on('reconnecting', () => {
        this.logger.warn('Redis reconnecting...');
      });

      await this.client.connect();
      this.logger.log('Redis connected');
      return this.client;
    } catch (err) {
      this.logger.error(`Redis connection failed: ${(err as Error).message}`);
      this.client = null;
      return null;
    }
  }

  getClient(): RedisClientType | null {
    return this.client;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async quit(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  async onModuleDestroy() {
    await this.quit();
  }
}
