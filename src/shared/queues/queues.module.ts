import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RedisClientType } from 'redis';
import { MessageDeliveryProcessor } from './message-delivery.processor';
import { MESSAGE_DELIVERY_QUEUE } from './message-delivery.job';
import { BULL_REDIS_CLIENT, BullRedisModule } from './bull-redis.provider';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [BullRedisModule],
      inject: [BULL_REDIS_CLIENT],
      useFactory: (client: RedisClientType) => ({
        connection: client,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86400 },
        },
      }),
    }),
    BullModule.registerQueue({ name: MESSAGE_DELIVERY_QUEUE }),
  ],
  providers: [MessageDeliveryProcessor],
  exports: [BullModule],
})
export class QueuesModule {}
