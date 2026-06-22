import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from './audit.service';

@Controller('api/audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get('logs')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async getLogs(
    @Request() req: any,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const logs = await this.auditService.getLogs({
      userId: req.user.id,
      action,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });
    return { success: true, logs };
  }

  @Get('security')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async getSecurityEvents(@Request() req: any) {
    const events = await this.auditService.getSecurityEvents(req.user.id);
    return { success: true, events };
  }
}
