import { Module, forwardRef } from '@nestjs/common';
import { SocketGateway } from './socket.gateway';
import { SocketService } from './socket.service';
import { SocketAuthGuard } from './socket-auth.guard';
import { DatabaseModule } from '../database/database.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [DatabaseModule, forwardRef(() => ChatModule)],
  providers: [SocketGateway, SocketService, SocketAuthGuard],
  exports: [SocketService, SocketGateway, SocketAuthGuard],
})
export class SocketModule {}
