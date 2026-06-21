import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CommonModule } from './common/common.module';
import { MessagesModule } from './messages/messages.module';
import { ChannelsModule } from './channels/channels.module';
import { KeysModule } from './keys/keys.module';
import { QueuesModule } from './queues/queues.module';
import { PresenceModule } from './presence/presence.module';
import { TypingModule } from './typing/typing.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RedisModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
    }),
    AuthModule,
    UsersModule,
    CommonModule,
    MessagesModule,
    ChannelsModule,
    KeysModule,
    QueuesModule,
    PresenceModule,
    TypingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
