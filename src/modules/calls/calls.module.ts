import { Module } from '@nestjs/common';
import { CallsService } from './calls.service';
import { CallsGateway } from './calls.gateway';
import { CallsHistoryController } from './calls-history.controller';
import { DatabaseModule } from '../../database/database.module';
import { RedisModule } from '../../redis/redis.module';
import { SocketModule } from '../../socket/socket.module';
import { LivekitModule } from '../livekit/livekit.module';

@Module({
  imports: [DatabaseModule, RedisModule, SocketModule, LivekitModule],
  controllers: [CallsHistoryController],
  providers: [CallsService, CallsGateway],
  exports: [CallsService],
})
export class CallsModule {}
