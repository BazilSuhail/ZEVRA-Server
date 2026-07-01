import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { SocketModule } from '../socket/socket.module';
import { RedisModule } from '../redis/redis.module';
import { MessagesModule } from '../modules/messages/messages.module';
import { ReactionsModule } from '../modules/reactions/reactions.module';

@Module({
  imports: [
    RedisModule,
    MessagesModule,
    BullModule.registerQueue(
      { name: 'message-delivery' },
      { name: 'read-receipt' },
    ),
    forwardRef(() => SocketModule),
    ReactionsModule,
  ],
  providers: [ChatService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}
