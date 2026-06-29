import { Module } from '@nestjs/common';
import { SocketGateway } from './socket.gateway';
import { SocketService } from './socket.service';
import { SocketAuthGuard } from './socket-auth.guard';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [SocketGateway, SocketService, SocketAuthGuard],
  exports: [SocketService, SocketGateway, SocketAuthGuard],
})
export class SocketModule {}
