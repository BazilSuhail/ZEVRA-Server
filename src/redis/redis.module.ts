import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS = 'REDIS_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => {
        return new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        });
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
