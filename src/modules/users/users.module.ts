import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// DatabaseModule and RedisModule are global; RedisSessionService must come
// from RedisModule (it receives the connected client there).
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
