import { Module } from '@nestjs/common';
import { SocketService } from './socket.service';

/**
 * Provides the singleton SocketService without pulling in the gateways, so
 * domain modules (messages, reactions, channels, queues) can broadcast
 * without circular imports.
 */
@Module({
  providers: [SocketService],
  exports: [SocketService],
})
export class SocketCoreModule {}
