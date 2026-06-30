import { Module, Global } from '@nestjs/common';
import { RateLimitService } from './rate-limit/rate-limit.service';
import { CircuitBreakerService } from './circuit-breaker/circuit-breaker.service';

@Global()
@Module({
  providers: [RateLimitService, CircuitBreakerService],
  exports: [RateLimitService, CircuitBreakerService],
})
export class SharedModule {}
