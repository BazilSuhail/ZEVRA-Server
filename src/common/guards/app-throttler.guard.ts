import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';

/**
 * Global HTTP throttler. Tracks authenticated callers by user id (token is
 * verified, not just decoded) and anonymous callers by IP. The counter is
 * shared across all routes so the limit is "N requests per minute per user",
 * not per endpoint. Non-HTTP contexts (Socket.IO) are rate limited separately.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== 'http';
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const header = req.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub?: string }>(header.slice(7));
        if (payload?.sub) return `user:${payload.sub}`;
      } catch {
        // Invalid/expired token: fall through to IP tracking.
      }
    }
    return `ip:${req.ip ?? 'unknown'}`;
  }

  protected generateKey(_context: ExecutionContext, suffix: string, name: string): string {
    return `${name}:${suffix}`;
  }
}
