import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CommonModule } from './common/common.module';
import { MessagesModule } from './modules/messages/messages.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { KeysModule } from './modules/keys/keys.module';
import { QueuesModule } from './shared/queues/queues.module';
import { PresenceModule } from './shared/presence/presence.module';
import { AuditModule } from './modules/audit/audit.module';
import { SocketModule } from './socket/socket.module';
import { ChatModule } from './chat/chat.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60000, limit: 10000 },
      { name: 'auth', ttl: 60000, limit: 10000 },
      { name: 'register', ttl: 300000, limit: 10000 },
    ]),
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
    AuditModule,
    SocketModule,
    ChatModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
