import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { createNodeRedisClient } from 'bullmq';
import { MessageProcessor } from './message.processor';
import { KeyRotationProcessor } from './key-rotation.processor';
import { ReadReceiptProcessor } from './read-receipt.processor';
import { DatabaseModule } from '../database/database.module';

const hasRedis = !!process.env.REDIS_URL;

@Module({
  imports: [
    ...(hasRedis
      ? [
          BullModule.forRootAsync({
            useFactory: () => ({
              connection: {
                url: process.env.REDIS_URL!,
                clientFactory: createNodeRedisClient,
              },
            }),
          }),
          BullModule.registerQueue(
            { name: 'messages' },
            { name: 'key-rotation' },
            { name: 'read-receipts' },
          ),
        ]
      : []),
    DatabaseModule,
  ],
  providers: [MessageProcessor, KeyRotationProcessor, ReadReceiptProcessor],
  exports: [...(hasRedis ? [BullModule] : [])],
})
export class QueuesModule {}
