import { Module } from '@nestjs/common';
import { SocketGateway } from './socket.gateway';
import { SocketAuthGuard } from './socket-auth.guard';
import { SocketCoreModule } from './socket-core.module';
import { DatabaseModule } from '../database/database.module';
import { ChatModule } from '../chat/chat.module';
import { ChannelsModule } from '../modules/channels/channels.module';

@Module({
  imports: [DatabaseModule, SocketCoreModule, ChatModule, ChannelsModule],
  providers: [SocketGateway, SocketAuthGuard],
  exports: [SocketCoreModule, SocketAuthGuard],
})
export class SocketModule {}
