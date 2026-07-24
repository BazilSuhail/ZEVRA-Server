import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { DatabaseModule } from '../../database/database.module';
import { CryptoModule } from '../../shared/crypto/crypto.module';
import { SocketCoreModule } from '../../socket/socket-core.module';
import { MESSAGE_DELIVERY_QUEUE } from '../../shared/queues/message-delivery.job';

@Module({
  imports: [
    DatabaseModule,
    CryptoModule,
    SocketCoreModule,
    BullModule.registerQueue({ name: MESSAGE_DELIVERY_QUEUE }),
  ],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
