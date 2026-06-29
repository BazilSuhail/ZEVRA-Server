import { Module, forwardRef } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { DatabaseModule } from '../database/database.module';
import { MessagesModule } from '../modules/messages/messages.module';
import { SocketModule } from '../socket/socket.module';

@Module({
  imports: [
    DatabaseModule,
    MessagesModule,
    forwardRef(() => SocketModule),
  ],
  providers: [ChatService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}
