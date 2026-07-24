import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

const CONNECT_TIMEOUT_MS = 10_000;

/** Exponential backoff capped at 5s; never gives up. */
export function redisReconnectStrategy(retries: number): number {
  return Math.min(100 * 2 ** Math.min(retries, 6), 5_000);
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisClientType | null = null;
  private connecting: Promise<RedisClientType | null> | null = null;
  private readonly extraClients = new Set<RedisClientType>();
  private errorLogged = false;

  async onModuleInit() {
    await this.connect();
  }

  async connect(): Promise<RedisClientType | null> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.error('REDIS_URL not set — Redis features disabled');
      return null;
    }

    this.connecting = (async () => {
      const client = createClient({
        url,
        disableOfflineQueue: true,
        socket: { reconnectStrategy: redisReconnectStrategy, connectTimeout: CONNECT_TIMEOUT_MS },
      }) as RedisClientType;
      this.attachListeners(client, 'main');
      this.client = client;

      try {
        await withTimeout(client.connect(), CONNECT_TIMEOUT_MS);
        this.logger.log('Redis connected');
      } catch (err) {
        this.logger.error(
          `Redis initial connection failed (${(err as Error).message}) — retrying in background`,
        );
      }
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * The shared command client, or null when Redis is not currently ready.
   * Callers treat null as degraded mode.
   */
  getClient(): RedisClientType | null {
    return this.client?.isReady ? this.client : null;
  }

  /**
   * A dedicated connected client (e.g. a Socket.IO adapter subscriber).
   * Tracked and closed on shutdown.
   */
  async createDedicatedClient(label: string): Promise<RedisClientType | null> {
    const base = this.getClient();
    if (!base) return null;
    const client = base.duplicate() as RedisClientType;
    this.attachListeners(client, label);
    try {
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MS);
      this.extraClients.add(client);
      return client;
    } catch (err) {
      this.logger.error(`Redis ${label} client failed to connect: ${(err as Error).message}`);
      client.destroy();
      return null;
    }
  }

  async ping(): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;
    try {
      return (await client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async quit(): Promise<void> {
    const clients = [...this.extraClients, ...(this.client ? [this.client] : [])];
    this.extraClients.clear();
    this.client = null;
    await Promise.all(
      clients.map(async (c) => {
        try {
          if (c.isOpen) await c.quit();
        } catch {
          c.destroy();
        }
      }),
    );
  }

  async onModuleDestroy() {
    await this.quit();
  }

  private attachListeners(client: RedisClientType, label: string) {
    client.on('error', (err: Error) => {
      // Log the first error of an outage only; the reconnect strategy keeps retrying
      if (!this.errorLogged) {
        this.errorLogged = true;
        this.logger.error(`Redis ${label} error: ${err.message}`);
      }
    });
    client.on('ready', () => {
      if (this.errorLogged) this.logger.log(`Redis ${label} ready`);
      this.errorLogged = false;
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
