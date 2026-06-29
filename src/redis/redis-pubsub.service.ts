import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisClientType } from 'redis';
import { createClient } from 'redis';

type MessageHandler = (message: string) => void;

@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private publisher: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private subscriptions = new Map<string, Set<MessageHandler>>();

  async connect(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn('REDIS_URL not set — pub/sub disabled');
      return;
    }

    try {
      this.publisher = createClient({ url });
      this.subscriber = createClient({ url });

      this.publisher.on('error', (err) => {
        this.logger.error(`Pub publisher error: ${err.message}`);
      });

      this.subscriber.on('error', (err) => {
        this.logger.error(`Sub subscriber error: ${err.message}`);
      });

      this.subscriber.on('message', (channel, message) => {
        const handlers = this.subscriptions.get(channel);
        if (handlers) {
          for (const handler of handlers) {
            handler(message);
          }
        }
      });

      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      this.logger.log('Redis pub/sub connected');
    } catch (err) {
      this.logger.error(`Redis pub/sub connection failed: ${(err as Error).message}`);
      this.publisher = null;
      this.subscriber = null;
    }
  }

  async publish(channel: string, message: string): Promise<number> {
    if (!this.publisher) return 0;
    try {
      return await this.publisher.publish(channel, message);
    } catch (err) {
      this.logger.error(`Publish failed on ${channel}: ${(err as Error).message}`);
      return 0;
    }
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<void> {
    if (!this.subscriber) return;

    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
      await this.subscriber.subscribe(channel, () => {});
    }

    this.subscriptions.get(channel)!.add(handler);
  }

  async unsubscribe(channel: string, handler?: MessageHandler): Promise<void> {
    if (!this.subscriber) return;

    const handlers = this.subscriptions.get(channel);
    if (!handlers) return;

    if (handler) {
      handlers.delete(handler);
    }

    if (!handler || handlers.size === 0) {
      this.subscriptions.delete(channel);
      await this.subscriber.unsubscribe(channel);
    }
  }

  async publishToGroup(groupId: string, message: string): Promise<number> {
    return this.publish(`group:${groupId}:channel`, message);
  }

  async subscribeToGroup(groupId: string, handler: MessageHandler): Promise<void> {
    return this.subscribe(`group:${groupId}:channel`, handler);
  }

  async unsubscribeFromGroup(groupId: string, handler?: MessageHandler): Promise<void> {
    return this.unsubscribe(`group:${groupId}:channel`, handler);
  }

  async publishToUser(userId: string, message: string): Promise<number> {
    return this.publish(`user:${userId}:channel`, message);
  }

  async subscribeToUser(userId: string, handler: MessageHandler): Promise<void> {
    return this.subscribe(`user:${userId}:channel`, handler);
  }

  async unsubscribeFromUser(userId: string, handler?: MessageHandler): Promise<void> {
    return this.unsubscribe(`user:${userId}:channel`, handler);
  }

  async onModuleDestroy() {
    if (this.publisher) await this.publisher.quit();
    if (this.subscriber) await this.subscriber.quit();
  }
}
