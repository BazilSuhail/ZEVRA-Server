import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { DatabaseModule } from '../../database/database.module';
import { SocketCoreModule } from '../../socket/socket-core.module';

@Module({
  imports: [DatabaseModule, SocketCoreModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
