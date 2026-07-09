import { Controller, Get } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DB } from './database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { RedisService } from './redis/redis.service';

@Controller()
export class AppController {
  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private redisService: RedisService,
  ) {}

  @Get('health/detail')
  async getHealth() {
    const checks: Record<string, string> = {};

    // Database check
    try {
      await this.db.execute(sql`SELECT 1`);
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    // Redis check
    try {
      const redisOk = await this.redisService.ping();
      checks.redis = redisOk ? 'ok' : 'error';
    } catch {
      checks.redis = 'error';
    }

    const allHealthy = Object.values(checks).every((v) => v === 'ok');

    const mem = process.memoryUsage();

    return {
      success: allHealthy,
      status: allHealthy ? 'healthy' : 'degraded',
      checks,
      memory: {
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
        heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
        rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
        external: `${(mem.external / 1024 / 1024).toFixed(1)} MB`,
        arrayBuffers: `${(mem.arrayBuffers / 1024 / 1024).toFixed(1)} MB`,
      },
      uptime: `${(process.uptime()).toFixed(0)}s`,
      timestamp: new Date().toISOString(),
    };
  }
}
