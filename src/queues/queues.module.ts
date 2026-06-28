import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { createNodeRedisClient } from 'bullmq';
import { KeyRotationProcessor } from './key-rotation.processor';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: {
          url: process.env.REDIS_URL || 'redis://localhost:6379',
          clientFactory: createNodeRedisClient,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: 'key-rotation' },
    ),
    DatabaseModule,
  ],
  providers: [KeyRotationProcessor],
  exports: [BullModule],
})
export class QueuesModule {}
