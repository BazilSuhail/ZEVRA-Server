import { Module, forwardRef } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { SocketModule } from '../socket/socket.module';
import { RedisModule } from '../redis/redis.module';
import { QueuesModule } from '../shared/queues/queues.module';
import { ReactionsModule } from '../modules/reactions/reactions.module';

@Module({
  imports: [
    RedisModule,
    QueuesModule,
    forwardRef(() => SocketModule),
    ReactionsModule,
  ],
  providers: [ChatService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}
