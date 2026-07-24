import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RedisCacheService } from './redis-cache.service';
import { RedisSessionService } from './redis-session.service';
import { ChannelMembersService } from './channel-members.service';

@Global()
@Module({
  providers: [RedisService, RedisCacheService, RedisSessionService, ChannelMembersService],
  exports: [RedisService, RedisCacheService, RedisSessionService, ChannelMembersService],
})
export class RedisModule {}
