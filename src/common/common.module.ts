import { Global, Module } from '@nestjs/common';
import { RedisRateLimiter } from './rate-limit/redis-rate-limiter';
import { RateLimitGuard } from './guards/rate-limit.guard';

@Global()
@Module({
  providers: [RedisRateLimiter, RateLimitGuard],
  exports: [RedisRateLimiter, RateLimitGuard],
})
export class CommonModule {}
