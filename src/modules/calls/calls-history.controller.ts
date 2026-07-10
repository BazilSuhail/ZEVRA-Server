import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { CallsService } from './calls.service';

@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallsHistoryController {
  constructor(private callsService: CallsService) {}

  @Get('history')
  async getHistory(
    @Request() req: { user: { id: string } },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user.id;
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(50, Math.max(1, Number(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    const calls = await this.callsService.getCallHistory(userId, limitNum, offset);
    const hasMore = calls.length === limitNum;

    return {
      calls,
      page: pageNum,
      hasMore,
    };
  }

  @Get('history/:userId')
  async getHistoryWithUser(
    @Request() req: { user: { id: string } },
    @Param('userId') otherUserId: string,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user.id;
    const limitNum = Math.min(50, Math.max(1, Number(limit) || 20));

    const calls = await this.callsService.getCallHistoryWithUser(
      userId,
      otherUserId,
      limitNum,
    );

    return { calls };
  }
}
