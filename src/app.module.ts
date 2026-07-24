import { ThrottlerModule } from '@nestjs/throttler';
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
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
import { AuditModule } from './modules/audit/audit.module';
import { ReactionsModule } from './modules/reactions/reactions.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { SocketModule } from './socket/socket.module';
import { ChatModule } from './chat/chat.module';
import { CallsModule } from './modules/calls/calls.module';
import { LivekitModule } from './modules/livekit/livekit.module';
import { HealthController } from './health.controller';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { RedisRateLimiter } from './common/rate-limit/redis-rate-limiter';
import { RedisThrottlerStorage } from './common/rate-limit/redis-throttler.storage';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { getAccessTokenTtl } from './common/config';

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    CommonModule,
    ThrottlerModule.forRootAsync({
      inject: [RedisRateLimiter],
      useFactory: (limiter: RedisRateLimiter) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: Number(process.env.API_RATE_LIMIT_PER_MIN) || 300 }],
        storage: new RedisThrottlerStorage(limiter),
      }),
    }),
    SharedModule,
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({
        secret: process.env.JWT_SECRET,
        signOptions: { expiresIn: getAccessTokenTtl(), algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    AuthModule,
    UsersModule,
    MessagesModule,
    ChannelsModule,
    KeysModule,
    QueuesModule,
    AuditModule,
    ReactionsModule,
    UploadsModule,
    SocketModule,
    ChatModule,
    CallsModule,
    LivekitModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('{*splat}');
  }
}
