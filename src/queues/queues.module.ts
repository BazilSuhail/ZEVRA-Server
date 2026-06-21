import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessageProcessor } from './message.processor';
import { KeyRotationProcessor } from './key-rotation.processor';
import { ReadReceiptProcessor } from './read-receipt.processor';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      },
    }),
    BullModule.registerQueue(
      { name: 'messages' },
      { name: 'key-rotation' },
      { name: 'read-receipts' },
    ),
    DatabaseModule,
  ],
  providers: [MessageProcessor, KeyRotationProcessor, ReadReceiptProcessor],
  exports: [BullModule],
})
export class QueuesModule {}
