import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { DatabaseModule } from '../../database/database.module';
import { RedisSessionService } from '../../redis/redis-session.service';
import { RedisModule } from '../../redis/redis.module';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [UsersController],
  providers: [UsersService, RedisSessionService],
  exports: [UsersService],
})
export class UsersModule {}
