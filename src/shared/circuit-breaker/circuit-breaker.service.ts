import { Injectable, Logger } from '@nestjs/common';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;

  private readonly failureThreshold = 5;
  private readonly recoveryTimeMs = 30_000;

  async execute<T>(operation: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.state = CircuitState.HALF_OPEN;
        this.logger.log('Circuit breaker: HALF_OPEN — testing recovery');
      } else {
        return fallback();
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      return fallback();
    }
  }

  private onSuccess() {
    if (this.state === CircuitState.HALF_OPEN) {
      this.logger.log('Circuit breaker: CLOSED — recovered');
    }
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.logger.warn(
        `Circuit breaker: OPEN — too many failures (${this.failureCount}), retrying in ${this.recoveryTimeMs / 1000}s`,
      );
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset() {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
  }
}
