import { Module } from '@nestjs/common';
import { TypingService } from './typing.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [TypingService],
  exports: [TypingService],
})
export class TypingModule {}
