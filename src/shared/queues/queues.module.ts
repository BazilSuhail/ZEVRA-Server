import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { createNodeRedisClient } from 'bullmq';
import { KeyRotationProcessor } from './key-rotation.processor';
import { MessageDeliveryProcessor } from './message-delivery.processor';
import { ReadReceiptProcessor } from './read-receipt.processor';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: {
          url: process.env.REDIS_URL || 'redis://localhost:6379',
          clientFactory: createNodeRedisClient,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          timeout: 30_000,
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86400 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: 'key-rotation' },
      { name: 'message-delivery' },
      { name: 'read-receipt' },
    ),
    DatabaseModule,
  ],
  providers: [
    KeyRotationProcessor,
    MessageDeliveryProcessor,
    ReadReceiptProcessor,
  ],
  exports: [BullModule],
})
export class QueuesModule {}
