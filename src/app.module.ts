import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MulterModule } from '@nestjs/platform-express';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { SharedModule } from './shared/shared.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CommonModule } from './common/common.module';
import { MessagesModule } from './modules/messages/messages.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { KeysModule } from './modules/keys/keys.module';
import { QueuesModule } from './shared/queues/queues.module';
import { PresenceModule } from './shared/presence/presence.module';
import { AuditModule } from './modules/audit/audit.module';
import { ReactionsModule } from './modules/reactions/reactions.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { SocketModule } from './socket/socket.module';
import { ChatModule } from './chat/chat.module';
import { CallsModule } from './modules/calls/calls.module';
import { AppController } from './app.controller';
import { RequestIdMiddleware } from './common/request-id.middleware';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60000, limit: 1000000 },
      { name: 'auth', ttl: 60000, limit: 1000000 },
      { name: 'register', ttl: 300000, limit: 1000000 },
    ]),
    MulterModule.register({
      storage: undefined, // use memory storage (buffer)
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    }),
    DatabaseModule,
    RedisModule,
    SharedModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '10h' }, // originally 15m, increased for dev
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
    ReactionsModule,
    UploadsModule,
    SocketModule,
    ChatModule,
    CallsModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
