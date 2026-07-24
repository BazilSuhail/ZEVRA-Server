import { Controller, Get, Head, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB } from './database/database.module';
import { RedisService } from './redis/redis.service';

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    private readonly redisService: RedisService,
  ) {}

  @Get()
  @Head()
  @HttpCode(200)
  root() {
    return { status: 'ok' };
  }

  /** Liveness: the process is up and serving requests. */
  @Get('health')
  @Head('health')
  @HttpCode(200)
  health() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. 503 when any check fails. */
  @Get('health/ready')
  @Head('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    const ok = db && redis;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'error',
      db: db ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
    };
  }

  @Get('favicon.ico')
  @HttpCode(204)
  favicon() {}

  private async checkDb(): Promise<boolean> {
    try {
      await withTimeout(this.db.execute(sql`SELECT 1`), CHECK_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      return await withTimeout(this.redisService.ping(), CHECK_TIMEOUT_MS);
    } catch {
      return false;
    }
  }
}
