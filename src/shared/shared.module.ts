import { Module, Global } from '@nestjs/common';
import { RateLimitService } from './rate-limit/rate-limit.service';

@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class SharedModule {}
