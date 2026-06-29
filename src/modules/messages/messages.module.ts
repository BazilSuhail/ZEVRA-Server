import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { DatabaseModule } from '../../database/database.module';
import { CryptoModule } from '../../shared/crypto/crypto.module';

@Module({
  imports: [DatabaseModule, CryptoModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
