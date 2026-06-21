import { Module, Global } from '@nestjs/common';
import { createClient } from 'redis';

export const REDIS = 'REDIS_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: async () => {
        const url = process.env.REDIS_URL;
        if (!url) {
          console.warn('[Redis] REDIS_URL missing — Redis features disabled');
          return null;
        }

        const client = createClient({ url });

        client.on('error', () => {
          console.warn('[Redis] Connection error — Redis features disabled');
        });

        await client.connect();
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
