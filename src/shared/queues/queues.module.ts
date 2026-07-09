import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { createClient } from 'redis';
import { KeyRotationProcessor } from './key-rotation.processor';
import { MessageDeliveryProcessor } from './message-delivery.processor';
import { ReadReceiptProcessor } from './read-receipt.processor';
import { DatabaseModule } from '../../database/database.module';
import { SocketModule } from '../../socket/socket.module';

const bullRedisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
bullRedisClient.connect();

@Module({
  imports: [
    BullModule.forRoot({
      connection: bullRedisClient,
      defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86400 },
        },
    }),
    BullModule.registerQueue(
      { name: 'key-rotation' },
      { name: 'message-delivery' },
      { name: 'read-receipt' },
    ),
    DatabaseModule,
    forwardRef(() => SocketModule),
  ],
  providers: [
    KeyRotationProcessor,
    MessageDeliveryProcessor,
    ReadReceiptProcessor,
  ],
  exports: [BullModule],
})
export class QueuesModule {}
