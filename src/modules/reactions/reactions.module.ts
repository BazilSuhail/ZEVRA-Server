import { Module } from '@nestjs/common';
import { ReactionsController } from './reactions.controller';
import { ReactionsService } from './reactions.service';
import { DatabaseModule } from '../../database/database.module';
import { SocketCoreModule } from '../../socket/socket-core.module';

@Module({
  imports: [DatabaseModule, SocketCoreModule],
  controllers: [ReactionsController],
  providers: [ReactionsService],
  exports: [ReactionsService],
})
export class ReactionsModule {}
