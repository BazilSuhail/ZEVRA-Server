import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { AuditService } from './audit.service';
import { AuditLogsQueryDto } from './dto/audit-query.dto';

@Controller('api/audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get('logs')
  async getLogs(@Request() req: { user: { id: string } }, @Query() query: AuditLogsQueryDto) {
    const logs = await this.auditService.getLogs({
      userId: req.user.id,
      action: query.action,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
      offset: query.offset,
    });
    return { success: true, logs };
  }

  @Get('security')
  async getSecurityEvents(@Request() req: { user: { id: string } }) {
    const events = await this.auditService.getSecurityEvents(req.user.id);
    return { success: true, events };
  }
}
