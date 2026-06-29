import { Module, forwardRef } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { DatabaseModule } from '../database/database.module';
import { MessagesModule } from '../modules/messages/messages.module';
import { SocketModule } from '../socket/socket.module';
import { QueuesModule } from '../shared/queues/queues.module';

@Module({
  imports: [
    DatabaseModule,
    MessagesModule,
    forwardRef(() => SocketModule),
    QueuesModule,
  ],
  providers: [ChatService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}
