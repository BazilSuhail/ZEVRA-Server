import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { SocketAuthGuard } from '../socket/socket-auth.guard';
import { MessagesModule } from '../modules/messages/messages.module';
import { ReactionsModule } from '../modules/reactions/reactions.module';
import { ChannelsModule } from '../modules/channels/channels.module';

@Module({
  imports: [MessagesModule, ReactionsModule, ChannelsModule],
  providers: [ChatService, ChatGateway, SocketAuthGuard],
  exports: [ChatService],
})
export class ChatModule {}
