import { Module, Global, OnModuleInit } from '@nestjs/common';
import { createClient } from 'redis';
import { RedisService } from './redis.service';
import { RedisPubSubService } from './redis-pubsub.service';
import { RedisCacheService } from './redis-cache.service';
import { RedisSessionService } from './redis-session.service';

export const REDIS = 'REDIS_CONNECTION';

@Global()
@Module({
  providers: [
    RedisService,
    RedisPubSubService,
    RedisCacheService,
    RedisSessionService,
    {
      provide: REDIS,
      useFactory: async (redisService: RedisService) => {
        return redisService.connect();
      },
      inject: [RedisService],
    },
  ],
  exports: [REDIS, RedisService, RedisPubSubService, RedisCacheService, RedisSessionService],
})
export class RedisModule implements OnModuleInit {
  constructor(
    private redisService: RedisService,
    private cacheService: RedisCacheService,
    private sessionService: RedisSessionService,
    private pubSubService: RedisPubSubService,
  ) {}

  async onModuleInit() {
    const client = this.redisService.getClient();
    this.cacheService.setClient(client);
    this.sessionService.setClient(client);
    await this.pubSubService.connect();
  }
}
